// The user's Apple (iCloud) calendar over CalDAV, signed in with an app-specific password.
// Inside the app an event looks like {id, summary, description, location, start, end, source, h},
// with start/end as {date} for all-day or {dateTime, timeZone?}.

const enc = new TextEncoder();

// ---- iCalendar text ----

const unesc = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const unfold = (text) => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
// Lines over 75 characters are continued on the next line after a space (RFC 5545).
const fold = (line) => (line.length <= 75 ? line : line.slice(0, 75) + line.slice(75).match(/.{1,74}/gs).map((c) => `\r\n ${c}`).join(''));

function icsTime(v, params) {
  const d = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  if (v.length === 8) return { date: d };
  const t = `${d}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}`;
  return v.endsWith('Z') ? { dateTime: `${t}Z` } : { dateTime: t, timeZone: params.TZID };
}

// Every VEVENT in a calendar file (Canvas feed or iCloud). Alarms inside an event are skipped.
export function parseIcs(text) {
  const out = [];
  let cur = null;
  let inAlarm = false;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur?.uid && cur.start) out.push(cur); cur = null; }
    else if (line === 'BEGIN:VALARM') inAlarm = true;
    else if (line === 'END:VALARM') inAlarm = false;
    else if (cur && !inAlarm) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...rest] = line.slice(0, i).split(';');
      const params = Object.fromEntries(rest.map((p) => p.split('=')));
      const val = line.slice(i + 1);
      if (name === 'UID') cur.uid = val;
      else if (name === 'SUMMARY') cur.title = unesc(val);
      else if (name === 'DESCRIPTION') cur.description = unesc(val);
      else if (name === 'LOCATION') cur.location = unesc(val);
      else if (name === 'URL') cur.url = val;
      else if (name === 'DTSTART') cur.start = icsTime(val, params);
      else if (name === 'DTEND') cur.end = icsTime(val, params);
      else if (name === 'RRULE') cur.rrule = val;
      else if (name === 'RECURRENCE-ID') cur.recurrenceId = val;
      else if (name === 'X-DOTTIE-SOURCE') cur.source = val;
      else if (name === 'X-DOTTIE-H') cur.h = val;
    }
  }
  return out;
}

// Local "2026-10-20" or "2026-10-20T19:00" -> UTC ISO, using the time zone's offset at that moment.
export function toUtc(local, tz) {
  const v = local.length === 10 ? `${local}T00:00` : local.slice(0, 16);
  const guess = Date.parse(`${v}:00Z`);
  const shown = new Date(guess).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);
  return new Date(guess - (Date.parse(`${shown}:00Z`) - guess)).toISOString();
}

// For showing the user and the model: "2026-10-20T19:00" in their time zone, or the date for all-day.
export function localTime(t, tz) {
  if (!t) return null;
  if (t.date) return t.date;
  if (/(Z|[+-]\d\d:\d\d)$/.test(t.dateTime)) return new Date(t.dateTime).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);
  return t.dateTime.slice(0, 16); // ponytail: a TZID event is assumed to be in the user's own time zone
}

