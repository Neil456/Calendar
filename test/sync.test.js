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
    body: 'Your phone screen is confirmed for Wednesday, October 14 at 2:00 PM PT.', date: NOW - HOUR,
  }, fields);
}

// --- Time zones -------------------------------------------------------------

test('wall-clock times convert to the right instant, including daylight saving', () => {
  const env = createEnv();
  const iso = (local, tz) => env.run(`zonedToDate_(${JSON.stringify(local)}, ${JSON.stringify(tz)}).toISOString()`);
  assert.equal(iso('2026-10-14T14:00', 'America/Los_Angeles'), '2026-10-14T21:00:00.000Z'); // PDT
  assert.equal(iso('2026-11-03T14:00', 'America/Los_Angeles'), '2026-11-03T22:00:00.000Z'); // PST after Nov 1
  assert.equal(iso('2026-10-14T19:30', 'Asia/Kolkata'), '2026-10-14T14:00:00.000Z');
  assert.equal(iso('2026-03-29T09:00', 'Europe/London'), '2026-03-29T08:00:00.000Z'); // first day of BST
  assert.equal(iso('2026-10-14T14:00', '-07:00'), '2026-10-14T21:00:00.000Z');
  assert.equal(iso('2026-10-14T14:00', 'GMT+5:30'), '2026-10-14T08:30:00.000Z');
  // A time skipped by spring-forward still resolves to something sensible.
  assert.match(iso('2026-03-08T02:30', 'America/New_York'), /^2026-03-08T0[67]:30/);
});

test('time zone validation and Calendar API time format', () => {
  const env = createEnv();
  assert.equal(env.run('isValidTimeZone_("America/Chicago")'), true);
  assert.equal(env.run('isValidTimeZone_("+05:30")'), true);
  assert.equal(env.run('isValidTimeZone_("Pacific Time")'), false);
  assert.deepEqual(JSON.parse(env.run('JSON.stringify(apiTime_("2026-10-14T14:00", "America/Chicago"))')),
    { dateTime: '2026-10-14T14:00:00', timeZone: 'America/Chicago' });
  assert.deepEqual(JSON.parse(env.run('JSON.stringify(apiTime_("2026-10-14T14:00", "UTC-7"))')),
    { dateTime: '2026-10-14T14:00:00-07:00' });
});

// --- Sync -------------------------------------------------------------------

