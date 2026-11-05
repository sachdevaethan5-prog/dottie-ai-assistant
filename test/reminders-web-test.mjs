// Reminders (times, repeating, sending) and the web tools, against fakes: no network, no cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { nextTime, addReminder, listReminders, cancelReminder, sendReminders } from '../src/reminders.js';
import { webSearch, webRead } from '../src/web.js';

const tz = 'America/New_York';

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); } };
}

test('repeating reminders keep their local time, across daylight saving too', () => {
  // Sat Oct 31 2026 8pm EDT -> Sat Nov 7 8pm EST (clocks went back on Nov 1).
  assert.equal(nextTime('2026-11-01T00:00:00.000Z', 'week', tz), '2026-11-08T01:00:00.000Z');
  assert.equal(nextTime('2026-11-06T14:00:00.000Z', 'weekday', tz), '2026-11-09T14:00:00.000Z'); // Fri 9am -> Mon 9am
  assert.equal(nextTime('2026-11-04T14:00:00.000Z', 'day', tz), '2026-11-05T14:00:00.000Z');
  assert.equal(nextTime('2026-11-04T14:00:00.000Z', 'month', tz), '2026-12-04T14:00:00.000Z');
});

test('reminders: set, listed in local time, refused in the past, cancelled', async () => {
  const env = { DB: d1(), TIMEZONE: tz };
  const soon = new Date(Date.now() + 3 * 86400000).toLocaleDateString('en-CA', { timeZone: tz });
  assert.match(await addReminder(env, { text: 'water the plants', at: `${soon}T17:00` }), /^reminder 1 set: "water the plants", \w{3} \w{3} \d+ at 17:00$/);
  assert.match(await addReminder(env, { text: 'plan the week', at: `${soon}T20:00`, every: 'week' }), /then every week/);
  assert.match(await addReminder(env, { text: 'too late', at: '2020-01-01T09:00' }), /already passed/);
  assert.match(await addReminder(env, { text: 'x', at: `${soon}T09:00`, every: 'hourly' }), /must be one of/);
  const list = await listReminders(env);
  assert.deepEqual(list.map((r) => [r.id, r.text, r.at]), [[1, 'water the plants', `${soon}T17:00`], [2, 'plan the week', `${soon}T20:00`]]);
  assert.equal(await cancelReminder(env, 1), 'reminder 1 cancelled');
  assert.equal(await cancelReminder(env, 1), 'no active reminder 1');
});

test('due reminders are sent once; repeating ones move on to their next time', async () => {
  const env = { DB: d1(), TIMEZONE: tz, GROUPME_TOKEN: 't', GROUPME_BOT_ID: 'b' };
  const posted = [];
  globalThis.fetch = async (url, init) => { posted.push(JSON.parse(init.body).text); return new Response('', { status: 202 }); };
  const past = new Date(Date.now() - 60000).toISOString();
  await env.DB.prepare("INSERT INTO reminders (text, at) VALUES ('charge headphones', ?)").bind(past).run();
  await env.DB.prepare("INSERT INTO reminders (text, at, every) VALUES ('plan the week', ?, 'week')").bind(past).run();
  await env.DB.prepare("INSERT INTO reminders (text, at) VALUES ('later thing', ?)").bind(new Date(Date.now() + 3600000).toISOString()).run();

  assert.equal(await sendReminders(env), '2 reminders sent');
  assert.deepEqual(posted, ['⏰ Reminder: charge headphones', '⏰ Reminder: plan the week']);
  const rows = (await env.DB.prepare('SELECT text, at, status FROM reminders ORDER BY id').all()).results;
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[1].status, 'active');
  assert.ok(Date.parse(rows[1].at) > Date.now() + 6 * 86400000); // next week
  assert.equal(await sendReminders(env), '0 reminders sent'); // nothing twice
});

test('web search returns the answer with its sources and stops at the daily cap', async () => {
  const env = { DB: d1(), TIMEZONE: tz, MODEL: 'm', OPENROUTER_API_KEY: 'k', WEB_SEARCHES_PER_DAY: '2' };
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: 'The pool opens at 6am on weekdays.', annotations: [
      { type: 'url_citation', url_citation: { url: 'https://example.org/pool/schedule', title: 'Pool Schedule' } },
      { type: 'url_citation', url_citation: { url: 'https://example.org/pool/schedule', title: 'Pool Schedule' } }] } }] });
  };
  const r = await webSearch(env, 'city pool opening time weekdays');
  assert.deepEqual(sent.plugins, [{ id: 'web', engine: 'exa', max_results: 5 }]);
  assert.deepEqual(r, { answer: 'The pool opens at 6am on weekdays.', sources: ['Pool Schedule: https://example.org/pool/schedule'] });
  await webSearch(env, 'again');
  assert.match(await webSearch(env, 'third'), /Daily web search limit reached \(2\)/);
});

test('reading a link gives the page text; other links are refused politely', async () => {
  globalThis.fetch = async () => new Response('<html><head><title>Plant sale</title></head><body><nav>menu</nav><p>Succulents are <b>2 for $9</b></p><footer>x</footer></body></html>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } });
  assert.deepEqual(await webRead({}, 'https://example.org/plants'), { title: 'Plant sale', text: 'Succulents are 2 for $9' });
  assert.match(await webRead({}, 'file:///etc/passwd'), /Only http and https/);
  assert.match(await webRead({}, 'not a link'), /not a web link/);
});