// "Sun Nov 8" for a local "2026-11-08" or "2026-11-08T19:00": models get weekdays wrong, so every
// date they see carries its weekday.
export const dayLabel = (local) => (local
  ? new Date(`${local.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')
  : null);

// "Wed 2026-11-04, Thu 2026-11-05, ..." for the next `days` days from a local date, one week a line.
export function dateTable(today, days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(`${today}T12:00:00Z`) + i * 86400000);
    out.push(`${d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' })} ${d.toISOString().slice(0, 10)}`);
  }
  return out.map((x, i) => (i % 7 === 6 ? `${x}\n` : `${x}, `)).join('').trim().replace(/,$/, '');
}

const basic = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
function icsWhen(name, t, tz) {
  if (t.date) return `${name};VALUE=DATE:${t.date.replace(/-/g, '')}`;
  const zoned = /(Z|[+-]\d\d:\d\d)$/.test(t.dateTime);
  return `${name}:${basic(zoned ? new Date(t.dateTime).toISOString() : toUtc(t.dateTime, t.timeZone || tz))}`;
}

export function toIcs(id, e, tz) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//dottie-ai-assistant//EN', 'BEGIN:VEVENT',
    `UID:${id}`, `DTSTAMP:${basic(new Date().toISOString())}`, icsWhen('DTSTART', e.start, tz)];
  // Always an end: iCloud refuses events without one (404). A deadline ends when it starts.
  lines.push(icsWhen('DTEND', e.end || (e.start.date ? { date: addDays(e.start.date, 1) } : e.start), tz));
  lines.push(`SUMMARY:${esc(e.summary || 'Event')}`);
  if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
  if (e.source) lines.push(`X-DOTTIE-SOURCE:${e.source}`);
  if (e.h) lines.push(`X-DOTTIE-H:${e.h}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---- Event helpers shared by Canvas, GroupMe and chat ----

// Stable ids so running twice never makes a copy. Hex is safe in a URL and as a UID.
export async function eventId(seed) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(seed));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function plusMinutes(v, m) {
  const zoned = /(Z|[+-]\d\d:\d\d)$/.test(v);
  const ms = Date.parse(zoned ? v : `${v.slice(0, 16)}:00Z`) + m * 60000;
  return zoned ? new Date(ms).toISOString() : new Date(ms).toISOString().slice(0, 19);
}
const moment = (v, tz) => (/(Z|[+-]\d\d:\d\d)$/.test(v) ? { dateTime: v } : { dateTime: v.length === 16 ? `${v}:00` : v, timeZone: tz });

// {title, start, end?, all_day?, location?, description?} -> event.
// Timed events with no end get one hour; all-day events end the next day (the end is exclusive).
export function eventBody(e, tz) {
  const body = { summary: e.title };
  if (e.location) body.location = e.location;
  if (e.description) body.description = e.description;
  if (e.all_day || /^\d{4}-\d\d-\d\d$/.test(e.start)) {
    const s = e.start.slice(0, 10);
    body.start = { date: s };
    body.end = { date: e.end && e.end.slice(0, 10) > s ? e.end.slice(0, 10) : addDays(s, 1) };
  } else {
    body.start = moment(e.start, tz);
    body.end = moment(e.end || plusMinutes(e.start, 60), tz);
  }
  return body;
}

// ---- CalDAV ----

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
// The contents of every <name> element, whatever namespace prefix iCloud gives it.
export const tags = (xml, name) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g'))].map((m) => m[1]);
const firstHref = (xml) => decode(tags(xml, 'href')[0] || '').trim();

// Follows redirects by hand so the sign-in header is kept on iCloud's own servers.
async function dav(env, method, url, body, headers = {}) {
  // Test runs never change the calendar.
  if (env.DRY && (method === 'PUT' || method === 'DELETE')) {
    env.TRACE?.push({ would_write: method, event: url.split('/').pop() });
    return new Response(null, { status: method === 'PUT' ? 201 : 204 });
  }
  for (let hops = 0; hops < 4; hops++) {
    const r = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        authorization: `Basic ${btoa(`${env.ICLOUD_EMAIL}:${env.ICLOUD_APP_PASSWORD}`)}`,
        'content-type': body?.startsWith('<?xml') ? 'application/xml; charset=utf-8' : 'text/calendar; charset=utf-8',
        ...headers,
      },
      body,
    });
    const to = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!to) {
      if (r.status === 401) throw new Error('iCloud refused the sign-in: check ICLOUD_EMAIL and the app-specific password');
      return r;
    }
    url = new URL(to, url).href;
  }
  throw new Error('iCloud kept redirecting');
}

const XML = (inner) => `<?xml version="1.0" encoding="utf-8"?>${inner}`;
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

async function propfind(env, url, depth, props) {
  const r = await dav(env, 'PROPFIND', url, XML(`<d:propfind ${NS}><d:prop>${props}</d:prop></d:propfind>`), { depth: String(depth) });
  if (r.status !== 207) throw new Error(`iCloud PROPFIND answered ${r.status}`);
  return r.text();
}

let found = null; // { url, name, all } for this worker instance
async function calendars(env) {
  if (found) return found;
  const root = 'https://caldav.icloud.com/';
  const principal = new URL(firstHref(tags(await propfind(env, root, 0, '<d:current-user-principal/>'), 'current-user-principal')[0] || ''), root).href;
  const home = new URL(firstHref(tags(await propfind(env, principal, 0, '<c:calendar-home-set/>'), 'calendar-home-set')[0] || ''), principal).href;
  const list = tags(await propfind(env, home, 1, '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>'), 'response')
    .filter((r) => /<(?:[\w-]+:)?calendar[\s/>]/.test(tags(r, 'resourcetype')[0] || '') && /VEVENT/.test(r))
    .map((r) => ({
      name: decode(tags(r, 'displayname')[0] || '').trim(),
      url: new URL(firstHref(r), home).href,
      // Someone else's calendar shared with the user (<CS:shared/>) or one they share (<CS:shared-owner/>):
      // other people see what goes on it, so the assistant never writes there.
      shared: /<(?:[\w-]+:)?shared(?:-owner)?[\s/>]/.test(tags(r, 'resourcetype')[0] || ''),
    }));
  if (!list.length) throw new Error('No iCloud calendars found. Is Calendars turned on under iCloud on your iPhone?');
  const want = (env.CALENDAR_NAME || '').toLowerCase();
  const own = list.filter((c) => !c.shared);
  const pick = own.find((c) => c.name.toLowerCase() === want) ||
    own.find((c) => ['home', 'calendar', 'personal'].includes(c.name.toLowerCase())) || own[0] || list[0];
  found = { ...pick, home, list };
  return found;
}

// Events on the calendar it writes to have a plain id; events on the user's other calendars carry
// that calendar's folder too ("abc123/EVENTID"), so they can still be opened, moved or deleted.
const slash = (u) => u.replace(/\/?$/, '/');
async function eventUrl(env, id) {
  const c = await calendars(env);
  return `${slash(id.includes('/') ? c.home : c.url)}${id}.ics`;
}

function toEvent(id, v, calendar) {
  return {
    id, calendar, summary: v.title, description: v.description, location: v.location, start: v.start, end: v.end,
    source: v.source, h: v.h, repeats: Boolean(v.rrule || v.recurrenceId), unexpanded: Boolean(v.rrule && !v.recurrenceId),
  };
}

// Events overlapping [timeMin, timeMax) on all the user's calendars (or only the one it writes to),
// repeating ones spread into their single dates when iCloud does that (CalDAV "expand").
// Sorted by start.
export async function listEvents(env, timeMin, timeMax, { onlyMine = false } = {}) {
  const c = await calendars(env);
  const s = basic(new Date(timeMin).toISOString());
  const e = basic(new Date(timeMax || Date.now() + 400 * 86400000).toISOString());
  const query = XML(`<c:calendar-query ${NS}><d:prop><d:getetag/>` +
    `<c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR">` +
    `<c:comp-filter name="VEVENT"><c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`);
  const out = [];
  for (const cal of onlyMine ? [c] : c.list) {
    const r = await dav(env, 'REPORT', cal.url, query, { depth: '1' });
    if (r.status !== 207) throw new Error(`iCloud calendar search (${cal.name}) answered ${r.status}`);
    const folder = cal.url === c.url ? '' : slash(cal.url).slice(slash(c.home).length);
    for (const resp of tags(await r.text(), 'response')) {
      const id = folder + firstHref(resp).split('/').pop().replace(/\.ics$/, '');
      for (const v of parseIcs(decode(tags(resp, 'calendar-data')[0] || ''))) out.push(toEvent(id, v, cal.name));
    }
  }
  const key = (t) => (t?.date ? `${t.date}T00:00:00Z` : t?.dateTime || '');
  return out.sort((a, b) => Date.parse(key(a.start)) - Date.parse(key(b.start)));
}

