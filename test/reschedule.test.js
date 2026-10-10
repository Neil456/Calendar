const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 10, 18, 0); // Sat Oct 10 2026, 2pm New York

function action(fields) {
  return Object.assign({
    action: 'create', event_id: '', kind: 'interview', company: 'Stripe', title: 'Phone Screen',
    start_local: '2026-10-14T14:00', end_local: '', timezone: 'America/Los_Angeles',
    timezone_stated: true, deadline_in_hours: 0, location: '', notes: '', reason: 'test',
  }, fields);
}

function invite(start, { uid = 'abc123@google.com', sequence = 0, method = 'REQUEST', end } = {}) {
  return {
    name: 'invite.ics',
    type: 'application/ics',
    data: [
      'BEGIN:VCALENDAR', `METHOD:${method}`, 'BEGIN:VEVENT', `UID:${uid}`, `SEQUENCE:${sequence}`,
      `DTSTART;TZID=America/Los_Angeles:${start}`,
      end ? `DTEND;TZID=America/Los_Angeles:${end}` : null,
      'END:VEVENT', 'END:VCALENDAR',
    ].filter(Boolean).join('\r\n'),
  };
}

function email(id, fields) {
  return Object.assign({
    id, from: 'Stripe Recruiting <recruiting@stripe.com>', subject: `Email ${id}`,
    body: 'Details in the invite.', date: NOW - HOUR,
  }, fields);
}

/** Processes one email with the given model answer, an hour after the previous one. */
function receive(env, msg, plan) {
  env.addThread(msg);
  env.reply(plan);
  env.sync();
  env.clock.now += HOUR;
}

function created(env) {
  receive(env, email('m1', { attachments: [invite('20261014T140000', { end: '20261014T144500' })] }), { actions: [action({})] });
  assert.equal(env.eventList().length, 1);
  return env.eventList()[0];
}

test('the first sync only adds what is still coming up', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email('old', { date: NOW - 12 * DAY, body: 'Your interview is on Sep 30 at 2pm PT.' }));
  env.addThread(email('soon', { date: NOW - 10 * DAY, body: 'Your onsite is on Oct 20 at 10am PT.' }));
  env.reply({ actions: [action({ start_local: '2026-09-30T14:00' })] }); // already happened
  env.reply({ actions: [action({ title: 'Onsite', start_local: '2026-10-20T10:00' })] });
  env.sync();

  assert.match(env.queries[0], /^newer_than:14d /);
  assert.deepEqual(env.eventList().map((e) => e.summary), ['Stripe: Onsite']);
  assert.ok(env.logs.some((l) => /Skipped Stripe: .* has already passed/.test(l)));
});

test('an updated invite moves the event even if the model says nothing', () => {
  const env = createEnv({ now: NOW });
  const original = created(env);
  assert.equal(original.extendedProperties.private.inviteUid, 'abc123@google.com');

  receive(env, email('m2', { subject: 'Updated invitation', attachments: [invite('20261015T110000', { sequence: 1, end: '20261015T114500' })] }),
    { actions: [] });

  const [ev] = env.eventList();
  assert.equal(ev.id, original.id);
  assert.equal(ev.start.dateTime, '2026-10-15T18:00:00.000Z');
  assert.equal(ev.end.dateTime, '2026-10-15T18:45:00.000Z');
  assert.equal(ev.extendedProperties.private.inviteSequence, '1');
  assert.equal(ev.extendedProperties.private.company, 'Stripe');
  assert.ok(env.logs.some((l) => /Moved "Stripe: Phone Screen" to Thu 2026-10-15 14:00 America\/New_York: its calendar invite was updated/.test(l)));
});

test('an updated invite the model calls "new" still updates the existing event', () => {
  const env = createEnv({ now: NOW });
  const original = created(env);
  receive(env, email('m2', { attachments: [invite('20261016T090000', { sequence: 2 })] }),
    { actions: [action({ start_local: '2026-10-16T09:00' })] });

  const events = env.eventList();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, original.id);
  assert.equal(events[0].start.dateTime, '2026-10-16T16:00:00.000Z');
});

test('a cancelled invite removes the event even if the model says nothing', () => {
  const env = createEnv({ now: NOW });
  created(env);
  receive(env, email('m2', { subject: 'Canceled event', attachments: [invite('20261014T140000', { sequence: 1, method: 'CANCEL' })] }),
    { actions: [] });
  assert.equal(env.eventList().length, 0);
  assert.ok(env.logs.some((l) => /Removed "Stripe: Phone Screen": its calendar invite was cancelled/.test(l)));
});

test('an older copy of an invite does not undo a reschedule', () => {
  const env = createEnv({ now: NOW });
  created(env);
  receive(env, email('m2', { attachments: [invite('20261015T110000', { sequence: 3 })] }), { actions: [] });
  receive(env, email('m3', { attachments: [invite('20261014T140000', { sequence: 1 })] }), { actions: [] });
  assert.equal(env.eventList()[0].start.dateTime, '2026-10-15T18:00:00.000Z');
});

test('an event added from email text is linked to a matching invite, so later changes follow it', () => {
  const env = createEnv({ now: NOW });
  receive(env, email('m1', { body: 'Phone screen Wednesday Oct 14 at 2pm PT.' }), { actions: [action({})] });
  // The invite arrives separately; the model sees a duplicate and does nothing.
  receive(env, email('m2', { attachments: [invite('20261014T140000')] }), { actions: [] });
  assert.equal(env.eventList()[0].extendedProperties.private.inviteUid, 'abc123@google.com');

  receive(env, email('m3', { attachments: [invite('20261014T160000', { sequence: 1 })] }), { actions: [] });
  const events = env.eventList();
  assert.equal(events.length, 1);
  assert.equal(events[0].start.dateTime, '2026-10-14T23:00:00.000Z');
});

test('a reschedule in the email text moves the existing event', () => {
  const env = createEnv({ now: NOW });
  const original = created(env);
  receive(env, email('m2', { body: 'We need to move your Stripe phone screen to Friday Oct 16 at 10am PT.' }),
    { actions: [action({ action: 'update', event_id: original.id, start_local: '2026-10-16T10:00' })] });
  const events = env.eventList();
  assert.equal(events.length, 1);
  assert.equal(events[0].start.dateTime, '2026-10-16T17:00:00.000Z');
});

test('the same interview under a slightly different company name is not added twice', () => {
  const env = createEnv({ now: NOW });
  receive(env, email('m1', {}), { actions: [action({})] });
  receive(env, email('m2', {}), { actions: [action({ company: 'Stripe, Inc.' })] });
  assert.equal(env.eventList().length, 1);
});
