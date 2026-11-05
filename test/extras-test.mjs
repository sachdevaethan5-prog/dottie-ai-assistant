// Nudges, weather, the chat catch-up and job failure alerts, against fakes: no network, no cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { needsNudge } from '../src/canvas.js';
import { weatherSummary } from '../src/web.js';
import { recentChats } from '../src/groupme.js';
import worker from '../src/index.js';

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

test('nudges only for online work due within 30 hours that is not turned in', () => {
  const now = Date.parse('2027-02-10T01:00:00Z'); // Tue Feb 9, 8pm Eastern
  const due = (h) => new Date(now + h * 3600000).toISOString();
  const a = (over) => ({ due_at: due(27), submission_types: ['online_upload'], submission: { workflow_state: 'unsubmitted' }, ...over });
  assert.equal(needsNudge(a(), now), true);
  assert.equal(needsNudge(a({ due_at: due(40) }), now), false); // not tomorrow
  assert.equal(needsNudge(a({ due_at: due(-2) }), now), false); // already past
  assert.equal(needsNudge(a({ submission_types: ['on_paper'] }), now), false); // in class
  assert.equal(needsNudge(a({ submission_types: ['external_tool'] }), now), false); // an outside homework tool
  assert.equal(needsNudge(a({ submission: { submitted_at: '2027-02-09T18:00:00Z', workflow_state: 'submitted' } }), now), false);
});

test('weather sums up the day: sky, high and low, rain by part of day', () => {
  const hourly = { time: [], temperature_2m: [], precipitation_probability: [] };
  for (let h = 0; h < 24; h++) {
    hourly.time.push(`2027-02-16T${String(h).padStart(2, '0')}:00`);
    hourly.temperature_2m.push(40 + h);
    hourly.precipitation_probability.push(h >= 14 && h < 17 ? 70 : 5);
  }
  const s = weatherSummary({ daily: { time: ['2027-02-16'], weather_code: [61], temperature_2m_max: [61.4], temperature_2m_min: [39.6] }, hourly });
  assert.deepEqual(s, { date: '2027-02-16', sky: 'light rain', high_f: 61, low_f: 40, rain_chance: { morning: 5, afternoon: 70, evening: 5 }, temp_f: { '8am': 48, '3pm': 55, '9pm': 61 } });
});

test('the catch-up reads the busiest recent chats, not the Assistant chat or quiet ones', async () => {
  const now = Math.floor(Date.now() / 1000);
  const groups = [
    { id: 'A', name: 'Assistant', messages: { count: 999, last_message_created_at: now } },
    { id: 'L', name: 'Orchestra', messages: { count: 500, last_message_created_at: now - 600 } },
    { id: 'Q', name: 'Quiet club', messages: { count: 50, last_message_created_at: now - 5 * 86400 } },
  ];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname.replace('/v3', '');
    const ok = (response) => new Response(JSON.stringify({ response }), { status: 200 });
    if (path === '/bots') return ok([{ bot_id: 'b', group_id: 'A' }]);
    if (path === '/groups') return ok(groups);
    return ok({ messages: [{ id: 'm2', created_at: now - 600, name: 'Ines', text: 'concert black dress code on friday', sender_type: 'user' },
      { id: 'm1', created_at: now - 3 * 86400, name: 'Ines', text: 'old news', sender_type: 'user' }] });
  };
  const r = await recentChats({ DB: d1(), GROUPME_TOKEN: 't', GROUPME_BOT_ID: 'b', TIMEZONE: 'America/New_York' }, { hours: 24 });
  assert.equal(r.length, 1);
  assert.equal(r[0].chat, 'Orchestra');
  assert.deepEqual(r[0].messages.map((m) => m.replace(/^\[[^\]]+\] /, '')), ['Ines: concert black dress code on friday']);
});

test('a failed job is told to the user once a day, and the run links need the key', async () => {
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/bots/post')) { posted.push(JSON.parse(init.body).text); return new Response('', { status: 202 }); }
    return new Response('', { status: 500 }); // the Canvas feed is down
  };
  const env = { DB: d1(), GROUPME_TOKEN: 't', GROUPME_BOT_ID: 'b', CALLBACK_KEY: 'ck', CANVAS_FEED_URL: 'https://canvas.example.edu/feeds/x.ics', TIMEZONE: 'America/New_York' };
  const call = (path, key = 'ck') => worker.fetch(new Request(`https://x.dev${path}`, { headers: { authorization: `Bearer ${key}` } }), env, { waitUntil() {} });

  assert.match(await (await call('/run?job=canvas')).text(), /^failed: Canvas feed answered 500/);
  assert.deepEqual(posted, ["Heads up: my canvas job failed (Canvas feed answered 500). I'll keep trying."]);
  await call('/run?job=canvas');
  assert.equal(posted.length, 1); // once a day
  assert.equal((await call('/run?job=canvas', 'wrong')).status, 404);
  const open = await worker.fetch(new Request('https://x.dev/run?job=check', { headers: { authorization: 'Bearer undefined' } }), { ...env, CALLBACK_KEY: '' }, { waitUntil() {} });
  assert.equal(open.status, 503); // no key set: nothing answers
});
