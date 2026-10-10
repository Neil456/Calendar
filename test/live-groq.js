// Live check against the real model: runs the script on 18 realistic emails with fake Gmail
// and Calendar but real Groq calls, then checks every event landed at the right moment.
// Uses about 40K tokens of your Groq allowance.
//   GROQ_API_KEY=gsk_... npm run live
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEnv } = require('./harness');

if (!process.env.GROQ_API_KEY) {
  console.error('Set GROQ_API_KEY first: GROQ_API_KEY=gsk_... npm run live');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
const usage = [];

// UrlFetchApp.fetch is synchronous, so make the real HTTP call with curl.
function curlFetch(url, params) {
  const headerFile = path.join(tmp, 'h');
  const bodyFile = path.join(tmp, 'b');
  const args = ['-sS', '-X', 'POST', url, '-H', `Content-Type: ${params.contentType}`, '--data-binary', '@-',
    '-D', headerFile, '-o', bodyFile, '-w', '%{http_code}', '--max-time', '120'];
  Object.entries(params.headers || {}).forEach(([k, v]) => args.push('-H', `${k}: ${v}`));
  const status = Number(execFileSync('curl', args, { input: params.payload }).toString().trim());
  const text = fs.readFileSync(bodyFile, 'utf8');
  const headers = {};
  fs.readFileSync(headerFile, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  });
  try {
    const data = JSON.parse(text);
    usage.push({ status, usage: data.usage, remainingTokens: headers['x-ratelimit-remaining-tokens'] });
  } catch (e) {
    usage.push({ status, text: text.slice(0, 200) });
  }
  if (status !== 200) console.log(`  HTTP ${status}: ${text.slice(0, 300)} retry-after=${headers['retry-after']}`);
  return { getResponseCode: () => status, getContentText: () => text, getHeaders: () => headers };
}

const realSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A fixed "now", so the expected dates below stay in the future whenever this runs.
const NOW = Date.UTC(2026, 9, 10, 2, 0); // Fri Oct 9 2026, 10pm New York
const H = 60 * 60 * 1000;
const env = createEnv({
  now: NOW,
  homeTz: 'America/New_York',
  scriptProps: { GROQ_API_KEY: process.env.GROQ_API_KEY, CALENDAR_ID: 'cal-main' },
  fetch: curlFetch,
  realSleep,
});