async function getRaw(env, id) {
  const r = await dav(env, 'GET', await eventUrl(env, id));
  if (r.status === 404) throw new Error(`no event with id ${id}`);
  if (!r.ok) throw new Error(`iCloud answered ${r.status}`);
  return { text: await r.text(), etag: r.headers.get('etag') };
}

export async function getEvent(env, id) {
  const v = parseIcs((await getRaw(env, id)).text)[0];
  if (!v) throw new Error(`event ${id} is empty`);
  return toEvent(id, v, id.includes('/') ? 'another calendar' : (await calendars(env)).name);
}

async function put(env, id, e, headers) {
  return dav(env, 'PUT', await eventUrl(env, id), toIcs(id.split('/').pop(), e, env.TIMEZONE), headers);
}

// The calendar it changes (the user's own calendar) and the ones it only reads.
export async function calendarNames(env) {
  const c = await calendars(env);
  return { mine: c.name, readOnly: c.list.filter((x) => x.url !== c.url).map((x) => x.name) };
}

// The user's other calendars (shared ones, a work calendar) are read only. Their events have a
// folder in the id, so the check is on the id.
function onlyOwn(id) {
  if (id.includes('/')) throw new Error('that event is on one of their other calendars, which you only read; they can change it in their Calendar app');
}

