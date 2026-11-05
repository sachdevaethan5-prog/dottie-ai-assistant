// GroupMe: read the user's group chats for events, and talk to them through a bot in a group of their own.
import { listEvents, localTime, dateTable, dayLabel } from './calendar.js';
import { llm, getState, setState, localNow, userName } from './agent.js';
import { freshFacts, tidyMemory } from './memory.js';

async function gm(env, path, init = {}) {
  const r = await fetch(`https://api.groupme.com/v3${path}`, {
    ...init,
    headers: { 'x-access-token': env.GROUPME_TOKEN, 'content-type': 'application/json' },
  });
  if (r.status === 304 || r.status === 202) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GroupMe ${path.split('?')[0]} answered ${r.status}`);
  return j.response;
}

// GroupMe caps a message at 1000 characters: longer ones (an email draft) go in parts, split at
// a line break where possible so each part reads (and copies) cleanly.
export function splitMessage(text, max = 990) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    // A blank line between sections first, then any line break, then a space.
    const at = [rest.lastIndexOf('\n\n', max), rest.lastIndexOf('\n', max), rest.lastIndexOf(' ', max)].find((i) => i > max / 2) ?? max;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).replace(/^\s+/, '');
  }
  return [...parts, rest].filter(Boolean);
}

export async function sendToUser(env, text) {
  if (env.DRY) { env.TRACE?.push({ would_send: text }); return; }
  for (const part of splitMessage(text)) {
    await gm(env, '/bots/post', { method: 'POST', body: JSON.stringify({ bot_id: env.GROUPME_BOT_ID, text: part }) });
  }
}

export async function readChat(env, name, limit = 40) {
  const groups = await gm(env, '/groups?per_page=100&omit=memberships');
  const g = groups.find((x) => x.name.toLowerCase() === name.toLowerCase()) ||
    groups.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
  if (!g) return `No chat called "${name}". Their chats: ${groups.map((x) => x.name).join(', ')}`;
  const res = await gm(env, `/groups/${g.id}/messages?limit=${Math.min(Math.max(limit, 1), 100)}`);
  const fmt = (s) => new Date(s * 1000).toLocaleString('en-US', { timeZone: env.TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return { chat: g.name, messages: (res?.messages || []).reverse().map((m) => `[${fmt(m.created_at)}] ${m.name}: ${m.text || '(photo or attachment)'}`) };
}

// Setup check: reads only, sends nothing.
export async function checkGroupMe(env) {
  const mine = await assistantGroupId(env);
  const groups = await gm(env, '/groups?per_page=100&omit=memberships');
  const assistant = groups.find((g) => g.id === mine);
  return `GroupMe OK: bot is in "${assistant?.name || mine}", ${groups.length} chats in all: ${groups.map((g) => g.name).join(', ')}`;
}

let assistantGroup = null;
export async function assistantGroupId(env) {
  if (!assistantGroup) {
    const bots = await gm(env, '/bots');
    assistantGroup = bots.find((b) => b.bot_id === env.GROUPME_BOT_ID)?.group_id;
    if (!assistantGroup) throw new Error('GROUPME_BOT_ID is not one of the bots on this GroupMe token');
  }
  return assistantGroup;
}

// Only chats that mention a time or a plan go to the model, which keeps the cost down.
// Whole words only, so "money" or "monster" don't count as Monday.
const LOOKS_LIKE_PLAN = /\b(\d{1,2}(:\d\d)?\s*(am|pm|a|p)|\d{1,2}\/\d{1,2}|(mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(day)?|jan(uary)?|feb(ruary)?|march|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|today|tonight|tmrw|tomorrow|next week|this week|meeting|gbm|event|party|practice|rehearsal|game|dinner|social|study|deadline|due|cancel(l?ed)?|postponed?|resched\w*)\b/i;
export const looksLikePlan = (m) => Boolean(m.event) || LOOKS_LIKE_PLAN.test(m.text || '');

// Oldest first; everything after the last message already seen is new (all of it, if that
// message has dropped out of the latest 25 or the chat is being read for the first time).
export function markNew(msgs, seenId) {
  const at = msgs.findIndex((m) => m.id === seenId);
  return msgs.map((m, i) => ({ ...m, isNew: i > at }));
}

// Only messages from the last six months count; a chat quiet for longer isn't opened at all.
export const SIX_MONTHS = 182 * 86400;

// The user's chat names, for matching what they call a chat to its real name.
export async function chatNames(env) {
  return (await gm(env, '/groups?per_page=100&omit=memberships')).map((g) => g.name);
}

// What the user has said about each chat (chats table), by lower-case name.
export async function chatInfo(env) {
  const rows = (await env.DB.prepare('SELECT * FROM chats').all()).results;
  return new Map(rows.map((r) => [r.name.toLowerCase(), r]));
}

// A full scan the user asked for ("scan my chats", "any plans?"): every chat with messages in the
// last six months (or just the one they named) is queued and read whole by the next minute
// checks, 8 chats a minute. Returns how many chats are queued.
export async function queueScan(env, only, extra = {}) {
  const mine = await assistantGroupId(env);
  const info = await chatInfo(env);
  const cutoff = Date.now() / 1000 - SIX_MONTHS;
  const want = String(only || '').toLowerCase();
  const groups = (await gm(env, '/groups?per_page=100&omit=memberships')).filter((g) =>
    g.id !== mine && !info.get(g.name.toLowerCase())?.muted &&
    (g.messages?.last_message_created_at || g.updated_at || 0) >= cutoff &&
    (!want || g.name.toLowerCase().includes(want)));
  if (!groups.length) return { queued: 0 };
  await setState(env, 'gm_rescan', JSON.stringify({ ids: groups.map((g) => g.id), total: groups.length, found: 0, duplicates: 0, ...extra }));
  return { queued: groups.length, chats: groups.map((g) => g.name) };
}

// Runs every minute. One request lists the user's chats with each one's newest message id, so
// only chats with something new are opened, plus any chats queued by a full scan.
export async function pollGroups(env) {
  const mine = await assistantGroupId(env);
  const groups = await gm(env, '/groups?per_page=100&omit=memberships');
  const seen = JSON.parse((await getState(env, 'gm_seen')) || '{}');
  const scan = JSON.parse((await getState(env, 'gm_rescan')) || 'null');
  const queued = new Set(scan?.ids || []);
  const info = await chatInfo(env);
  const cutoff = Date.now() / 1000 - SIX_MONTHS;
  const chats = [];
  const next = { ...seen };
  let fetched = 0;
  // Queued chats first, so a scan the user asked for moves along.
  for (const g of [...groups].sort((a, b) => queued.has(b.id) - queued.has(a.id))) {
    const whole = queued.has(g.id);
    const last = g.messages?.last_message_id;
    if (g.id === mine || !last || (!whole && seen[g.id] === last)) continue;
    const lastAt = g.messages?.last_message_created_at || g.updated_at || 0;
    if (info.get(g.name.toLowerCase())?.muted || lastAt < cutoff) { next[g.id] = last; queued.delete(g.id); continue; }
    // ponytail: 8 chats a run (free plan allows 50 requests); the rest wait a minute.
    // More than 25 new messages in one minute skips the oldest of them.
    if (fetched++ >= 8) continue;
    next[g.id] = last;
    queued.delete(g.id);
    // The latest 25 messages (50 in a full scan): the new ones plus what came just before, so
    // "8 it is" is read together with "does 7 or 8 work?". A full scan reads them all as new.
    const res = await gm(env, `/groups/${g.id}/messages?limit=${whole ? 50 : 25}`);
    const msgs = markNew((res?.messages || []).sort((a, b) => a.created_at - b.created_at), whole ? undefined : seen[g.id])
      .filter((m) => m.sender_type !== 'bot' && m.created_at >= cutoff);
    if (msgs.some((m) => m.isNew && looksLikePlan(m))) chats.push({ group: g.name, msgs, info: info.get(g.name.toLowerCase()) });
  }
  const result = chats.length ? await suggestEventsFrom(env, chats) : { asked: 0, duplicates: 0 };
  await setState(env, 'gm_seen', JSON.stringify(next));
  if (scan) {
    scan.found += result.asked;
    scan.duplicates += result.duplicates;
    scan.ids = [...queued];
    if (scan.ids.length) await setState(env, 'gm_rescan', JSON.stringify(scan));
    else {
      await env.DB.prepare("DELETE FROM state WHERE key = 'gm_rescan'").run();
      // Behind the scenes after every full scan: the 10-minute job refreshes what it knows from the chats.
      await setState(env, 'learn_pending', '1');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: env.TIMEZONE });
      const waiting = (await env.DB.prepare("SELECT * FROM pending WHERE status = 'asked' AND start >= ? ORDER BY start LIMIT 25").bind(today).all()).results;
      const text = scanDoneText(scan, waiting);
      await sendToUser(env, text);
      await env.DB.prepare('INSERT INTO messages (role, content) VALUES (?, ?)').bind('assistant', text).run();
    }
  }
  return `${chats.length} chats checked, ${result.asked} events suggested, ${result.duplicates} duplicates skipped${scan ? `, scan: ${queued.size} chats left` : ''}`;
}

// Ends with everything still waiting for a yes: a scan shows everything not added yet.
export const scanDoneText = (scan, waiting = []) =>
  `${scan.daily ? 'Daily check done!' : 'Scan done!'} I went through ${scan.total} chat${scan.total === 1 ? '' : 's'} from the last six months. ` +
  (scan.found ? `Found ${scan.found} new plan${scan.found === 1 ? '' : 's'}.` : 'Nothing new.') +
  (waiting.length
    ? `\n\nEverything not on your calendar yet:\n${suggestionText(waiting)}\nSay "add all", "add ${waiting[0].id} and ${waiting.at(-1).id}", or "skip ${waiting[0].id}".`
    : ' Everything I found is already on your calendar.');

// The weekday named in some text ("party sunday") when the date is on another day, e.g. "Sun".
export function wrongWeekday(text, start) {
  const named = String(text || '').toLowerCase().match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*day\b/g)?.map((d) => d.slice(0, 3)) || [];
  const wd = dayLabel(start).slice(0, 3).toLowerCase();
  return named.length && !named.includes(wd) ? named[0][0].toUpperCase() + named[0].slice(1) : null;
}

// ---- Duplicates ----

// "2026-11-10:workday" for a called-off notice (today's date when the model gave none).
export const cancelKey = (c, today) => `${/^\d{4}-\d\d-\d\d/.test(c.date || '') ? c.date.slice(0, 10) : today}:${String(c.title).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

const STOP = new Set(['the', 'and', 'for', 'with', 'our', 'your', 'her', 'his', 'their', 'this', 'that', 'next', 'new', 'from', 'all']);
// Title words, without the [Course name] Canvas adds; numbers and short words like "hw" count.
const words = (t) => new Set((String(t).replace(/\[[^\]]*\]/g, ' ').toLowerCase().match(/[a-z0-9]+/g) || [])
  .filter((w) => (w.length >= 3 || /\d|^hw$/.test(w)) && !STOP.has(w)));
const KINDS = [['hw', 'homework'], ['quiz', 'quizzes'], ['exam', 'exams', 'midterm', 'test'], ['classwork'], ['project'], ['lab'], ['essay', 'paper']];
const kindOf = (ws) => KINDS.findIndex((k) => k.some((w) => ws.has(w)));
const numbers = (ws) => [...ws].filter((w) => /^\d+$/.test(w));
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// {title, start: "2026-11-10T19:00" or "2026-11-10"} in the user's time zone -> {title, date, time}.
export const slot = (title, start) => ({ title, date: start.slice(0, 10), time: start.length > 10 ? start.slice(11, 16) : null });

// Same day and clearly the same thing: one title inside the other, or half their words shared,
// or a shared word at nearly the same time. Times more than 90 minutes apart are different events.
export function sameEvent(a, b) {
  if (a.date !== b.date) return false;
  const x = words(a.title);
  const y = words(b.title);
  const shared = [...x].filter((w) => y.has(w)).length;
  if (!shared) return false;
  // "Unit 7 HW" and "Unit 7 Quiz", or "Worksheet #8" and "Worksheet #9", are different things.
  const [kx, ky] = [kindOf(x), kindOf(y)];
  if (kx >= 0 && ky >= 0 && kx !== ky) return false;
  const [nx, ny] = [numbers(x), numbers(y)];
  if (nx.length && ny.length && !nx.some((n) => ny.includes(n))) return false;
  const gap = a.time && b.time ? Math.abs(minutes(a.time) - minutes(b.time)) : null;
  if (gap !== null && gap > 90) return false;
  // One title inside the other counts only when the shorter has two words or more ("Band" alone
  // is too little to go on), unless the times match too.
  const small = Math.min(x.size, y.size);
  const inside = shared === small && (small >= 2 || x.size === y.size || (gap !== null && gap <= 30));
  return inside || shared / (x.size + y.size - shared) >= 0.5 || (gap !== null && gap <= 30);
}

export const findDuplicate = (candidate, existing) => existing.find((e) => sameEvent(candidate, e));

// The real chat name for the model's "group" answer, so the chat's calendar and info are found.
function chatName(chats, said) {
  const s = String(said || '').toLowerCase();
  const c = chats.find((x) => x.group.toLowerCase() === s) || chats.find((x) => s && x.group.toLowerCase().includes(s)) ||
    (chats.length === 1 ? chats[0] : null);
  return c?.group || said || 'GroupMe';
}

export function when(start, allDay) {
  const d = new Date(start.length === 10 ? `${start}T12:00:00Z` : `${start.slice(0, 16)}:00Z`);
  const day = d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  return allDay || start.length === 10 ? day : `${day}, ${d.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })}`;
}

export const suggestionText = (rows) => rows.map((r) =>
  `${r.id}. ${r.title}, ${when(r.start, r.all_day)}${r.location ? `, ${r.location}` : ''} (${r.grp})${r.quote ? `: "${r.quote}"` : ''}`).join('\n');

// Same day + same title (letters and digits only) counts as the same event, across chats and runs.
export const eventKey = (e) => `${e.start.slice(0, 10)}:${e.title.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

export async function suggestEventsFrom(env, chats) {
  const tz = env.TIMEZONE;
  const fmt = (s) => new Date(s * 1000).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: tz });
  const upcoming = await listEvents(env, now.toISOString(), new Date(now.getTime() + 60 * 86400000).toISOString());
  // Every GroupMe event already brought up, whatever the answer was: added, waiting, or turned down.
  const pending = (await env.DB.prepare('SELECT title, start, status FROM pending WHERE start >= ?').bind(today).all()).results;
  const said = { asked: 'already suggested', added: 'already added', skipped: 'they said no' };
  const known = [...upcoming.map((e) => `${e.summary} @ ${localTime(e.start, tz)}`), ...pending.map((p) => `${p.title} @ ${p.start} (${said[p.status] || 'already suggested'})`)];
  // Everything on any of the user's calendars or already brought up, for the duplicate check.
  const existing = [...upcoming.map((e) => slot(e.summary || '', localTime(e.start, tz))), ...pending.map((p) => slot(p.title, p.start))];
  const about = chats.filter((c) => c.info?.about).map((c) => `- ${c.group}: ${c.info.about}`).join('\n');
  const transcript = chats.map((c) => `## Chat: ${c.group}\n` + c.msgs.map((m) =>
    `${m.isNew ? 'NEW ' : ''}[sent ${fmt(m.created_at)}] ${m.name}: ${m.text || ''}${m.event ? ` GROUPME EVENT DATA: ${JSON.stringify(m.event.data || m.event).slice(0, 600)}` : ''}`).join('\n')).join('\n\n');

  const msg = await llm(env, [
    { role: 'system', content: `You read ${userName(env)}'s GroupMe chats and pick out events they may want on their calendar. They will be asked about each one, so be accurate rather than complete.
Now: ${localNow(env)} (${tz}). Today is ${today}.
Dates with their weekdays (use these, don't work weekdays out yourself):
${dateTable(today, 70)}

Return JSON only:
{"events":[{"title","start","weekday","end","all_day","location","group","quote"}],
 "cancelled":[{"title","date","quote"}]}

What counts as an event:
- A plan for the whole group or that includes ${userName(env)}: meetings, general body meetings, practices, rehearsals, games, socials, parties, study sessions, trips, rides they are part of, sign-up or payment deadlines the group sets.
- A GroupMe calendar event (GROUPME EVENT DATA) always counts.
- Plans aimed at ${userName(env)} by name or @mention count.
Leave out:
- Plans between other people that don't include ${userName(env)} ("Leo and I are getting food at 6").
- Ideas not settled yet ("does 7 or 8 work?", "we should hang sometime", polls still open). Once the chat settles on a time, include it.
- Anything in the past, and anything in the list below (on their calendar, already added, already suggested, or turned down), even if worded differently. Never bring those up again.
Messages marked NEW arrived since the last check; the others are earlier context. Only report events that the NEW messages announce, settle, change or call off.
How to read details:
- Work dates out from when the message was SENT, not from now: "tomorrow" in a message sent Mon means Tue. A date with no year is the next one coming.
- If a later message changes the time or place, use the latest. If it was called off, leave it out of events.
- Times: "7" for a meeting or party means 19:00; "8" for a morning thing means 08:00. Use 24-hour local times like "2026-10-20T19:00". No time given: use the date "2026-10-20" with all_day true.
- end only if stated. location only if stated (room, building, address).
- title: short and specific, with the club or class name if known: "Finance Club meeting", not "meeting!!".
- group: the chat name. quote: the few words from the chat that show it (under 90 characters). weekday: the start date's weekday from the table, e.g. "Sun".
cancelled: only for events in the list below that the chat clearly calls off or moves to another day.
The same event is often posted in more than one chat or more than once: report it once.
${about ? `\nWhat these chats are (use it in titles, e.g. "Robotics Club build night"):\n${about}\n` : ''}
Already on their calendar or already suggested:
${known.slice(0, 150).join('\n') || '(nothing)'}` },
    { role: 'user', content: transcript },
  ], null, true, env.EXTRACT_MODEL);

  let out;
  try { out = JSON.parse(msg.content.replace(/^```(json)?|```$/g, '').trim()); } catch { return { asked: 0, duplicates: 0 }; }
  env.TRACE?.push({ model_found: out });

  const rows = [];
  const unclear = [];
  let duplicates = 0;
  for (const e of (out.events || []).slice(0, 10)) {
    if (!e?.title || !/^\d{4}-\d\d-\d\d(T\d\d:\d\d)?$/.test(e.start || '') || e.start.slice(0, 10) < today) continue;
    // A date whose weekday doesn't match what the model said, or a weekday in the chat's words
    // that the date isn't on, means the date was worked out wrong: better to leave it out.
    if ((e.weekday && String(e.weekday).slice(0, 3).toLowerCase() !== dayLabel(e.start).slice(0, 3).toLowerCase()) || wrongWeekday(e.quote, e.start)) {
      env.TRACE?.push({ dropped_wrong_weekday: e.title, start: e.start, weekday: e.weekday, quote: e.quote });
      unclear.push(`- ${e.title} (${chatName(chats, e.group)}): "${String(e.quote || '').slice(0, 90)}"`);
      continue;
    }
    const s = slot(e.title, e.start);
    const twin = findDuplicate(s, existing);
    if (twin) { duplicates++; env.TRACE?.push({ duplicate: e.title, of: twin.title }); continue; }
    existing.push(s); // so the same event twice in this batch is suggested once
    const allDay = e.all_day || e.start.length === 10 ? 1 : 0;
    const row = await env.DB.prepare(`INSERT INTO pending (key, title, start, end_at, all_day, location, grp, quote)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING RETURNING *`)
      .bind(eventKey(e), e.title, e.start, e.end || null, allDay, e.location || null, chatName(chats, e.group), (e.quote || '').slice(0, 90)).first();
    if (row) rows.push(row);
  }
  // "Looks called off" is said once per event, however many times the chat is read.
  const told = new Set(JSON.parse((await getState(env, 'gm_cancel_told')) || '[]').filter((k) => k.slice(0, 10) >= today));
  const gone = (out.cancelled || []).filter((c) => c?.title && !told.has(cancelKey(c, today))).slice(0, 5);
  for (const c of gone) told.add(cancelKey(c, today));
  await setState(env, 'gm_cancel_told', JSON.stringify([...told]));
  if (!rows.length && !gone.length && !unclear.length) return { asked: 0, duplicates };

  // Chats the user hasn't described yet: ask once, the first time one of them has an event.
  const unknown = chats.filter((c) => !c.info && rows.some((r) => r.grp.toLowerCase() === c.group.toLowerCase())).map((c) => c.group);
  for (const name of unknown) {
    await env.DB.prepare('INSERT INTO chats (name, asked) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET asked = 1').bind(name).run();
  }

  let text = '';
  if (rows.length) {
    text += `New plans from your chats:
${suggestionText(rows)}
Reply "add all", "add ${rows[0].id}" or "skip ${rows[0].id}" to choose what goes on your calendar.`;
  }
  if (gone.length) {
    text += `${text ? '\n\n' : ''}These may be cancelled or moved:
${gone.map((c) => `- ${c.title}${c.date ? ` (${c.date})` : ''}: "${(c.quote || '').slice(0, 90)}"`).join('\n')}
Should I take them off your calendar?`;
  }
  if (unclear.length) {
    text += `${text ? '\n\n' : ''}These say a day that doesn't match the date, so I didn't guess:\n${unclear.join('\n')}\nWhich day is it? I'll add it once you tell me.`;
  }
  if (unknown.length) {
    text += `\n\nAlso, what ${unknown.length > 1 ? 'are' : 'is'} ${unknown.map((n) => `"${n}"`).join(' and ')}? And should I keep checking ${unknown.length > 1 ? 'them' : 'it'} for plans?`;
  }
  await sendToUser(env, text);
  // In the chat history too, so a plain "yes" next is understood as the answer to this.
  await env.DB.prepare('INSERT INTO messages (role, content) VALUES (?, ?)').bind('assistant', text).run();
  return { asked: rows.length, duplicates };
}

