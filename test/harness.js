// Loads apps-script/Code.js into a sandbox with in-memory fakes of the Apps Script
// services it uses (Gmail, Calendar, UrlFetch, Properties, ...), so the sync logic
// can be tested with Node and no Google account.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.js'), 'utf8');

function isRealZone(tz) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

// Utilities.formatDate with the Java-style patterns Code.js uses. Like Apps
// Script, an unknown zone silently falls back to GMT.
function formatDate(date, tz, pattern) {
  // Java-style fixed offsets such as "GMT+05:30".
  const fixed = /^GMT([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (fixed) {
    const minutes = (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3]));
    return formatDate(new Date(date.getTime() + minutes * 60000), 'UTC', pattern);
  }
  const zone = isRealZone(tz) ? tz : 'UTC';
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  fmt.formatToParts(new Date(date.getTime())).forEach((part) => { p[part.type] = part.value; });
  const values = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second, EEE: p.weekday };
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss|EEE/g, (tok, literal) => (literal !== undefined ? literal : values[tok]));
}

// Independent wall-clock → instant conversion (brute force over offsets), used
// by the fake Calendar API to cross-check the script's own conversion.
function instantOf(apiTime) {
  if (apiTime.date) return Date.parse(apiTime.date + 'T00:00:00Z');
  if (!apiTime.timeZone) return Date.parse(apiTime.dateTime);
  if (!isRealZone(apiTime.timeZone)) throw new Error(`Invalid time zone definition: ${apiTime.timeZone}`);
  const want = apiTime.dateTime.slice(0, 19);
  const asUtc = Date.parse(want + 'Z');
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes += 15) {
    const t = asUtc - minutes * 60000;
    if (formatDate(new Date(t), apiTime.timeZone, "yyyy-MM-dd'T'HH:mm:ss") === want) return t;
  }
  throw new Error(`No such local time ${want} in ${apiTime.timeZone}`);
}