// Creates the event under our own id on the user's own calendar unless it is already there.
// Returns the id, or false if it was already there.
export async function insertOnce(env, id, e) {
  onlyOwn(id);
  const r = await put(env, id, e, { 'if-none-match': '*' });
  if (r.status === 412) return false;
  if (!r.ok) throw new Error(`iCloud would not save "${e.summary}" (${r.status} ${(await r.text()).slice(0, 300)})`);
  return id;
}

// Our own events only (Canvas): writes the whole event again.
export async function replaceEvent(env, id, e) {
  onlyOwn(id);
  const r = await put(env, id, e);
  if (!r.ok) throw new Error(`iCloud would not update "${e.summary}" (${r.status})`);
}

export async function addEvent(env, e) {
  const id = await insertOnce(env, crypto.randomUUID().replace(/-/g, ''), e);
  return { id, ...e };
}

// Changes title, place or time in the event's own file, keeping everything else on it
// (alerts, notes, invitees). Repeating events are left to the Calendar app.
export async function updateEvent(env, id, change) {
  onlyOwn(id);
  const { text } = await getRaw(env, id);
  if (/^RRULE[:;]/m.test(text)) throw new Error('that is a repeating event; change it in the Calendar app');
  const drop = new Set([
    ...(change.title ? ['SUMMARY'] : []), ...(change.location ? ['LOCATION'] : []), ...(change.start ? ['DTSTART', 'DTEND', 'DURATION'] : []),
  ]);
  const add = [];
  if (change.title) add.push(`SUMMARY:${esc(change.title)}`);
  if (change.location) add.push(`LOCATION:${esc(change.location)}`);
  if (change.start) {
    const b = eventBody({ title: 'x', start: change.start, end: change.end, all_day: change.all_day }, env.TIMEZONE);
    add.push(icsWhen('DTSTART', b.start, env.TIMEZONE), icsWhen('DTEND', b.end, env.TIMEZONE));
  }
  let inEvent = false;
  let depth = 0;
  const lines = [];
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; lines.push(line, ...add); continue; }
    if (line === 'END:VEVENT') inEvent = false;
    if (inEvent && line.startsWith('BEGIN:')) depth++;
    if (inEvent && line.startsWith('END:')) depth--;
    if (inEvent && depth === 0 && drop.has(line.split(/[;:]/)[0])) continue;
    if (line) lines.push(line);
  }
  // No If-Match: iCloud answers 412 to the ETag its own GET hands back.
  const r = await dav(env, 'PUT', await eventUrl(env, id), lines.map(fold).join('\r\n') + '\r\n');
  if (!r.ok) throw new Error(`iCloud would not save the change (${r.status})`);
  return getEvent(env, id);
}

export async function deleteEvent(env, id, { allowRepeating = false } = {}) {
  onlyOwn(id);
  if (!allowRepeating && /^RRULE[:;]/m.test((await getRaw(env, id)).text)) {
    throw new Error('that is a repeating event; deleting it here would delete every one, so do it in the Calendar app');
  }
  const r = await dav(env, 'DELETE', await eventUrl(env, id));
  if (!r.ok && r.status !== 404) throw new Error(`iCloud would not delete it (${r.status})`);
}

// Setup check: reads only.
export async function checkCalendar(env) {
  const c = await calendars(env);
  const week = await listEvents(env, new Date().toISOString(), new Date(Date.now() + 7 * 86400000).toISOString());
  const per = c.list.map((x) => `${x.name}${x.shared ? " (shared, read only)" : ""} ${week.filter((e) => e.calendar === x.name).length}`).join(', ');
  const unexpanded = week.filter((e) => e.unexpanded).length;
  return `iCloud OK: changes only "${c.name}", reads the rest. Events in the next 7 days: ${per}. Repeating: ${week.filter((e) => e.repeats).length}` +
    (unexpanded ? `, ${unexpanded} NOT spread into dates (weekly classes would be missed)` : '');
}
