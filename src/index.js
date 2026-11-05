import { syncCanvas, checkGrades, dueNudge } from './canvas.js';
import { pollGroups, sendToUser, assistantGroupId, checkGroupMe, queueScan, suggestEventsFrom, learnChats, learnAfterScan } from './groupme.js';
import { checkCalendar, addEvent, updateEvent, getEvent, deleteEvent, eventBody, toUtc } from './calendar.js';
import { runAgent, getState, setState, MORNING, WEEK, welcomeText } from './agent.js';
import { attachmentParts, filePart, imagePart } from './files.js';
import { sendReminders } from './reminders.js';
import { tidyMemory } from './memory.js';

// Three crons, each its own run, because the free plan allows 50 outside requests per run.
const JOBS = {
  '* * * * *': [['reminders', (env) => sendReminders(env)], ['GroupMe', (env) => pollGroups(env)]],
  '*/10 * * * *': [['Canvas', (env) => syncCanvas(env)], ['grades', (env) => checkGrades(env)], ['memory', (env) => learnAfterScan(env)]],
  '0 * * * *': [['daily check', (env) => dailyCheck(env)], ['morning brief', (env) => morning(env)], ['nudges', (env) => eveningNudge(env)]],
};

// Morning brief hour (0-23); the daily scan runs an hour before it unless SCAN_HOUR says otherwise.
const morningHour = (env) => (env.MORNING_HOUR === undefined || env.MORNING_HOUR === '' ? 7 : Number(env.MORNING_HOUR));
const scanHour = (env) => (env.SCAN_HOUR === undefined || env.SCAN_HOUR === '' ? (morningHour(env) + 23) % 24 : Number(env.SCAN_HOUR));

const localParts = (env) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: env.TIMEZONE, weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date()).map((p) => [p.type, p.value]));

// Once a day (SCAN_HOUR, an hour before the brief by default): a full read of the user's chats
// for anything that should go on the calendar, offered as a numbered list; nothing is added
// until the user says yes.
async function dailyCheck(env, force) {
  const parts = localParts(env);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (!force && (Number(parts.hour) !== scanHour(env) || (await getState(env, 'scan_date')) === today)) return 'not time yet';
  await setState(env, 'scan_date', today);
  const q = await queueScan(env, undefined, { daily: true });
  return `${q.queued} chats queued`;
}

// Once an evening at NUDGE_HOUR (8pm by default): online work due soon that isn't turned in.
async function eveningNudge(env, force) {
  const parts = localParts(env);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (!force && (Number(parts.hour) !== Number(env.NUDGE_HOUR || 20) || (await getState(env, 'nudge_date')) === today)) return 'not time yet';
  await setState(env, 'nudge_date', today);
  return dueNudge(env);
}

async function morning(env, force) {
  const parts = localParts(env);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (!force && (Number(parts.hour) !== morningHour(env) || (await getState(env, 'brief_date')) === today)) return 'not time yet';
  await setState(env, 'brief_date', today);
  await sendToUser(env, await runAgent(env, parts.weekday === 'Sun' ? WEEK : MORNING));
  return 'sent';
}

