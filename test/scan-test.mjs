// The full scan the user can ask for, against a fake GroupMe and a real SQLite copy of the schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { queueScan, pollGroups } from '../src/groupme.js';

// Just enough of Cloudflare D1 on top of node:sqlite.
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); }, raw: db };
}

test('a full scan reads every active chat once, skips old and muted ones, then says it is done', async () => {
  const now = Math.floor(Date.now() / 1000);
  const groups = [
    { id: 'A', name: 'Assistant', messages: { last_message_id: 'a1', last_message_created_at: now } },
    { id: 'S', name: 'Hiking Club', messages: { last_message_id: 's2', last_message_created_at: now - 60 } },
    { id: 'G', name: 'Orchestra', messages: { last_message_id: 'g1', last_message_created_at: now - 3600 } },
    { id: 'O', name: 'Old club', messages: { last_message_id: 'o1', last_message_created_at: now - 400 * 86400 } },
    { id: 'M', name: 'Muted chat', messages: { last_message_id: 'm1', last_message_created_at: now } },
  ];
  const opened = [];
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/v3', '');
    const ok = (response) => new Response(JSON.stringify({ response }), { status: 200 });
    if (path === '/bots' && !init.method) return ok([{ bot_id: 'bot1', group_id: 'A' }]);
    if (path === '/groups') return ok(groups);
    if (path === '/bots/post') { posted.push(JSON.parse(init.body).text); return new Response('', { status: 202 }); }
    const m = path.match(/^\/groups\/(\w+)\/messages$/);
    if (m) { opened.push(m[1]); return ok({ messages: [{ id: `${m[1]}x`, created_at: now - 100, name: 'Casey', text: 'lol same', sender_type: 'user' }] }); }
    throw new Error(`unexpected ${url}`);
  };
  const env = { DB: d1(), GROUPME_TOKEN: 't', GROUPME_BOT_ID: 'bot1', TIMEZONE: 'America/New_York', NAME: 'Alex' };
  await env.DB.prepare("INSERT INTO chats (name, muted) VALUES ('Muted chat', 1)").run();
  // Both active chats were already read before, so a normal minute check would open neither.
  await env.DB.prepare("INSERT INTO state (key, value) VALUES ('gm_seen', ?)").bind(JSON.stringify({ S: 's2', G: 'g1', A: 'a1' })).run();

  const q = await queueScan(env);
  assert.equal(q.queued, 2); // not the Assistant chat, not the old one, not the muted one

  await pollGroups(env);
  assert.deepEqual(opened.sort(), ['G', 'S']); // read again in full even though nothing is new
  assert.equal(posted.length, 1);
  assert.match(posted[0], /Scan done! I went through 2 chats.*Nothing new/);
  assert.equal(await env.DB.prepare("SELECT value FROM state WHERE key = 'gm_rescan'").first(), null);

  opened.length = 0;
  await pollGroups(env); // nothing queued and nothing new: no chat opened, nothing sent
  assert.deepEqual(opened, []);
  assert.equal(posted.length, 1);
});

import { learnChats } from '../src/groupme.js';

test('learning from chats keeps lasting facts per chat, fills in what a chat is, and can run again', async () => {
  const now = Math.floor(Date.now() / 1000);
  const groups = [
    { id: 'A', name: 'Assistant', messages: { last_message_id: 'a1', last_message_created_at: now } },
    { id: 'S', name: 'Hiking Club', messages: { last_message_id: 's9', last_message_created_at: now } },
    { id: 'N', name: 'Board Games', messages: { last_message_id: 'n9', last_message_created_at: now } },
    { id: 'O', name: 'Old club', messages: { last_message_id: 'o1', last_message_created_at: now - 400 * 86400 } },
  ];
  const asked = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url.includes('openrouter.ai')) {
      const chat = JSON.parse(init.body).messages[0].content.match(/chats, "([^"]+)"/)[1];
      asked.push(chat);
      const out = chat === 'Hiking Club'
        ? { about: 'an outdoors group', facts: ['Hiking Club hikes leave from the north trailhead on Saturday mornings.', 'Hiking Club keeps its gear list in the pinned post.'] }
        : { about: 'a board game group', facts: ['Board game night rotates between the dorm lounges.'] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(out) } }] });
    }
    const path = new URL(url).pathname.replace('/v3', '');
    const ok = (response) => new Response(JSON.stringify({ response }), { status: 200 });
    if (path === '/bots') return ok([{ bot_id: 'bot1', group_id: 'A' }]);
    if (path === '/groups') return ok(groups);
    const m = path.match(/^\/groups\/(\w+)\/messages$/);
    if (m) return ok({ messages: [{ id: `${m[1]}1`, created_at: now - 100, name: 'Kit', text: 'trail map is pinned above', sender_type: 'user' }] });
    throw new Error(`unexpected ${url}`);
  };
  const env = { DB: d1(), GROUPME_TOKEN: 't', GROUPME_BOT_ID: 'bot1', TIMEZONE: 'America/New_York', NAME: 'Alex', EXTRACT_MODEL: 'm', OPENROUTER_API_KEY: 'k' };
  await env.DB.prepare("INSERT INTO chats (name, about) VALUES ('Hiking Club', 'the hiking club')").run();

  assert.match(await learnChats(env), /^2 chats read .*, 0 left$/);
  assert.deepEqual(asked.sort(), ['Board Games', 'Hiking Club']); // not the Assistant chat or the old one
  const facts = (await env.DB.prepare('SELECT chat, text FROM chat_facts ORDER BY id').all()).results;
  assert.equal(facts.length, 3);
  const about = Object.fromEntries((await env.DB.prepare('SELECT name, about FROM chats').all()).results.map((r) => [r.name, r.about]));
  assert.equal(about['Hiking Club'], 'the hiking club'); // what the user said is kept
  assert.equal(about['Board Games'], 'a board game group');

  assert.match(await learnChats(env), /^0 chats read, 0 left$/); // nothing new since
  await env.DB.prepare("DELETE FROM state WHERE key = 'chats_learned'").run(); // what /run?job=relearn does
  assert.match(await learnChats(env), /^2 chats read/);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM chat_facts').first()).n, 3); // replaced, not doubled
});