// ---- Learning from the user's chats ----
// Reads up to 300 recent messages (six months at most) of each active chat and keeps the lasting
// facts in chat_facts, plus what the chat is (chats.about, only where nobody has said yet). 8 chats
// a run to stay inside the free plan's request limit: run it again until it says none are left.
// /run?job=relearn starts it over by forgetting which chats were read.
export async function learnChats(env, { limit = 8 } = {}) {
  const mine = await assistantGroupId(env);
  const info = await chatInfo(env);
  const learned = JSON.parse((await getState(env, 'chats_learned')) || '{}');
  const cutoff = Date.now() / 1000 - SIX_MONTHS;
  const groups = (await gm(env, '/groups?per_page=100&omit=memberships')).filter((g) =>
    g.id !== mine && !info.get(g.name.toLowerCase())?.muted && (g.messages?.last_message_created_at || g.updated_at || 0) >= cutoff &&
    learned[g.id] !== g.messages?.last_message_id);
  const done = [];
  for (const g of groups.slice(0, limit)) {
    const msgs = [];
    let before = '';
    for (let page = 0; page < 3; page++) {
      const res = await gm(env, `/groups/${g.id}/messages?limit=100${before ? `&before_id=${before}` : ''}`);
      const batch = res?.messages || [];
      msgs.push(...batch.filter((m) => m.created_at >= cutoff && m.sender_type !== 'bot'));
      if (batch.length < 100 || batch.at(-1).created_at < cutoff) break;
      before = batch.at(-1).id;
    }
    const facts = msgs.length ? await chatFacts(env, g.name, msgs.sort((a, b) => a.created_at - b.created_at)) : { facts: [] };
    const fresh = await freshFacts(env, g.name, facts.facts);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM chat_facts WHERE chat = ?').bind(g.name),
      ...fresh.map((f) => env.DB.prepare('INSERT INTO chat_facts (chat, text, until) VALUES (?, ?, ?)').bind(g.name, f.text, f.until)),
      ...(facts.about ? [env.DB.prepare(`INSERT INTO chats (name, about) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET about = coalesce(about, excluded.about)`).bind(g.name, facts.about)] : []),
    ]);
    learned[g.id] = g.messages?.last_message_id;
    done.push(`${g.name}: ${fresh.length} facts`);
  }
  await setState(env, 'chats_learned', JSON.stringify(learned));
  return `${done.length} chats read${done.length ? ` (${done.join('; ')})` : ''}, ${Math.max(groups.length - limit, 0)} left`;
}

