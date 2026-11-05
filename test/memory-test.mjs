// Memory stays clean: no repeated notes or chat facts, guesses marked, old wording kept.
// Every person, chat and fact here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sameFact, saveNote, deleteNote, notesByTopic, freshFacts, tidyMemory } from '../src/memory.js';

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => stmt(sql) };
}
const env = () => ({ DB: d1(), TIMEZONE: 'America/New_York' });

test('the same fact in other words is caught; different facts are not', () => {
  assert.equal(sameFact("Theo's birthday is August 9.", 'Theo birthday is August 9'), true);
  assert.equal(sameFact('Rae brings snacks to rehearsal.', 'Rae runs the snack sign-up sheet for rehearsal.'), false); // a judgment call left to both
  assert.equal(sameFact('The choir robe fitting form is on the shared drive; it closes March 1, 2027.', 'The choir robe fitting form is on the shared drive.'), true);
  assert.equal(sameFact('Physics exam is Monday', 'Geology exam is Monday'), false);
});

test('notes: a repeat or correction updates the note, the old wording is kept, guesses never overwrite what the user said', async () => {
  const e = env();
  assert.equal(await saveNote(e, { text: "Theo lives down the hall; Theo's birthday is August 9.", topic: 'people' }), 'saved');
  assert.match(await saveNote(e, { text: "Theo lives down the hall; Theo's birthday is August 10.", topic: 'people' }), /^updated note 1/);
  assert.equal((await e.DB.prepare('SELECT count(*) AS n FROM notes').first()).n, 1);
  assert.match((await e.DB.prepare('SELECT text FROM note_history WHERE note_id = 1').first()).text, /August 9/);

  assert.equal(await saveNote(e, { text: 'Their major is probably history.', topic: 'school', guess: true }), 'saved as your guess (unconfirmed)');
  assert.match(await saveNote(e, { text: 'Their major is history.', topic: 'school' }), /^updated note 2/); // the user confirmed
  assert.match(await saveNote(e, { text: 'Their major is probably history.', topic: 'school', guess: true }), /^not saved: they already told you/);

  await saveNote(e, { text: 'Fall lab section: Thursdays 2pm.', topic: 'school', until: '2020-12-20' }); // already over
  const prompt = await notesByTopic(e);
  assert.match(prompt, /\[people\]\n1: Theo lives down the hall; Theo's birthday is August 10\./);
  assert.match(prompt, /\[school\]\n2: Their major is history\./);
  assert.doesNotMatch(prompt, /lab section/);

  assert.equal(await deleteNote(e, 1), 'deleted');
  assert.equal((await e.DB.prepare("SELECT count(*) AS n FROM note_history WHERE note_id = 1 AND why = 'deleted'").first()).n, 1);
});

test('chat facts: no copies across chats; tidy clears what ran out and repeats', async () => {
  const e = env();
  await e.DB.prepare("INSERT INTO chat_facts (chat, text) VALUES ('Hiking Club', 'Hiking Club meets Saturdays at 8am at the north trailhead.')").run();
  await e.DB.prepare("INSERT INTO chat_facts (chat, text, until) VALUES ('Old chat', 'Fall leaf cleanup ended November 1, 2026.', '2026-11-01')").run();
  const fresh = await freshFacts(e, 'Hiking Club Alerts', [
    { text: 'Hiking Club meets Saturdays at 8am at the north trailhead.', until: null },
    { text: 'The choir concert is April 17, 2027, in the chapel.', until: '2027-04-17' },
    { text: 'Choir concert: April 17, 2027, chapel!', until: '2027-04-17' },
  ]);
  assert.deepEqual(fresh.map((f) => f.text), ['The choir concert is April 17, 2027, in the chapel.']);

  await e.DB.prepare("INSERT INTO chat_facts (chat, text) VALUES ('Other chat', 'Hiking Club meets Saturdays at 8am at the north trailhead!')").run();
  assert.match(await tidyMemory(e), /1 expired facts, 1 repeated facts/);
  assert.deepEqual((await e.DB.prepare('SELECT chat FROM chat_facts').all()).results.map((r) => r.chat), ['Hiking Club']);
});
