// Keeping the assistant's memory clean: the same fact is never stored twice, notes are updated instead of
// copied, and chat facts that have run out (an event that's over) are cleared.

const STOP = new Set(['the', 'and', 'for', 'with', 'are', 'was', 'her', 'she', 'his', 'him', 'they', 'their', 'this', 'that', 'from', 'has', 'have',
  'every', 'each', 'all', 'chat', 'group', 'groupme', 'members', 'member']);
const words = (t) => new Set((String(t).toLowerCase().match(/[a-z0-9']+/g) || []).map((w) => w.replace(/'s$/, ''))
  .filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w)));

// Two facts say the same thing: most of their words are shared (60% of all of them), or the
// shorter one (4 words or more) sits inside the longer one.
export function sameFact(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  const small = Math.min(x.size, y.size);
  return shared / (x.size + y.size - shared) >= 0.6 || (small >= 4 && shared === small);
}

export const TOPICS = ['people', 'school', 'clubs', 'work', 'health', 'money', 'preferences', 'goals', 'plans', 'other'];

// The old wording goes to note_history before a note is changed or removed.
const keepOld = (env, note, why) => env.DB.prepare('INSERT INTO note_history (note_id, text, why) VALUES (?, ?, ?)').bind(note.id, note.text, why).run();

// note_save: a note close to one already there replaces it (an update or a correction), so the
// same fact never sits in two notes. The user saying it turns a guess into a fact.
export async function saveNote(env, { text, topic, guess, until }) {
  if (!text) return 'Nothing to save.';
  const t = TOPICS.includes(topic) ? topic : 'other';
  const g = guess ? 1 : 0;
  const u = /^\d{4}-\d\d-\d\d$/.test(until || '') ? until : null;
  const notes = (await env.DB.prepare('SELECT id, text, guess FROM notes ORDER BY id DESC').all()).results;
  const twin = notes.find((n) => sameFact(n.text, text));
  if (twin) {
    // A guess never overwrites what the user said.
    if (g && !twin.guess) return `not saved: they already told you "${twin.text}" (note ${twin.id})`;
    await keepOld(env, twin, 'updated');
    await env.DB.prepare("UPDATE notes SET text = ?, topic = ?, guess = ?, until = ?, updated_at = datetime('now') WHERE id = ?").bind(text, t, g, u, twin.id).run();
    return `updated note ${twin.id} (it said: "${twin.text}")`;
  }
  await env.DB.prepare('INSERT INTO notes (text, topic, guess, until) VALUES (?, ?, ?, ?)').bind(text, t, g, u).run();
  return g ? 'saved as your guess (unconfirmed)' : 'saved';
}

export async function deleteNote(env, id) {
  const note = await env.DB.prepare('SELECT id, text FROM notes WHERE id = ?').bind(id).first();
  if (!note) return `no note ${id}`;
  await keepOld(env, note, 'deleted');
  await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  return 'deleted';
}

// Notes for the prompt: what still matters, by topic, guesses marked.
export async function notesByTopic(env, limit = 200) {
  const rows = (await env.DB.prepare("SELECT id, text, topic, guess FROM notes WHERE until IS NULL OR until >= date('now') ORDER BY id DESC LIMIT ?").bind(limit).all()).results.reverse();
  const by = new Map();
  for (const n of rows) by.set(n.topic || 'other', [...(by.get(n.topic || 'other') || []), n]);
  return [...by.entries()].map(([topic, ns]) => `[${topic}]\n${ns.map((n) => `${n.id}: ${n.text}${n.guess ? ' (your guess, not confirmed)' : ''}`).join('\n')}`).join('\n');
}

// New facts for one chat, minus any that repeat each other or a fact already learned from
// another chat (the same announcement goes out in several chats).
export async function freshFacts(env, chat, facts) {
  const others = (await env.DB.prepare('SELECT text FROM chat_facts WHERE chat != ?').bind(chat).all()).results.map((r) => r.text);
  const kept = [];
  for (const f of facts) if (![...others, ...kept.map((k) => k.text)].some((o) => sameFact(o, f.text))) kept.push(f);
  return kept;
}

// After every refresh (and /run?job=tidy): drops chat facts past their end date, chat facts that
// repeat one learned earlier, and notes that repeat a newer note.
export async function tidyMemory(env) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: env.TIMEZONE });
  const expired = await env.DB.prepare('DELETE FROM chat_facts WHERE until IS NOT NULL AND until < ?').bind(today).run();
  for (const n of (await env.DB.prepare('SELECT id, text FROM notes WHERE until IS NOT NULL AND until < ?').bind(today).all()).results) {
    await keepOld(env, n, 'ran out');
    await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(n.id).run();
  }
  const drop = (rows) => {
    const keep = [];
    const out = [];
    for (const r of rows) (keep.some((k) => sameFact(k.text, r.text)) ? out : keep).push(r);
    return out.map((r) => r.id);
  };
  const facts = drop((await env.DB.prepare('SELECT id, text FROM chat_facts ORDER BY id').all()).results); // the first learned stays
  const allNotes = (await env.DB.prepare('SELECT id, text FROM notes ORDER BY guess, id DESC').all()).results; // what the user said, newest, stays
  const notes = drop(allNotes);
  for (const id of facts) await env.DB.prepare('DELETE FROM chat_facts WHERE id = ?').bind(id).run();
  for (const id of notes) {
    await keepOld(env, allNotes.find((n) => n.id === id), 'merged with a repeat');
    await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
  }
  const n = expired?.meta?.changes ?? expired?.changes ?? 0;
  return `memory tidied: ${n} expired facts, ${facts.length} repeated facts, ${notes.length} repeated notes removed`;
}