import { searchChats } from '../src/groupme.js';

test('chat search finds a person or words in the SEARCH_CHATS chats by default, or the most active ones', async () => {
  const now = Math.floor(Date.now() / 1000);
  const groups = [
    { id: 'G', name: 'Orchestra' }, { id: 'L', name: 'Hiking Club' },
    { id: 'P', name: 'Hiking Club Alerts' }, { id: 'X', name: 'Weekend crew' },
    { id: 'A', name: 'Assistant' },
  ];
  const msgs = {
    G: [{ id: 'g2', created_at: now - 3600, name: 'Theo Park', text: 'Seating chart for the spring concert is up' },
      { id: 'g1', created_at: now - 7200, name: 'Ines Ruiz', text: 'Sectionals moved to the band room' }],
    L: [{ id: 'l1', created_at: now - 600, name: 'Kit', text: 'bring rain jackets this weekend' }],
    P: [{ id: 'p1', created_at: now - 300 * 86400, name: 'Theo Old', text: 'way too old' }],
    X: [{ id: 'x1', created_at: now - 60, name: 'Theo', text: 'not searched by default' }],
  };
  const opened = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname.replace('/v3', '');
    const ok = (response) => new Response(JSON.stringify({ response }), { status: 200 });
    if (path === '/groups') return ok(groups);
    if (path === '/bots') return ok([{ bot_id: 'bot1', group_id: 'A' }]);
    const m = path.match(/^\/groups\/(\w+)\/messages$/);
    opened.push(m[1]);
    return ok({ messages: msgs[m[1]] });
  };
  const env = { GROUPME_TOKEN: 't', TIMEZONE: 'America/New_York', SEARCH_CHATS: 'Orchestra|Hiking', GROUPME_BOT_ID: 'bot1' };
  const r = await searchChats(env, { person: 'theo' });
  assert.deepEqual(opened.sort(), ['G', 'L', 'P']);
  assert.equal(r.found, 1);
  assert.match(r.messages[0], /Orchestra, Theo Park: Seating chart for the spring concert/);
  const t = await searchChats(env, { words: 'rain jackets' });
  assert.match(t.messages[0], /Hiking Club, Kit: bring rain jackets/);
  const one = await searchChats(env, { group: 'weekend', person: 'theo' });
  assert.deepEqual(one.searched, ['Weekend crew']);
  assert.equal(one.found, 1);
  const any = await searchChats({ ...env, SEARCH_CHATS: '' }, { person: 'theo' }); // no pattern: recent chats, not the Assistant chat
  assert.equal(any.searched.length, 4);
  assert.ok(!any.searched.includes('Assistant'));
  assert.equal(any.found, 2);
});

import { learnAfterScan } from '../src/groupme.js';

test('after a full scan, memory is refreshed behind the scenes, 3 chats a run, then it stops', async () => {
  const now = Math.floor(Date.now() / 1000);
  const groups = [{ id: 'A', name: 'Assistant', messages: { last_message_id: 'a1', last_message_created_at: now } },
    ...['S1', 'S2', 'S3', 'S4'].map((id) => ({ id, name: `Chat ${id}`, messages: { last_message_id: `${id}x`, last_message_created_at: now } }))];
  let learnedCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    if (url.includes('openrouter.ai')) { learnedCalls++; return Response.json({ choices: [{ message: { content: '{"about":"a chat","facts":["A fact."]}' } }] }); }
    const path = new URL(url).pathname.replace('/v3', '');
    const ok = (response) => new Response(JSON.stringify({ response }), { status: 200 });
    if (path === '/bots' && !init.method) return ok([{ bot_id: 'bot1', group_id: 'A' }]);
    if (path === '/bots/post') return new Response('', { status: 202 });
    if (path === '/groups') return ok(groups);
    const m = path.match(/^\/groups\/(\w+)\/messages$/);
    if (m) return ok({ messages: [{ id: `${m[1]}x`, created_at: now - 100, name: 'Robin', text: 'lol same', sender_type: 'user' }] });
    throw new Error(`unexpected ${url}`);
  };
  const env = { DB: d1(), GROUPME_TOKEN: 't', GROUPME_BOT_ID: 'bot1', TIMEZONE: 'America/New_York', NAME: 'Alex', EXTRACT_MODEL: 'm', OPENROUTER_API_KEY: 'k' };
  assert.equal(await learnAfterScan(env), 'nothing to refresh'); // no scan yet
  await queueScan(env);
  await pollGroups(env); // the scan reads all 4 and finishes
  assert.equal((await env.DB.prepare("SELECT value FROM state WHERE key = 'learn_pending'").first()).value, '1');
  assert.match(await learnAfterScan(env), /^3 chats read .*, 1 left$/);
  assert.match(await learnAfterScan(env), /^1 chats read .*, 0 left; memory tidied/);
  assert.equal(await learnAfterScan(env), 'nothing to refresh');
  assert.equal(learnedCalls, 4);
});