// Run by the 10-minute job: after a full scan, 3 chats a run until every chat with new messages
// has been read again (3 keeps the run inside the free plan's 50 requests next to Canvas and grades).
export async function learnAfterScan(env) {
  if (!(await getState(env, 'learn_pending'))) return 'nothing to refresh';
  const r = await learnChats(env, { limit: 3 });
  if (/, 0 left$/.test(r)) {
    await env.DB.prepare("DELETE FROM state WHERE key = 'learn_pending'").run();
    return `${r}; ${await tidyMemory(env)}`;
  }
  return r;
}

async function chatFacts(env, name, msgs) {
  const tz = env.TIMEZONE;
  const fmt = (s) => new Date(s * 1000).toLocaleString('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const transcript = msgs.map((m) => `[${fmt(m.created_at)}] ${m.name}: ${m.text || '(photo or file)'}${m.event ? ` EVENT: ${JSON.stringify(m.event.data || m.event).slice(0, 300)}` : ''}`).join('\n').slice(-60000);
  const msg = await llm(env, [
    { role: 'system', content: `You build the long-term memory of ${userName(env)}'s personal assistant from one of their GroupMe chats, "${name}". Today is ${localNow(env)}.
Return JSON only: {"about": "...", "facts": [{"text": "...", "until": "YYYY-MM-DD or null"}, ...]}
- about: what this chat is, in a few words (e.g. "the robotics club's announcements chat", "their pickup basketball group").
- facts: up to 12 lasting, useful facts they might ask about later:
  organizers and what they handle (first names), anything ${userName(env)} signed up for or offered to do,
  regular meeting times and places, costs and how to pay, sign-ups and recurring deadlines,
  useful places, links and accounts, and dates still ahead (with the year).
- Each fact is one clear sentence that makes sense on its own and names the group, with dates written out.
- until: the last day the fact matters, for anything tied to a date (an event, a deadline, a term-long role); null for things that stay true (who organizes it, where it meets).
- Say each thing once: no two facts about the same thing.
- Leave out: one-off chatter, jokes, plans that already happened (unless they show a pattern), and anything private or
  sensitive about other people (health, relationships, money troubles, phone numbers, home addresses).
- Nothing lasting in the chat: return an empty facts list.` },
    { role: 'user', content: transcript },
  ], null, true, env.EXTRACT_MODEL);
  try {
    const out = JSON.parse(msg.content.replace(/^```(json)?|```$/g, '').trim());
    const facts = (out.facts || []).map((f) => (typeof f === 'string' ? { text: f } : f)).filter((f) => typeof f?.text === 'string')
      .slice(0, 12).map((f) => ({ text: f.text.slice(0, 400), until: /^\d{4}-\d\d-\d\d$/.test(f.until || '') ? f.until : null }));
    return { about: typeof out.about === 'string' ? out.about.slice(0, 200) : null, facts };
  } catch {
    return { about: null, facts: [] };
  }
}

// ---- Searching the user's chats ----
// "Who said the bus leaves at 7?": messages by a person and/or about some words, in the chat
// the user named or, by default, the ones matching SEARCH_CHATS (or the 6 most recently active
// chats when it is empty, leaving out the Assistant chat), going back `days` (at most six months). 20 pages of 100 messages at most.
async function mostActive(env, all, recent) {
  const mine = await assistantGroupId(env).catch(() => null);
  return all.filter((g) => g.id !== mine).sort((a, b) => recent(b) - recent(a));
}

export async function searchChats(env, { group, person, words, days = 60 } = {}) {
  const all = await gm(env, '/groups?per_page=100&omit=memberships');
  const want = String(group || '').toLowerCase();
  const recent = (g) => g.messages?.last_message_created_at || g.updated_at || 0;
  let pattern = null;
  try { if (env.SEARCH_CHATS) pattern = new RegExp(env.SEARCH_CHATS, 'i'); } catch { return 'SEARCH_CHATS in wrangler.toml is not a valid pattern.'; }
  const chats = (want ? all.filter((g) => g.name.toLowerCase().includes(want))
    : pattern ? all.filter((g) => pattern.test(g.name)) : await mostActive(env, all, recent)).slice(0, 6);
  if (!chats.length) return `No chat matching "${group || env.SEARCH_CHATS || ''}". Their chats: ${all.map((g) => g.name).join(', ')}`;
  const since = Date.now() / 1000 - Math.min(Number(days) || 60, 182) * 86400;
  const who = String(person || '').toLowerCase().trim();
  const terms = String(words || '').toLowerCase().match(/[a-z0-9']{3,}/g) || [];
  const fmt = (s) => new Date(s * 1000).toLocaleString('en-US', { timeZone: env.TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const hits = [];
  let pages = 0;
  for (const g of chats) {
    let before = '';
    while (pages < 20) {
      pages++;
      const batch = (await gm(env, `/groups/${g.id}/messages?limit=100${before ? `&before_id=${before}` : ''}`))?.messages || [];
      for (const m of batch) {
        if (m.created_at < since || m.sender_type === 'bot') continue;
        const text = (m.text || '').toLowerCase();
        if (who && !String(m.name || '').toLowerCase().includes(who)) continue;
        if (terms.length && !terms.some((t) => text.includes(t))) continue;
        hits.push({ at: m.created_at, line: `[${fmt(m.created_at)}] ${g.name}, ${m.name}: ${(m.text || '(photo or file)').slice(0, 300)}` });
      }
      if (batch.length < 100 || batch.at(-1).created_at < since) break;
      before = batch.at(-1).id;
    }
  }
  hits.sort((a, b) => b.at - a.at);
  return {
    searched: chats.map((g) => g.name), found: hits.length,
    messages: hits.slice(0, 80).map((h) => h.line),
    ...(hits.length > 80 ? { note: 'Only the newest 80 are shown; narrow it with words or fewer days.' } : {}),
  };
}

// ---- "What did I miss?" ----
// The messages of the user's busiest chats over the last `hours` (or one chat they name), for the
// model to sum up. The Assistant chat and muted chats are left out; 6 chats and 100 messages each at most.
export async function recentChats(env, { group, hours = 24 } = {}) {
  const mine = await assistantGroupId(env);
  const info = await chatInfo(env);
  const since = Date.now() / 1000 - Math.min(Number(hours) || 24, 168) * 3600;
  const want = String(group || '').toLowerCase();
  const chats = (await gm(env, '/groups?per_page=100&omit=memberships'))
    .filter((g) => g.id !== mine && !info.get(g.name.toLowerCase())?.muted && (g.messages?.last_message_created_at || 0) >= since)
    .filter((g) => !want || g.name.toLowerCase().includes(want))
    .sort((a, b) => (b.messages?.count || 0) - (a.messages?.count || 0))
    .slice(0, 6);
  if (!chats.length) return want ? `No messages in a chat matching "${group}" in the last ${hours} hours.` : `Nothing new in their chats in the last ${hours} hours.`;
  const fmt = (s) => new Date(s * 1000).toLocaleString('en-US', { timeZone: env.TIMEZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const out = [];
  for (const g of chats) {
    const msgs = ((await gm(env, `/groups/${g.id}/messages?limit=100`))?.messages || [])
      .filter((m) => m.created_at >= since && m.sender_type !== 'bot').sort((a, b) => a.created_at - b.created_at);
    if (msgs.length) out.push({ chat: g.name, about: info.get(g.name.toLowerCase())?.about || undefined, messages: msgs.map((m) => `[${fmt(m.created_at)}] ${m.name}: ${(m.text || '(photo or file)').slice(0, 300)}`) });
  }
  return out.length ? out : `Nothing new in their chats in the last ${hours} hours.`;
}