const googleInvite = [
  'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'METHOD:REQUEST',
  'BEGIN:VTIMEZONE', 'TZID:America/Los_Angeles', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700',
  'TZNAME:PDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'DTSTART;TZID=America/Los_Angeles:20261014T140000', 'DTEND;TZID=America/Los_Angeles:20261014T144500',
  'UID:7kq2stripe@google.com', 'SEQUENCE:0',
  'SUMMARY:Stripe Phone Screen with Neil', 'LOCATION:https://meet.google.com/abc-defg-hij',
  'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER:-P0DT0H10M0S', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');
// The same event, moved to Thursday 11am by the organizer (same UID, higher SEQUENCE).
const googleUpdate = googleInvite
  .replace('20261014T140000', '20261015T110000').replace('20261014T144500', '20261015T114500')
  .replace('SEQUENCE:0', 'SEQUENCE:1');
const coinbaseInvite = (method, sequence) => [
  'BEGIN:VCALENDAR', `METHOD:${method}`, 'BEGIN:VEVENT', 'UID:cb-889@goodtime.io', `SEQUENCE:${sequence}`,
  'DTSTART:20261028T170000Z', 'DTEND:20261028T180000Z', 'SUMMARY:Coinbase Technical Interview',
  method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

const outlookInvite = [
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'PRODID:Microsoft Exchange Server 2010',
  'BEGIN:VTIMEZONE', 'TZID:Pacific Standard Time', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'SUMMARY;LANGUAGE=en-US:Microsoft SWE Interview - Neil',
  'DTSTART;TZID=Pacific Standard Time:20261103T090000', 'DTEND;TZID=Pacific Standard Time:20261103T100000',
  'LOCATION:Microsoft Teams Meeting', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');
const outlookRaw = [
  'From: Microsoft Recruiting <recruit@microsoft.com>', 'Subject: Microsoft interview', 'Content-Type: multipart/alternative; boundary="b1"', '',
  '--b1', 'Content-Type: text/plain; charset="utf-8"', '',
  'Hi Neil, please find the Teams invite for your Microsoft software engineering interview attached.',
  '--b1', 'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', 'Content-Transfer-Encoding: base64', '',
  Buffer.from(outlookInvite).toString('base64').replace(/(.{76})/g, '$1\r\n'), '--b1--', '',
].join('\r\n');

// [email, expectation]
const cases = [
  [{ id: 'A', from: 'Google Calendar <calendar-notification@google.com>', subject: 'Invitation: Stripe Phone Screen with Neil @ Wed Oct 14, 2026 2pm - 2:45pm (PDT) (me@gmail.com)',
    body: 'Stripe Phone Screen with Neil\nWednesday Oct 14, 2026 ⋅ 2pm – 2:45pm (Pacific Time - Los Angeles)\nJoin with Google Meet\nmeet.google.com/abc-defg-hij\nOrganizer\nrecruiting@stripe.com\nInvitation from Google Calendar',
    attachments: [{ name: 'invite.ics', type: 'application/ics', data: googleInvite }] },
  { summary: /Stripe/, start: '2026-10-15T18:00:00.000Z', end: '2026-10-15T18:45:00.000Z', note: 'moved by P' }],
  [{ id: 'P', from: 'Google Calendar <calendar-notification@google.com>', subject: 'Updated invitation: Stripe Phone Screen with Neil @ Thu Oct 15, 2026 11am - 11:45am (PDT) (me@gmail.com)',
    body: 'This event has been changed.\nStripe Phone Screen with Neil\nChanged: Thursday Oct 15, 2026 ⋅ 11am – 11:45am (Pacific Time - Los Angeles)\nJoin with Google Meet\nmeet.google.com/abc-defg-hij',
    attachments: [{ name: 'invite.ics', type: 'application/ics', data: googleUpdate }] }, null],
  [{ id: 'B', from: 'Sam Lee <sam@datadoghq.com>', subject: 'Datadog technical interview confirmed',
    body: 'Hi Neil,\n\nThanks for confirming! Your technical interview with Datadog is set for Thursday, October 22nd at 11:00 AM ET. You\'ll meet with Priya (Senior Engineer) for 60 minutes over Zoom: https://datadog.zoom.us/j/9876543210\n\nBest,\nSam\nRecruiting Coordinator | Datadog\nNew York, NY' },
  { summary: /Datadog/, start: '2026-10-23T17:00:00.000Z', note: 'moved by K' }],
  [{ id: 'C', from: 'Jane Street via HackerRank <no-reply@hackerrank.com>', subject: 'Invitation: Jane Street Software Engineer Online Assessment',
    body: 'Hi Neil,\n\nYou have been invited to take the Jane Street Software Engineer Online Assessment. The test takes 90 minutes.\n\nThis test link will expire 7 days from the date of this invite.\n\nStart test: https://www.hackerrank.com/test/abc123\n\nGood luck!\nHackerRank' },
  { gone: /Jane Street/, note: 'removed by M (completed)' }],
  [{ id: 'D', from: 'CodeSignal <noreply@codesignal.com>', subject: 'Roblox has invited you to a General Coding Assessment',
    body: 'Hello Neil,\nRoblox has invited you to take the General Coding Assessment (70 minutes).\nPlease complete it by Sunday, October 18, 2026 at 11:59 PM PT.\nStart: https://app.codesignal.com/test/xyz' },
  { summary: /OA due: Roblox/, start: '2026-10-19T06:59:00.000Z' }],
  [{ id: 'E', from: 'Maya <maya@figma.com>', subject: 'Scheduling your hiring manager chat',
    body: 'Hi Neil! Could you let me know which of these works for a 30-minute interview with our hiring manager? Tuesday 10/20 at 2:00pm PT or Wednesday 10/21 at 3:00pm PT.' },
  { none: true, note: 'proposed slots only' }],
  [{ id: 'F', from: 'Airbnb Careers <no-reply@airbnb.com>', subject: 'Thanks for applying to Airbnb',
    body: 'Thank you for applying to the Software Engineer role at Airbnb. If your background is a fit, someone from our team will reach out to schedule an interview.' },
  { none: true, note: 'application receipt' }],
  [{ id: 'G', from: 'Flipkart Talent <talent@flipkart.com>', subject: 'Interview scheduled - SDE 1',
    body: 'Dear Neil,\nYour interview for the SDE-1 role at Flipkart is scheduled on 21st October 2026 at 7:30 PM IST.\nMode: Google Meet (https://meet.google.com/xyz-abcd-efg)\nRegards,\nFlipkart Talent Team, Bengaluru' },
  { summary: /Flipkart/, start: '2026-10-21T14:00:00.000Z' }],
  [{ id: 'H', from: 'Figma Recruiting <recruiting@figma.com>', subject: 'Your Figma onsite',
    body: 'Hi Neil,\nYour virtual onsite with Figma is confirmed for Monday, October 26 from 10:00 AM - 2:00 PM PT (1:00 PM - 5:00 PM ET). Schedule:\n10:00 Coding\n11:00 System design\n12:00 Lunch\n1:00 Behavioral' },
  { summary: /Figma/, start: '2026-10-26T17:00:00.000Z', end: '2026-10-26T21:00:00.000Z' }],
  [{ id: 'I', from: 'Notion Recruiting <jobs@makenotion.com>', subject: 'Notion final round',
    body: 'Hey Neil, your final round with Notion is booked: Tuesday 10/27 at 9am PST, 2 hours, at our SF office (2300 Harrison St).' },
  { gone: /Notion/, note: 'removed by L (cancelled)' }],
  [{ id: 'J', from: 'Alex <alex@ramp.com>', subject: 'Re: Ramp next steps',
    body: 'Hi Neil — great chatting today! Let\'s do the follow-up interview Monday Oct 19 at 3pm. Talk soon,\nAlex (Ramp)' },
  { summary: /^⚠️ Ramp/, start: '2026-10-19T19:00:00.000Z', note: 'no zone stated → home zone + ⚠️' }],
  [{ id: 'K', from: 'Sam Lee <sam@datadoghq.com>', subject: 'Re: Datadog technical interview confirmed',
    body: 'Hi Neil, Priya had a conflict so we\'ve moved your Datadog technical interview to Friday, October 23 at 1:00 PM Eastern. Same Zoom link.\n\nSam' }, null],
  [{ id: 'L', from: 'Notion Recruiting <jobs@makenotion.com>', subject: 'Re: Notion final round',
    body: 'Hi Neil, unfortunately we need to cancel your final round on 10/27. We\'ll be in touch about next steps.' }, null],
  [{ id: 'M', from: 'HackerRank <no-reply@hackerrank.com>', subject: 'Jane Street assessment submitted',
    body: 'Thank you for completing the Jane Street Software Engineer Online Assessment. Your responses have been submitted.' }, null],
  [{ id: 'N', from: 'Two Sigma Recruiting <recruiting@twosigma.com>', subject: 'Confirmed: recruiter call',
    body: 'Hi Neil, confirmed: recruiter call with Two Sigma tomorrow at 10:30am ET. I\'ll call you at the number on your resume.' },
  { summary: /Two Sigma/, start: 'TOMORROW_1030_ET' }],
  [{ id: 'O', raw: outlookRaw, from: 'Microsoft Recruiting <recruit@microsoft.com>', subject: 'Microsoft interview',
    body: 'Hi Neil, please find the Teams invite for your Microsoft software engineering interview attached.' },
  { summary: /Microsoft/, start: '2026-11-03T17:00:00.000Z', end: '2026-11-03T18:00:00.000Z' }],
  [{ id: 'Q', from: 'Coinbase Recruiting via GoodTime <scheduling@goodtime.io>', subject: 'Interview confirmed: Coinbase Technical Interview',
    body: 'Hi Neil, your Coinbase technical interview is confirmed. Calendar invite attached.',
    attachments: [{ name: 'invite.ics', type: 'text/calendar', data: coinbaseInvite('REQUEST', 0) }] },
  { gone: /Coinbase/, note: 'removed by R (cancelled invite)' }],
  [{ id: 'R', from: 'Coinbase Recruiting via GoodTime <scheduling@goodtime.io>', subject: 'Canceled: Coinbase Technical Interview',
    body: 'This event has been canceled.',
    attachments: [{ name: 'invite.ics', type: 'text/calendar', data: coinbaseInvite('CANCEL', 1) }] }, null],
];

// Received times: spread over the last 30 hours, in this order. N arrives an hour ago.
cases.forEach(([msg], i) => { msg.date = NOW - (cases.length - i) * 2 * H; });
cases.forEach(([msg]) => env.addThread(msg));

const started = Date.now();
env.sync();
console.log(`\nSync took ${Math.round((Date.now() - started) / 1000)}s, ${usage.length} Groq requests, waits: ${JSON.stringify(env.sleeps)}`);
console.log('\nLog:\n' + env.logs.map((l) => '  ' + l).join('\n'));
console.log('\nToken usage per request:');
usage.forEach((u, i) => console.log(`  ${i + 1}: ${JSON.stringify(u)}`));

// Expected "tomorrow at 10:30am ET", relative to when N arrived (New York date).
const nDate = new Date(cases.find(([m]) => m.id === 'N')[0].date);
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(nDate);
const tomorrow = new Date(Date.parse(nyDay + 'T00:00:00Z') + 24 * H).toISOString().slice(0, 10);
const tomorrowAt = new Date(Date.parse(`${tomorrow}T10:30:00-04:00`)).toISOString();

const events = env.eventList();
console.log('\nCalendar:');
events.forEach((e) => console.log(`  ${e.start.dateTime}  ${e.summary}  [${(e.description.match(/Time from: (.*)/) || [])[1]}]`));

let failures = 0;
console.log('\nChecks:');
cases.forEach(([msg, want]) => {
  if (!want) return;
  let ok;
  let detail = '';
  if (want.none) {
    ok = !events.some((e) => e.extendedProperties.private.sourceMessage === msg.id);
  } else if (want.gone) {
    ok = !events.some((e) => want.gone.test(e.summary));
  } else {
    const ev = events.find((e) => want.summary.test(e.summary));
    const start = want.start === 'TOMORROW_1030_ET' ? tomorrowAt : want.start;
    ok = !!ev && ev.start.dateTime === start && (!want.end || ev.end.dateTime === want.end);
    detail = ev ? `got ${ev.summary} ${ev.start.dateTime}–${ev.end.dateTime}` : 'missing';
    if (!ok) detail += `, expected ${start}${want.end ? '–' + want.end : ''}`;
  }
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg.id} ${msg.subject}${want.note ? ` (${want.note})` : ''} ${ok ? '' : detail}`);
});
console.log(`\n${failures ? failures + ' check(s) failed' : 'All checks passed'}`);
process.exitCode = failures ? 1 : 0;