// A job that fails is told to the user in the Assistant chat, once a day per job.
async function guarded(env, name, job) {
  try {
    return await job(env);
  } catch (e) {
    console.error(name, e);
    const key = `error_told:${name}`;
    const today = new Date().toISOString().slice(0, 10);
    if ((await getState(env, key)) !== today) {
      await setState(env, key, today);
      await sendToUser(env, `Heads up: my ${name} job failed (${e.message}). I'll keep trying.`.slice(0, 900)).catch(() => {});
    }
    return `failed: ${e.message}`;
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Every link below is guarded by CALLBACK_KEY, so without it nothing answers.
    if (!env.CALLBACK_KEY) return new Response('CALLBACK_KEY is not set: npx wrangler secret put CALLBACK_KEY', { status: 503 });

    // GroupMe bot callback: every message in the Assistant group lands here.
    if (req.method === 'POST' && url.pathname === `/groupme/${env.CALLBACK_KEY}`) {
      const m = await req.json().catch(() => ({}));
      const attachments = (m.attachments || []).filter((a) => ['image', 'file', 'video'].includes(a.type));
      if (m.sender_type === 'user' && (m.text || attachments.length) && m.group_id === (await assistantGroupId(env))) {
        ctx.waitUntil((async () => {
          const { parts, note } = await attachmentParts(env, m.group_id, attachments);
          await sendToUser(env, await runAgent(env, [m.text, note].filter(Boolean).join(' '), undefined, parts));
        })().catch((e) => sendToUser(env, `Sorry, that failed on my side (${e.message}). Please try again in a minute.`)));
      }
      return new Response('ok');
    }

    // Test runs (POST, same key): nothing is sent to the user and nothing on the calendar or in
    // the database changes; the answer comes back with every tool call it made.
    //   /test/ask      {"text": "...", "turns": [{"role":"user","content":"..."}, ...]}
    //   /test/extract  {"chats": [{"group": "...", "about": "...", "msgs": [{"name":"Casey","text":"...","sent":"2026-11-04T10:00"}]}]}
    if (req.method === 'POST' && url.pathname.startsWith('/test/') && req.headers.get('authorization') === `Bearer ${env.CALLBACK_KEY}`) {
      const body = await req.json();
      const t = dry(env);
      try {
        if (url.pathname === '/test/ask') {
          // files: [{name, type, base64}] stand in for files the user sends; images: [url] for photos.
          const parts = [...await Promise.all((body.images || []).map(imagePart)),
            ...await Promise.all((body.files || []).map((f) => filePart({ name: f.name, type: f.type || '', bytes: Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) })))];
          // Without "turns" the real saved conversation is used, to test memory and continuity.
          return Response.json({ reply: await runAgent(t, body.text, body.turns, parts), trace: t.TRACE });
        }
        if (url.pathname === '/test/extract') {
          const chats = body.chats.map((c) => ({
            group: c.group, info: c.about ? { about: c.about } : undefined,
            msgs: c.msgs.map((m, i) => ({ id: String(i), name: m.name, text: m.text, isNew: true, created_at: Date.parse(toUtc(m.sent, env.TIMEZONE)) / 1000 })),
          }));
          return Response.json({ result: await suggestEventsFrom(t, chats), trace: t.TRACE });
        }
      } catch (e) {
        return Response.json({ error: e.message, trace: t.TRACE }, { status: 500 });
      }
    }

    // Manual runs for setup and testing: /run?job=check|selftest|canvas|grades|groupme|daily|morning|...
    if (url.pathname === '/run' && req.headers.get('authorization') === `Bearer ${env.CALLBACK_KEY}`) {
      const job = { welcome: sendWelcome, check: checkSetup, tidy: tidyMemory, nudge: (e) => eveningNudge(e, true), selftest: calendarSelfTest, reminders: sendReminders, learn: learnChats, relearn: async (e) => { await e.DB.prepare("DELETE FROM state WHERE key = 'chats_learned'").run(); return `${await learnChats(e)} (run job=learn until 0 left)`; }, canvas: syncCanvas, grades: checkGrades, groupme: pollGroups, daily: (e) => dailyCheck(e, true), morning: (e) => morning(e, true) }[url.searchParams.get('job')];
      return new Response(job ? await guarded(env, url.searchParams.get('job'), job) : 'job must be one of: check, selftest, welcome, canvas, grades, groupme, daily, morning, nudge, reminders, learn, relearn, tidy');
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Not set up yet (no GroupMe bot or iCloud password): stay quiet instead of failing every minute.
    if (!env.GROUPME_BOT_ID || !env.ICLOUD_APP_PASSWORD) return;
    // One after the other, so the run's requests are shared out and one failure doesn't stop the next.
    ctx.waitUntil((async () => { for (const [name, job] of JOBS[event.cron] || []) await guarded(env, name, job); })());
  },
};

// Setup check: reads GroupMe and the calendar, sends and changes nothing.
async function checkSetup(env) {
  const line = (p) => p.then((x) => x, (e) => `FAILED: ${e.message}`);
  return [await line(checkGroupMe(env)), env.ICLOUD_APP_PASSWORD ? await line(checkCalendar(env)) : 'iCloud: not set up yet'].join('\n');
}

// A copy of env for test runs: the database only reads, sends and calendar writes are recorded
// in TRACE instead of happening.
function dry(env) {
  const noop = { bind: () => noop, run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) };
  return {
    ...env, DRY: true, TRACE: [],
    DB: { prepare: (sql) => (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql) ? noop : env.DB.prepare(sql)), batch: async () => [] },
  };
}

// Live check of adding, moving and deleting on the calendar it writes to, with a test event a
// month out at 3am that is deleted at the end.
async function calendarSelfTest(env) {
  const tz = env.TIMEZONE;
  const day = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-CA', { timeZone: tz });
  const steps = [];
  const e = await addEvent(env, { ...eventBody({ title: 'assistant self-test (deleting)', start: `${day}T03:00` }, tz), source: 'assistant' });
  steps.push(`added ${e.id}`);
  try {
    await updateEvent(env, e.id, { title: 'assistant self-test moved', start: `${day}T03:30` });
    const moved = await getEvent(env, e.id);
    steps.push(`moved: "${moved.summary}" at ${new Date(moved.start.dateTime).toLocaleString('sv-SE', { timeZone: tz })}`);
  } finally {
    await deleteEvent(env, e.id);
    steps.push('deleted');
  }
  const gone = await getEvent(env, e.id).then(() => 'STILL THERE', (err) => (/no event/.test(err.message) ? 'confirmed gone' : err.message));
  steps.push(gone);
  return steps.join('; ');
}

// The guide to everything it can do, into the Assistant chat (and its history, so it knows the
// user has it).
async function sendWelcome(env) {
  const text = welcomeText(env);
  await sendToUser(env, text);
  await env.DB.prepare('INSERT INTO messages (role, content) VALUES (?, ?)').bind('assistant', text).run();
  return 'welcome guide sent';
}