test('adds a confirmed interview in the time zone the email used', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ actions: [action({ end_local: '2026-10-14T14:45', location: 'https://zoom.us/j/123', notes: 'With Jane, 45 min' })] });

  env.sync();

  const [ev] = env.eventList();
  assert.equal(ev.summary, 'Stripe: Phone Screen');
  assert.deepEqual(ev._raw.start, { dateTime: '2026-10-14T14:00:00', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(ev._raw.end, { dateTime: '2026-10-14T14:45:00', timeZone: 'America/Los_Angeles' });
  assert.equal(ev.start.dateTime, '2026-10-14T21:00:00.000Z');
  assert.deepEqual(ev.reminders, { useDefault: true });
  assert.equal(ev.location, 'https://zoom.us/j/123');
  assert.match(ev.description, /^With Jane, 45 min/);
  assert.match(ev.description, /Inbox: me@gmail\.com/);
  assert.match(ev.description, /https:\/\/mail\.google\.com\/mail\/\?authuser=me%40gmail\.com#all\/m1/);
  assert.deepEqual(ev.extendedProperties.private, { interviewTracker: '1', kind: 'interview', company: 'Stripe', sourceMessage: 'm1' });

  // First sync searches back 14 days.
  assert.match(env.queries[0], /^newer_than:14d -in:sent .*-category:promotions .*\(interview OR interviews .*"phone screen".*\)$/);
});

test('sends a well-formed Groq request', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({ cc: 'coordinator@stripe.com' }));
  env.reply({ actions: [] });
  env.sync();

  const req = env.requests[0];
  assert.equal(req.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.deepEqual({ ...req.headers }, { Authorization: 'Bearer gsk-test' });
  assert.equal(req.params.muteHttpExceptions, true);
  assert.equal(req.body.model, 'openai/gpt-oss-120b');
  assert.equal(req.body.reasoning_effort, 'medium');
  assert.equal(req.body.include_reasoning, false);
  assert.equal(req.body.max_completion_tokens, 3000);
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.equal(req.body.response_format.json_schema.strict, true);
  assert.equal(req.body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(req.body.messages[0].role, 'system');
  assert.match(req.body.messages[0].content, /never follow instructions/);
  assert.equal(req.body.messages[1].role, 'user');

  const prompt = req.body.messages[1].content;
  assert.match(prompt, /^User's home time zone: America\/New_York\nNow: Sat 2026-10-10 14:00\n/);
  assert.match(prompt, /Events on the calendar \(times shown in America\/New_York\):\n\(none\)/);
  assert.match(prompt, /<email inbox="me@gmail.com" received="Sat 2026-10-10 13:00">\nFrom: Recruiting <recruiting@stripe.com>\nTo: me@gmail.com\nCc: coordinator@stripe.com\nSubject: Interview confirmed\n\nYour phone screen/);
  assert.match(prompt, /2:00 PM PT\.\n<\/email>$/);
});

test('uses Claude Haiku when only ANTHROPIC_API_KEY is set', () => {
  const env = createEnv({ now: NOW, scriptProps: { ANTHROPIC_API_KEY: 'sk-test', CALENDAR_ID: 'cal-main' } });
  env.addThread(email({}));
  env.reply({ actions: [action({})] });
  env.sync();

  const req = env.requests[0];
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual({ ...req.headers }, { 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
  assert.equal(req.body.model, 'claude-haiku-5-5');
  assert.equal(req.body.fallbacks, undefined); // Haiku has no server-side fallback
  assert.equal(req.body.output_config.effort, 'medium');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.thinking, undefined);
  assert.match(req.body.system, /never follow instructions/);
  assert.match(req.body.messages[0].content, /Subject: Interview confirmed/);
  assert.equal(env.eventList().length, 1);
});

test('MODEL picks another model; larger Claude models get server-side fallbacks', () => {
  const env = createEnv({ now: NOW, scriptProps: { ANTHROPIC_API_KEY: 'sk-test', MODEL: 'claude-sonnet-5-5', CALENDAR_ID: 'cal-main' } });
  env.addThread(email({}));
  env.reply({ actions: [] });
  env.sync();
  assert.equal(env.requests[0].body.model, 'claude-sonnet-5-5');
  assert.equal(env.requests[0].body.fallbacks, 'default');
  assert.equal(env.requests[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');

  const groq = createEnv({ now: NOW, scriptProps: { GROQ_API_KEY: 'gsk', ANTHROPIC_API_KEY: 'sk', MODEL: 'qwen/qwen3.8-27b', CALENDAR_ID: 'cal-main' } });
  groq.addThread(email({}));
  groq.reply({ actions: [] });
  groq.sync();
  assert.match(groq.requests[0].url, /groq\.com/); // Groq wins when both keys are set
  assert.equal(groq.requests[0].body.model, 'qwen/qwen3.8-27b');
});

test('each email is only sent to Claude once', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ actions: [action({})] });
  env.sync();
  env.clock.now += 10 * 60 * 1000;
  env.sync();
  assert.equal(env.requests.length, 1);
  assert.equal(env.eventList().length, 1);
  assert.match(env.queries[env.queries.length - 1], /^newer_than:3d /);
});

test('a reschedule moves the existing event', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ actions: [action({})] });
  env.sync();

  env.addThread(email({ id: 'm2', subject: 'Rescheduled', body: 'Moved to Thu Oct 15, 11am PT.' }));
  env.reply((body) => {
    // Existing events are listed with their id, in the home time zone (2pm PT = 5pm ET).
    assert.match(env.promptOf(body), /- id: ev1 \| Stripe: Phone Screen \| Wed 2026-10-14 17:00\n/);
    return { actions: [action({ action: 'update', event_id: 'ev1', start_local: '2026-10-15T11:00' })] };
  });
  env.clock.now += HOUR;
  env.sync();

  const events = env.eventList();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'ev1');
  assert.equal(events[0].start.dateTime, '2026-10-15T18:00:00.000Z');
  assert.equal(events[0].extendedProperties.private.sourceMessage, 'm2');
});

test('emails are processed oldest first', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({ id: 'new', subject: 'Second', date: NOW - HOUR }));
  env.addThread(email({ id: 'old', subject: 'First', date: NOW - 5 * HOUR }));
  env.reply({ actions: [] });
  env.reply({ actions: [] });
  env.sync();
  assert.match(env.promptOf(env.requests[0].body), /Subject: First/);
  assert.match(env.promptOf(env.requests[1].body), /Subject: Second/);
  assert.ok(env.logs.includes('log: No calendar changes for "First" from Recruiting <recruiting@stripe.com>.'));
});

