// Reminders: the assistant saves them, the minute check sends them through the Assistant chat.
import { toUtc, dayLabel } from './calendar.js';
import { sendToUser } from './groupme.js';

export const EVERY = ['day', 'weekday', 'week', 'month'];

const local = (iso, tz) => new Date(iso).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);

// The next time a repeating reminder is due, at the same local time (so daylight saving doesn't
// move it). ponytail: "month" from the 31st lands in the next month's overflow (Jan 31 -> Mar 3).
export function nextTime(atUtc, every, tz) {
  const was = local(atUtc, tz);
  let d = new Date(`${was.slice(0, 10)}T12:00:00Z`);
  const step = () => {
    d = every === 'week' ? new Date(d.getTime() + 7 * 86400000)
      : every === 'month' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 12))
        : new Date(d.getTime() + 86400000);
  };
  step();
  if (every === 'weekday') while (d.getUTCDay() === 0 || d.getUTCDay() === 6) step();
  return toUtc(`${d.toISOString().slice(0, 10)}T${was.slice(11, 16)}`, tz);
}

export async function addReminder(env, { text, at, every }) {
  if (!text || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(at || '')) return 'Need what to remind them of and a local time like "2026-11-05T17:00".';
  if (every && !EVERY.includes(every)) return `"every" must be one of: ${EVERY.join(', ')}.`;
  const utc = toUtc(at, env.TIMEZONE);
  if (Date.parse(utc) < Date.now() - 60000) return 'That time has already passed: ask them when they meant.';
  const row = await env.DB.prepare('INSERT INTO reminders (text, at, every) VALUES (?, ?, ?) RETURNING id').bind(text, utc, every || null).first();
  return `reminder ${row?.id ?? ''} set: "${text}", ${dayLabel(at)} at ${at.slice(11, 16)}${every ? `, then every ${every}` : ''}`;
}

export async function listReminders(env, limit = 30) {
  const rows = (await env.DB.prepare("SELECT id, text, at, every FROM reminders WHERE status = 'active' ORDER BY at LIMIT ?").bind(limit).all()).results;
  return rows.map((r) => {
    const at = local(r.at, env.TIMEZONE);
    return { id: r.id, text: r.text, when: `${dayLabel(at)} ${at.slice(11, 16)}`, at, ...(r.every ? { every: r.every } : {}) };
  });
}

export async function cancelReminder(env, id) {
  const r = await env.DB.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'active'").bind(id).run();
  return (r?.meta?.changes ?? r?.changes) === 0 ? `no active reminder ${id}` : `reminder ${id} cancelled`;
}

// Every minute: whatever is due goes to the user now (5 at most a minute, to stay inside the free
// plan's request limit). Repeating ones move to their next time; the rest are marked sent.
export async function sendReminders(env) {
  const now = new Date().toISOString();
  const due = (await env.DB.prepare("SELECT * FROM reminders WHERE status = 'active' AND at <= ? ORDER BY at LIMIT 5").bind(now).all()).results;
  for (const r of due) {
    const text = `⏰ Reminder: ${r.text}`;
    await sendToUser(env, text);
    await env.DB.prepare('INSERT INTO messages (role, content) VALUES (?, ?)').bind('assistant', text).run();
    if (r.every) {
      let next = nextTime(r.at, r.every, env.TIMEZONE);
      for (let i = 0; i < 400 && next <= now; i++) next = nextTime(next, r.every, env.TIMEZONE); // missed while down
      await env.DB.prepare('UPDATE reminders SET at = ? WHERE id = ?').bind(next, r.id).run();
    } else {
      await env.DB.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").bind(r.id).run();
    }
  }
  return `${due.length} reminders sent`;
}
