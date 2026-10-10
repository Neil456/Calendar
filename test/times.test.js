const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 10, 18, 0); // Sat Oct 10 2026, 2pm New York

function action(fields) {
  return Object.assign({
    action: 'create', event_id: '', kind: 'interview', company: 'Stripe', title: 'Phone Screen',
    start_local: '2026-10-14T14:00', end_local: '', timezone: 'America/Los_Angeles',
    timezone_stated: true, deadline_in_hours: 0, location: '', notes: '', reason: 'test',
  }, fields);
}

function email(fields) {
  return Object.assign({
    id: 'm1', from: 'Recruiting <recruiting@stripe.com>', subject: 'Interview confirmed',
    body: 'See the attached invite.', date: NOW - HOUR,
  }, fields);
}

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'METHOD:REQUEST'].concat(lines, ['END:VCALENDAR']).join('\r\n');
}

// An Outlook-style message whose invite is only a base64 text/calendar part, not an attachment.
function outlookRaw(calendar) {
  const b64 = Buffer.from(calendar).toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    'From: recruiting@acme.com',
    'Subject: Interview',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Please join us.',
    '--b1',
    'Content-Type: text/calendar; charset="utf-8"; method=REQUEST',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--b1--',
    '',
  ].join('\r\n');
}

function syncOne(env, msg, plan) {
  env.addThread(email(msg));
  env.reply(plan);
  env.sync();
  return env.eventList();
}