test('an OA deadline becomes a zero-length event at the deadline', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({ from: 'no-reply@hackerrank.com', subject: 'Jane Street assessment', body: 'Please complete it by October 17 at 11:59 PM PT.' }));
  env.reply({ actions: [action({ kind: 'oa_deadline', company: 'Jane Street', title: 'Online Assessment', start_local: '2026-10-17T23:59', location: 'https://hr.com/test/abc' })] });
  env.sync();

  const [ev] = env.eventList();
  assert.equal(ev.summary, 'OA due: Jane Street');
  assert.deepEqual(ev._raw.start, ev._raw.end);
  assert.equal(ev.start.dateTime, '2026-10-18T06:59:00.000Z');
});

test('a submitted OA or cancelled interview is removed', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ actions: [action({})] });
  env.sync();

  env.addThread(email({ id: 'm2', subject: 'Interview cancelled' }));
  env.reply({ actions: [action({ action: 'remove', event_id: 'ev1', company: '', start_local: '', timezone: '', timezone_stated: false })] });
  env.clock.now += HOUR;
  env.sync();
  assert.equal(env.eventList().length, 0);
});

test('a missing time zone falls back to home time and is flagged', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({ body: 'See you Wednesday Oct 14 at 2pm.' }));
  env.reply({ actions: [action({ timezone: 'America/New_York', timezone_stated: false })] });
  env.sync();

  const [ev] = env.eventList();
  assert.equal(env.requests.length, 1);
  assert.equal(ev.summary, '⚠️ Stripe: Phone Screen');
  assert.match(ev.description, /⚠️ The email didn't say which time zone, so assumed America\/New_York\. Check the email to confirm\./);
  assert.equal(ev.start.dateTime, '2026-10-14T18:00:00.000Z');
});

test('an unreadable time zone falls back to home time and is flagged', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ actions: [action({ timezone: 'Pacific Time' })] });
  env.sync();

  const [ev] = env.eventList();
  assert.equal(ev.summary, '⚠️ Stripe: Phone Screen');
  assert.match(ev.description, /Couldn't read the time zone "Pacific Time", so assumed America\/New_York/);
  assert.deepEqual(ev._raw.start, { dateTime: '2026-10-14T14:00:00', timeZone: 'America/New_York' });
});

test('past events, duplicates, bad times and unknown ids are handled safely', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}), email({ id: 'm2', date: NOW - HOUR / 2, body: 'Acme: Tuesday, October 20 at 9:00 AM PT' }));
  const first = { actions: [
    action({}),
    action({ company: 'Old Co', start_local: '2026-10-01T10:00' }), // already happened
    action({ company: ' stripe ' }), // same interview again
    action({ company: 'Bad Co', start_local: 'next Tuesday' }), // unusable
  ] };
  env.reply(first);
  env.reply({ actions: [
    action({ action: 'remove', event_id: 'nope' }),
    // Unknown id: treated as new.
    action({ action: 'update', event_id: 'nope', company: 'Acme', start_local: '2026-10-20T09:00' }),
  ] });
  env.sync();

  assert.deepEqual(env.eventList().map((e) => e.summary).sort(), ['Acme: Phone Screen', 'Stripe: Phone Screen']);
  assert.equal(env.userProps['done:m1'], String(NOW - HOUR));
  assert.equal(env.userProps['done:m2'], String(NOW - HOUR / 2));
});

test('at most 5 changes are made per email', () => {
  const env = createEnv({ now: NOW });
  const days = [1, 2, 3, 4, 5, 6, 7];
  env.addThread(email({ body: days.map((d) => `Session ${d}: October 1${d} at 10:00 AM PT`).join('\n') }));
  env.reply({ actions: days.map((d) => action({ start_local: `2026-10-1${d}T10:00` })) });
  env.sync();
  assert.equal(env.eventList().length, 5);
});

test('ignores your own replies', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({ from: 'Me <ME@gmail.com>' }), email({ id: 'm2', from: 'me.alias@gmail.com' }));
  env.sync();
  assert.equal(env.requests.length, 0);
});