// A plain-text RFC 822 message unless the test supplies its own raw MIME.
function rawMessage(m) {
  return m.raw || [
    `From: ${m.from}`,
    `To: ${m.to || 'me@gmail.com'}`,
    `Subject: ${m.subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    m.body,
  ].join('\r\n');
}

function makeMessage(m) {
  return {
    getRawContent: () => rawMessage(m),
    getId: () => m.id,
    getFrom: () => m.from,
    getTo: () => m.to || 'me@gmail.com',
    getCc: () => m.cc || '',
    getSubject: () => m.subject,
    getPlainBody: () => m.body,
    getDate: () => new Date(m.date),
    isDraft: () => false,
    isInTrash: () => false,
    getAttachments: () => (m.attachments || []).map((a) => ({
      getName: () => a.name,
      getContentType: () => a.type,
      getDataAsString: () => a.data,
    })),
  };
}

function createEnv(options) {
  const opts = Object.assign({
    me: 'me@gmail.com',
    homeTz: 'America/New_York',
    now: Date.UTC(2026, 9, 10, 18, 0),
    scriptProps: { GROQ_API_KEY: 'gsk-test', CALENDAR_ID: 'cal-main' },
    ownedCalendars: ['cal-main'],
    writableCalendars: ['cal-main'],
  }, options);

  const env = {
    clock: { now: opts.now },
    threads: [],
    queries: [],
    requests: [],
    responses: [],
    logs: [],
    events: new Map(),
    calendars: new Map(),
    calendarList: new Map(),
    acl: [],
    triggers: [],
    sleeps: [],
    scriptProps: Object.assign({}, opts.scriptProps),
    userProps: {},
    nextId: 1,
    // Called before each Claude request; tests use it to simulate slow calls.
    onRequest: null,
  };
  opts.ownedCalendars.forEach((id) => {
    env.calendars.set(id, { id, summary: 'Interviews' });
    env.calendarList.set(id, { id, summary: 'Interviews', accessRole: 'owner', defaultReminders: [] });
  });
  const writable = new Set(opts.writableCalendars);

  env.addThread = (...messages) => env.threads.push(messages.map(makeMessage));
  env.reply = (plan) => env.responses.push(plan);
  env.eventList = () => [...env.events.values()];

  const store = (data) => ({
    getProperty: (k) => (k in data ? data[k] : null),
    setProperty: (k, v) => { data[k] = String(v); },
    deleteProperty: (k) => { delete data[k]; },
    getProperties: () => Object.assign({}, data),
  });

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const checkWritable = (calendarId) => {
    if (!writable.has(calendarId)) throw new Error('Forbidden: no write access');
  };
  const storeEvent = (resource, calendarId, id) => {
    const ev = Object.assign(clone(resource), { id, calendarId, status: 'confirmed' });
    ev.start = Object.assign({}, ev.start, { dateTime: new Date(instantOf(resource.start)).toISOString() });
    ev.end = Object.assign({}, ev.end, { dateTime: new Date(instantOf(resource.end)).toISOString() });
    if (resource.start.date) { ev.start = clone(resource.start); ev.end = clone(resource.end); }
    ev._raw = clone(resource);
    env.events.set(id, ev);
    return clone(ev);
  };

  const Calendar = {
    Events: {
      list: (calendarId, args) => {
        const min = Date.parse(args.timeMin);
        const max = Date.parse(args.timeMax);
        const items = env.eventList()
          .filter((e) => e.calendarId === calendarId)
          .filter((e) => { const t = instantOf(e.start); return t >= min && t < max; })
          .sort((a, b) => instantOf(a.start) - instantOf(b.start));
        return { items: clone(items) };
      },
      insert: (resource, calendarId) => {
        checkWritable(calendarId);
        return storeEvent(resource, calendarId, `ev${env.nextId++}`);
      },
      patch: (resource, calendarId, eventId) => {
        checkWritable(calendarId);
        if (!env.events.has(eventId)) throw new Error('Not Found');
        const merged = Object.assign(clone(env.events.get(eventId)._raw), clone(resource));
        return storeEvent(merged, calendarId, eventId);
      },
      remove: (calendarId, eventId) => {
        checkWritable(calendarId);
        if (!env.events.delete(eventId)) throw new Error('Not Found');
      },
    },
    Calendars: {
      insert: (resource) => {
        const id = `cal-new-${env.nextId++}`;
        env.calendars.set(id, Object.assign({ id }, resource));
        env.calendarList.set(id, { id, summary: resource.summary, accessRole: 'owner', defaultReminders: [] });
        writable.add(id);
        return { id, summary: resource.summary };
      },
    },
    CalendarList: {
      list: () => ({ items: clone([...env.calendarList.values()]) }),
      get: (id) => {
        if (!env.calendarList.has(id)) throw new Error('Not Found');
        return clone(env.calendarList.get(id));
      },
      insert: (resource) => {
        env.calendarList.set(resource.id, { id: resource.id, accessRole: 'owner', defaultReminders: [] });
        return clone(env.calendarList.get(resource.id));
      },
      patch: (resource, id) => {
        if (!env.calendarList.has(id)) throw new Error('Not Found');
        Object.assign(env.calendarList.get(id), clone(resource));
        return clone(env.calendarList.get(id));
      },
    },
    Acl: {
      insert: (rule, calendarId, args) => {
        env.acl.push({ rule: clone(rule), calendarId, args: clone(args) });
        return rule;
      },
    },
  };

  const UrlFetchApp = {
    fetch: opts.fetch || ((url, params) => {
      const body = JSON.parse(params.payload);
      env.requests.push({ url, headers: params.headers, body, params });
      if (env.onRequest) env.onRequest(body);
      if (!env.responses.length) throw new Error('Test made an unexpected Claude request');
      let next = env.responses.shift();
      if (typeof next === 'function') next = next(body);
      if (next && next.throws) throw new Error(next.throws);
      let status = 200;
      let headers = {};
      let text;
      const answer = typeof next === 'string' ? next : JSON.stringify(next);
      if (next && next.status) {
        status = next.status;
        headers = next.headers || {};
        text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body || {});
      } else if (url.includes('groq.com')) {
        // OpenAI-style chat completion.
        text = JSON.stringify({
          id: 'chatcmpl-test', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: (next && next.finish_reason) || 'stop' }],
        });
      } else {
        const content = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: answer }];
        text = JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content, stop_reason: (next && next.stop_reason) || 'end_turn' });
      }
      return { getResponseCode: () => status, getContentText: () => text, getHeaders: () => headers };
    }),
  };

  const record = (level) => (...args) => env.logs.push(`${level}: ${args.join(' ')}`);
  const sandbox = {
    console: { log: record('log'), warn: record('warn'), error: record('error'), info: record('log') },
    __clock: env.clock,
    GmailApp: {
      search: (query, start, max) => {
        env.queries.push(query);
        return env.threads.slice(start, start + max).map((messages) => ({ getMessages: () => messages }));
      },
      getAliases: () => ['me.alias@gmail.com'],
    },
    Calendar,
    CalendarApp: { getDefaultCalendar: () => ({ getTimeZone: () => opts.homeTz }) },
    UrlFetchApp,
    PropertiesService: {
      getScriptProperties: () => store(env.scriptProps),
      getUserProperties: () => store(env.userProps),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => opts.me }) },
    Utilities: {
      formatDate,
      sleep: (ms) => { env.sleeps.push(ms); env.clock.now += ms; if (opts.realSleep) opts.realSleep(ms); },
      base64Decode: (text) => Array.from(Buffer.from(text, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      newBlob: (bytes) => ({
        getDataAsString: (charset) => Buffer.from(bytes.map((b) => b & 255))
          .toString(/^utf-?8$/i.test(charset || 'UTF-8') ? 'utf8' : 'latin1'),
      }),
    },
    ScriptApp: {
      getProjectTriggers: () => env.triggers.map((t) => ({ getHandlerFunction: () => t.handler, _t: t })),
      deleteTrigger: (t) => { env.triggers = env.triggers.filter((x) => x !== t._t); },
      newTrigger: (handler) => ({
        timeBased: () => ({
          everyMinutes: (minutes) => ({ create: () => env.triggers.push({ handler, minutes }) }),
        }),
      }),
    },
  };
  const context = vm.createContext(sandbox);
  // Freeze "now" at env.clock.now while keeping the rest of Date intact.
  vm.runInContext(`(() => {
    const RealDate = Date;
    function FakeDate(...args) {
      if (!new.target) return RealDate();
      return args.length ? new RealDate(...args) : new RealDate(__clock.now);
    }
    FakeDate.now = () => __clock.now;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    globalThis.Date = FakeDate;
  })();`, context);
  vm.runInContext(CODE, context, { filename: 'Code.js' });

  env.run = (source) => vm.runInContext(source, context);
  env.sync = () => env.run('syncInterviews()');
  // The user message: the last one for both Groq (system, user) and Claude (user).
  env.promptOf = (body) => body.messages[body.messages.length - 1].content;
  env.lastPrompt = () => env.promptOf(env.requests[env.requests.length - 1].body);
  return env;
}

module.exports = { createEnv, formatDate, instantOf };