test('an interview uses the time and zone from its calendar invite', () => {
  const env = createEnv({ now: NOW });
  const invite = ics([
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/Los_Angeles:20261014T140000',
    'DTEND;TZID=America/Los_Angeles:20261014T144500',
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'END:VALARM',
    'END:VEVENT',
  ]);
  // Claude misreads the time; the invite wins.
  const [ev] = syncOne(env, { attachments: [{ name: 'invite.ics', type: 'application/ics', data: invite }] },
    { actions: [action({ start_local: '2026-10-14T15:00', timezone: 'America/New_York' })] });

  assert.deepEqual(ev._raw.start, { dateTime: '2026-10-14T14:00:00', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(ev._raw.end, { dateTime: '2026-10-14T14:45:00', timeZone: 'America/Los_Angeles' });
  assert.equal(ev.start.dateTime, '2026-10-14T21:00:00.000Z');
  assert.equal(ev.summary, 'Stripe: Phone Screen');
  assert.match(ev.description, /Time from: calendar invite, America\/Los_Angeles/);
  assert.match(env.lastPrompt(), /\[Calendar invite\]\nBEGIN:VCALENDAR/);
  assert.doesNotMatch(env.lastPrompt(), /VALARM|TRIGGER/); // alarms only cost tokens
});

test('reads Outlook invites from the raw message, with Windows zone names', () => {
  const env = createEnv({ now: NOW });
  const invite = ics([
    'BEGIN:VTIMEZONE', 'TZID:Pacific Standard Time', 'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'SUMMARY:Acme interview',
    'DTSTART;TZID="Pacific Standard Time":20261102T140000', // the day after daylight saving ends
    'DURATION:PT30M',
    'END:VEVENT',
  ]);
  const [ev] = syncOne(env, { raw: outlookRaw(invite) },
    { actions: [action({ company: 'Acme', start_local: '2026-11-02T14:00', timezone: '', timezone_stated: false })] });

  assert.deepEqual(ev._raw.start, { dateTime: '2026-11-02T14:00:00', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(ev._raw.end, { dateTime: '2026-11-02T14:30:00', timeZone: 'America/Los_Angeles' });
  assert.equal(ev.start.dateTime, '2026-11-02T22:00:00.000Z'); // PST, UTC-8
  assert.equal(ev.summary, 'Acme: Phone Screen'); // exact time, so no ⚠️
  assert.match(env.lastPrompt(), /DTSTART;TZID="Pacific Standard Time":20261102T140000/);
  assert.doesNotMatch(env.lastPrompt(), /VTIMEZONE/);
});

test('reads quoted-printable invites and UTC times', () => {
  const env = createEnv({ now: NOW });
  const raw = [
    'Content-Type: multipart/mixed; boundary=xyz',
    '',
    '--xyz',
    'Content-Type: text/plain',
    '',
    'Hi',
    '--xyz',
    'Content-Type: application/octet-stream; name="invite.ics"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Caf=C3=A9 chat\r\nDTSTART:20261015T=\r\n160000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
    '--xyz--',
  ].join('\r\n');
  const [ev] = syncOne(env, { raw }, { actions: [action({ start_local: '2026-10-15T12:00', timezone: 'America/New_York' })] });
  assert.deepEqual(ev._raw.start, { dateTime: '2026-10-15T16:00:00', timeZone: 'UTC' });
  assert.equal(ev.start.dateTime, '2026-10-15T16:00:00.000Z');
  assert.match(env.lastPrompt(), /SUMMARY:Café chat/);
});

test('falls back to the email text when an invite has no usable time', () => {
  const env = createEnv({ now: NOW });
  const floating = ics(['BEGIN:VEVENT', 'DTSTART:20261014T090000', 'END:VEVENT']);
  const unknownZone = ics(['BEGIN:VEVENT', 'DTSTART;TZID=Somewhere Odd:20261014T090000', 'END:VEVENT']);
  const allDay = ics(['BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261014', 'END:VEVENT']);
  const [ev] = syncOne(env, {
    attachments: [floating, unknownZone, allDay].map((data, i) => ({ name: `${i}.ics`, type: 'text/calendar', data })),
  }, { actions: [action({})] });
  assert.deepEqual(ev._raw.start, { dateTime: '2026-10-14T14:00:00', timeZone: 'America/Los_Angeles' });
  assert.match(ev.description, /Time from: email text, America\/Los_Angeles/);
});

test('two copies of the same invite count as one', () => {
  const env = createEnv({ now: NOW });
  const google = ics(['BEGIN:VEVENT', 'DTSTART;TZID=America/Los_Angeles:20261014T140000', 'SEQUENCE:0', 'END:VEVENT']);
  const sameTimeInUtc = ics(['BEGIN:VEVENT', 'DTSTART:20261014T210000Z', 'END:VEVENT']);
  const [ev] = syncOne(env, {
    attachments: [{ name: 'invite.ics', type: 'application/ics', data: google }],
    raw: outlookRaw(sameTimeInUtc),
  }, { actions: [action({ start_local: '2026-10-14T17:00', timezone: 'America/New_York' })] });
  assert.match(ev.description, /Time from: calendar invite, America\/Los_Angeles/);
  assert.equal(ev.start.dateTime, '2026-10-14T21:00:00.000Z');
});

test('ignores cancelled invites and picks the matching one of several', () => {
  const env = createEnv({ now: NOW });
  const cancelled = ['BEGIN:VCALENDAR', 'METHOD:CANCEL', 'BEGIN:VEVENT', 'DTSTART;TZID=America/Chicago:20261014T090000', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  const twoRounds = ics([
    'BEGIN:VEVENT', 'DTSTART;TZID=America/Chicago:20261020T100000', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;TZID=America/Chicago:20261021T130000', 'DTEND;TZID=America/Chicago:20261021T140000', 'END:VEVENT',
  ]);
  const events = syncOne(env, {
    attachments: [{ name: 'old.ics', type: 'text/calendar', data: cancelled }, { name: 'new.ics', type: 'text/calendar', data: twoRounds }],
  }, { actions: [
    action({ title: 'Round 1', start_local: '2026-10-20T10:00', timezone: 'America/Chicago' }),
    // Claude got the minutes wrong; still the only invite that day.
    action({ title: 'Round 2', start_local: '2026-10-21T13:30', timezone: 'America/Chicago' }),
  ] });
  assert.deepEqual(events.map((e) => [e.summary, e.start.dateTime, e.end.dateTime]), [
    ['Stripe: Round 1', '2026-10-20T15:00:00.000Z', '2026-10-20T16:00:00.000Z'],
    ['Stripe: Round 2', '2026-10-21T18:00:00.000Z', '2026-10-21T19:00:00.000Z'],
  ]);
});

test('relative OA deadlines are counted from when the email arrived', () => {
  const env = createEnv({ now: NOW });
  const received = Date.UTC(2026, 9, 10, 16, 37, 30); // 12:37:30 New York
  const [ev] = syncOne(env, { date: received, body: 'You have 72 hours to complete the assessment.' },
    { actions: [action({ kind: 'oa_deadline', company: 'Jane Street', start_local: '', timezone: '', timezone_stated: false, deadline_in_hours: 72 })] });
  assert.equal(ev.summary, 'OA due: Jane Street'); // exact, so no ⚠️
  assert.deepEqual(ev._raw.start, { dateTime: '2026-10-13T12:37:00', timeZone: 'America/New_York' });
  assert.deepEqual(ev._raw.start, ev._raw.end);
  assert.match(ev.description, /Time from: 72 hours after the email arrived/);
});

test('the prompt lists dates and weekdays from the day the email arrived', () => {
  const env = createEnv({ now: NOW });
  syncOne(env, {}, { actions: [] });
  assert.match(env.lastPrompt(), /\nDates from the day the email arrived: Sat 2026-10-10, Sun 2026-10-11, Mon 2026-10-12, .*, Fri 2026-10-30\n/);
});

test('times in fixed-offset zones and across daylight saving', () => {
  const env = createEnv({ now: NOW });
  const events = syncOne(env, {}, { actions: [
    action({ company: 'A', start_local: '2026-10-14T19:30', timezone: '+05:30' }),
    action({ company: 'B', start_local: '2026-10-23T09:00', timezone: 'Europe/London' }), // BST, until Oct 25
    action({ company: 'C', start_local: '2026-11-02T09:00', timezone: 'Europe/London' }), // GMT
    action({ company: 'D', start_local: '2026-11-02T09:00', timezone: 'Asia/Kolkata' }),
  ] });
  assert.deepEqual(events.map((e) => [e.summary, e.start.dateTime]), [
    ['A: Phone Screen', '2026-10-14T14:00:00.000Z'],
    ['B: Phone Screen', '2026-10-23T08:00:00.000Z'],
    ['C: Phone Screen', '2026-11-02T09:00:00.000Z'],
    ['D: Phone Screen', '2026-11-02T03:30:00.000Z'],
  ]);
  assert.deepEqual(events[0]._raw.start, { dateTime: '2026-10-14T19:30:00+05:30' });
});