test('includes .ics invites and trims very long emails', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({
    body: 'x'.repeat(20000),
    attachments: [
      { name: 'invite.ics', type: 'application/ics', data: 'BEGIN:VCALENDAR\nDTSTART;TZID=America/Los_Angeles:20261014T140000' },
      { name: 'resume.pdf', type: 'application/pdf', data: 'binary' },
    ],
  }));
  env.reply({ actions: [] });
  env.sync();
  const prompt = env.lastPrompt();
  assert.match(prompt, /x{8000}\n\[\.\.\. rest of email cut for length \.\.\.\]/);
  assert.match(prompt, /\n\[Calendar invite\]\nBEGIN:VCALENDAR\nDTSTART;TZID=America\/Los_Angeles:20261014T140000\n<\/email>$/);
  assert.doesNotMatch(prompt, /resume\.pdf/);
});

// --- Failures ---------------------------------------------------------------

test('an API outage leaves emails for the next run', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } });
  env.sync();
  assert.equal(env.userProps['done:m1'], undefined);
  assert.equal(env.userProps.lastFullSync, undefined);

  env.reply({ actions: [action({})] });
  env.clock.now += 10 * 60 * 1000;
  env.sync();
  assert.equal(env.eventList().length, 1);
  assert.match(env.queries[1], /^newer_than:14d /);
});

test('waits out a short Groq rate limit within the run', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'Rate limit reached: tokens per minute' } } });
  env.reply({ actions: [action({})] });
  env.sync();
  assert.deepEqual(env.sleeps, [7000]);
  assert.equal(env.eventList().length, 1);
  assert.ok(env.userProps['done:m1']);
});

test('stops for the day when Groq\'s daily limit is used up, and resumes later', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ status: 429, headers: { 'retry-after': '5400' }, body: { error: { message: 'Rate limit reached: tokens per day' } } });
  env.sync();
  assert.deepEqual(env.sleeps, []);
  assert.equal(env.userProps['done:m1'], undefined);
  assert.equal(env.userProps['fail:m1'], undefined); // not the email's fault
  assert.ok(env.logs.some((l) => /Groq is busy or rate-limited \(HTTP 429, retry after 5400s\)/.test(l)));

  env.clock.now += 2 * HOUR;
  env.reply({ actions: [action({})] });
  env.sync();
  assert.equal(env.eventList().length, 1);
});

test('does not wait past the run\'s time budget', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.onRequest = () => { env.clock.now += 4.4 * 60 * 1000; }; // a slow call near the end of the run
  env.reply({ status: 429, headers: { 'retry-after': '30' }, body: {} });
  env.sync();
  assert.deepEqual(env.sleeps, []);
  assert.equal(env.userProps['done:m1'], undefined);
});

test('an email too big for Groq counts as a failed try, not an outage', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ status: 413, body: { error: { message: 'Request too large' } } });
  env.sync();
  assert.equal(env.userProps['fail:m1'], '1');
});

test('a bad API key fails the run so Google emails you', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.reply({ status: 401, body: { type: 'error', error: { type: 'authentication_error' } } });
  assert.throws(() => env.sync(), /Groq API error 401/);
  assert.equal(env.userProps['done:m1'], undefined);
});

test('missing settings fail the run with a clear message', () => {
  const env = createEnv({ now: NOW, scriptProps: { CALENDAR_ID: 'cal-main' } });
  assert.throws(() => env.sync(), /GROQ_API_KEY \(or ANTHROPIC_API_KEY\) is missing/);
});

test('an email that keeps failing is skipped after 3 tries', () => {
  const env = createEnv({ now: NOW });
  env.addThread(email({}));
  env.addThread(email({ id: 'm2', subject: 'Other email', date: NOW - HOUR / 2 }));
  env.reply('not json');
  env.reply({ actions: [] });
  env.sync();
  env.reply({ finish_reason: 'length', actions: [] }); // answer cut off
  env.sync();
  assert.equal(env.userProps['fail:m1'], '2');
  assert.equal(env.userProps.lastFullSync, undefined); // keeps searching back until it's resolved

  // The third failure gives up on the email and fails the run, so Google emails you about it.
  env.reply('not json');
  assert.throws(() => env.sync(), /Couldn't read 1 email\(s\) after 3 tries; add them to the calendar by hand: "Interview confirmed" from Recruiting <recruiting@stripe\.com>/);
  assert.equal(env.userProps['done:m1'], String(NOW - HOUR));
  assert.equal(env.userProps['fail:m1'], undefined);
  assert.ok(env.userProps.lastFullSync);

  env.sync();
  assert.equal(env.requests.length, 4);
});

test('stops before the Apps Script time limit and resumes next run', () => {
  const env = createEnv({ now: NOW });
  for (let i = 0; i < 5; i++) env.addThread(email({ id: `m${i}`, date: NOW - (10 - i) * HOUR }));
  for (let i = 0; i < 5; i++) env.reply({ actions: [] });
  env.onRequest = () => { env.clock.now += 2 * 60 * 1000; };

  env.sync();
  assert.equal(env.requests.length, 3);
  assert.equal(env.userProps.lastFullSync, undefined);

  env.sync();
  assert.equal(env.requests.length, 5);
  assert.ok(env.userProps.lastFullSync);
});

test('after a pause, searches back to the last complete sync', () => {
  const env = createEnv({ now: NOW });
  env.userProps.lastFullSync = String(NOW - 10 * 24 * HOUR);
  env.sync();
  assert.match(env.queries[0], /^newer_than:11d /);
  env.userProps.lastFullSync = String(NOW - 90 * 24 * HOUR);
  env.sync();
  assert.match(env.queries[1], /^newer_than:14d /);
});

test('forgets handled emails once they are older than the search window', () => {
  const env = createEnv({ now: NOW });
  env.userProps['done:ancient'] = String(NOW - 40 * 24 * HOUR);
  env.userProps['done:recent'] = String(NOW - 20 * 24 * HOUR);
  env.sync();
  assert.equal(env.userProps['done:ancient'], undefined);
  assert.ok(env.userProps['done:recent']);
});

// --- Setup ------------------------------------------------------------------

test('setup in the main account creates, configures and shares the calendar', () => {
  const env = createEnv({
    now: NOW,
    ownedCalendars: [],
    writableCalendars: [],
    scriptProps: { GROQ_API_KEY: 'gsk-test', SHARE_WITH: 'second@gmail.com, third@gmail.com' },
  });
  env.run('setup()');

  const calendarId = env.scriptProps.CALENDAR_ID;
  assert.match(calendarId, /^cal-new-/);
  assert.equal(env.calendars.get(calendarId).summary, 'Interviews');
  assert.equal(env.calendars.get(calendarId).timeZone, 'America/New_York');
  assert.deepEqual(env.calendarList.get(calendarId).defaultReminders, [
    { method: 'popup', minutes: 1440 },
    { method: 'popup', minutes: 60 },
  ]);
  assert.deepEqual(env.acl.map((a) => [a.rule.role, a.rule.scope.value, a.args.sendNotifications]), [
    ['writer', 'second@gmail.com', false],
    ['writer', 'third@gmail.com', false],
  ]);
  assert.deepEqual(env.triggers, [{ handler: 'syncInterviews', minutes: 10 }]);
  assert.equal(env.queries.length, 1); // ran the first sync

  // Running setup again reuses the calendar and keeps a single trigger.
  env.run('setup()');
  assert.equal(env.scriptProps.CALENDAR_ID, calendarId);
  assert.equal(env.calendars.size, 1);
  assert.equal(env.triggers.length, 1);
});

test('setup in another account checks it can write to the shared calendar', () => {
  const env = createEnv({ now: NOW, me: 'second@gmail.com', ownedCalendars: [], writableCalendars: ['cal-main'] });
  env.run('setup()');
  assert.equal(env.eventList().length, 0); // access check event cleaned up
  assert.equal(env.calendarList.size, 0); // main account's reminders untouched
  assert.deepEqual(env.triggers, [{ handler: 'syncInterviews', minutes: 10 }]);

  const denied = createEnv({ now: NOW, me: 'second@gmail.com', ownedCalendars: [], writableCalendars: [] });
  assert.throws(() => denied.run('setup()'), /second@gmail\.com can't add events to calendar cal-main\. In your main account, add second@gmail\.com to SHARE_WITH/);
  assert.equal(denied.triggers.length, 0);
});

test('setup asks for the API key first', () => {
  const env = createEnv({ now: NOW, scriptProps: {} });
  assert.throws(() => env.run('setup()'), /Add GROQ_API_KEY \(free, from console\.groq\.com\)/);
});
