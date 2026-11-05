// Canvas -> the user's Apple calendar from the Canvas calendar feed (no token needed): exams and
// quizzes go on by themselves; any other assignment only when the user asks for it. With their
// access token (CANVAS_TOKEN) it also reads their classes and watches for new grades.
import { parseIcs, listEvents, insertOnce, replaceEvent, deleteEvent, eventId, addDays, dayLabel } from './calendar.js';
import { getState, setState, runAgent } from './agent.js';
import { sendToUser } from './groupme.js';

export { parseIcs };

// Exams and quizzes go on the calendar without asking.
export const isTest = (title) => /\b(exams?|quiz(zes)?|midterms?|tests?)\b/i.test(title || '');

export function canvasBody(item, tz) {
  const fill = (t) => (t.dateTime && !t.timeZone && !t.dateTime.endsWith('Z') ? { ...t, timeZone: tz } : t);
  const start = fill(item.start);
  let end = item.end ? fill(item.end) : start;
  if (start.date && !(end.date > start.date)) end = { date: addDays(start.date, 1) };
  return {
    summary: item.title || 'Canvas item',
    description: [item.url, item.description].filter(Boolean).join('\n\n').slice(0, 4000),
    start,
    end,
    source: 'canvas',
  };
}

async function digest(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sinceYesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// Canvas feed items from yesterday on.
export async function feedItems(env) {
  // Canvas answers 403 without a User-Agent.
  const r = await fetch(env.CANVAS_FEED_URL, { headers: { 'user-agent': 'dottie-ai-assistant/1.0' } });
  if (!r.ok) throw new Error(`Canvas feed answered ${r.status}`);
  const since = sinceYesterday();
  return parseIcs(await r.text()).filter((e) => (e.start.date || e.start.dateTime).slice(0, 10) >= since);
}

// Keeps what's on the calendar from Canvas up to date, adds new exams and quizzes, and takes off
// what Canvas dropped. Other assignments go on only when the user asks (add_assignment).
export async function syncCanvas(env) {
  if (!env.CANVAS_FEED_URL) return 'no CANVAS_FEED_URL';
  const since = sinceYesterday();
  const items = await feedItems(env);

  const existing = (await listEvents(env, `${since}T00:00:00Z`, undefined, { onlyMine: true })).filter((e) => e.source === 'canvas');
  const have = new Map(existing.map((e) => [e.id, e]));
  // Ids this sync has put on the calendar. One that is missing from the calendar now was
  // deleted by the user, so it is not added again.
  const added = new Set(JSON.parse((await getState(env, 'canvas_ids')) || '[]'));

  let writes = 0;
  for (const item of items) {
    const id = await eventId(`canvas:${item.uid}`);
    const body = canvasBody(item, env.TIMEZONE);
    body.h = await digest(JSON.stringify(body));
    const old = have.get(id);
    have.delete(id);
    if ((!old && added.has(id)) || old?.h === body.h) continue;
    if (!old && !isTest(item.title)) continue; // only when the user asks for it
    // ponytail: 20 writes per run keeps this and the grade check under the free plan's 50
    // requests; the rest go in the next run.
    if (writes >= 20) continue;
    if (old) await replaceEvent(env, id, body);
    else await insertOnce(env, id, body);
    added.add(id);
    writes++;
  }
  // Still on the calendar but gone from Canvas (assignment removed): take it off.
  for (const old of have.values()) {
    if (writes >= 20) break;
    await deleteEvent(env, old.id, { allowRepeating: true });
    added.delete(old.id);
    writes++;
  }
  await setState(env, 'canvas_ids', JSON.stringify([...added]));
  return `${items.length} Canvas items, ${writes} calendar changes`;
}

// ---- Canvas API, read only (CANVAS_TOKEN, the user's own access token) ----
// Only GET requests are ever made, and the token only goes to the school's Canvas, so nothing
// can be submitted, posted or sent from here.

const canvasBase = (env) => new URL(env.CANVAS_FEED_URL).origin;

export function canvasPath(path) {
  if (typeof path !== 'string' || !/^\/[\w/?=&[\].,%:+@-]*$/.test(path) || path.includes('..')) throw new Error(`not a Canvas API path: ${path}`);
  return path;
}

async function api(env, path) {
  if (!env.CANVAS_TOKEN) throw new Error('Canvas is not connected yet (no CANVAS_TOKEN): add it with npx wrangler secret put CANVAS_TOKEN');
  const base = canvasBase(env);
  let url = `${base}/api/v1${canvasPath(path)}`;
  const out = [];
  for (let page = 0; page < 5 && url; page++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${env.CANVAS_TOKEN}`, accept: 'application/json', 'user-agent': 'dottie-ai-assistant/1.0 (read only)' } });
    if (!r.ok) throw new Error(`Canvas ${r.status} on ${path.split('?')[0]}: ${(await r.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
    const data = await r.json();
    if (!Array.isArray(data)) return data;
    out.push(...data);
    const next = (r.headers.get('link') || '').split(',').find((p) => p.includes('rel="next"'));
    url = next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null;
    if (url && !url.startsWith(`${base}/`)) url = null; // the token only ever goes to Canvas itself
  }
  return out;
}

// Canvas text is HTML: keep the words, line breaks and link targets.
export function htmlText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>|<\/(p|div|h\d|tr|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// The course and assignment ids in a Canvas link, e.g. a calendar event's feed link.
export function canvasIds(text) {
  const course = String(text || '').match(/course[s_/](\d+)/);
  const assignment = String(text || '').match(/assignment[s_/](\d+)/);
  return course ? { course_id: Number(course[1]), ...(assignment ? { assignment_id: Number(assignment[1]) } : {}) } : null;
}

const due = (iso, tz) => (iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16) : null);

function gradeOf(c) {
  const e = (c.enrollments || []).find((x) => x.type === 'student') || (c.enrollments || [])[0] || {};
  if (e.computed_current_score == null && !e.computed_current_grade) return 'no grade yet';
  return `${e.computed_current_score != null ? `${e.computed_current_score}%` : ''}${e.computed_current_grade ? ` (${e.computed_current_grade})` : ''}`.trim();
}

// Where the submission stands. In-class work and work done in an outside tool (a publisher's
// homework site, say) never shows as submitted in Canvas, so it isn't called missing.
export function status(s, types = []) {
  if (s?.excused) return 'excused';
  if (s?.workflow_state === 'graded' && s.score != null) return `graded ${s.score}${s.late ? ' (late)' : ''}`;
  if (types.some((t) => t === 'on_paper' || t === 'none' || t === 'not_graded')) return 'done in class or on paper (Canvas does not track it)';
  if (types.includes('external_tool') && !s?.submitted_at) return 'done in an outside site (Canvas cannot tell if it was submitted)';
  if (!s) return 'unknown';
  if (s.workflow_state === 'graded' && s.score != null) return `graded ${s.score}${s.late ? ' (late)' : ''}`;
  if (s.submitted_at) return `submitted${s.late ? ' late' : ''}`;
  return s.missing ? 'missing' : 'not submitted';
}

const activeCourses = async (env) =>
  (await api(env, '/courses?enrollment_state=active&include[]=total_scores&per_page=50')).filter((c) => c?.name && !c.access_restricted_by_date);
// Some schools put a section code in the course "name" and the title in course_code: show both.
const className = (c) => (c.course_code && c.course_code !== c.name ? `${c.course_code} (${c.name})` : c.name);

export async function canvasClasses(env) {
  return (await activeCourses(env)).map((c) => ({ course_id: c.id, name: className(c), grade: gradeOf(c) }));
}

// Assignments in all the user's classes (or one), by name and/or due within the next `days` days.
export async function canvasAssignments(env, { search, course_id, days } = {}) {
  const courses = course_id ? [{ id: course_id, name: '' }] : await activeCourses(env);
  const now = Date.now();
  const window = days || !search; // a name search alone looks at the whole term
  const until = now + (days || 14) * 86400000;
  const q = search ? `&search_term=${encodeURIComponent(search)}` : '';
  const lists = await Promise.all(courses.map(async (c) =>
    (await api(env, `/courses/${c.id}/assignments?include[]=submission&order_by=due_at&per_page=100${q}`)).map((a) => ({ c, a }))));
  return lists.flat()
    .filter(({ a }) => !window || (a.due_at && Date.parse(a.due_at) >= now - 86400000 && Date.parse(a.due_at) <= until))
    .slice(0, 40)
    .map(({ c, a }) => ({
      course: c.name ? className(c) : undefined, course_id: a.course_id, assignment_id: a.id, name: a.name,
      due: due(a.due_at, env.TIMEZONE), day: dayLabel(due(a.due_at, env.TIMEZONE)),
      points: a.points_possible, status: status(a.submission, a.submission_types), url: a.html_url,
    }));
}

// One assignment in full: instructions, rubric, dates and where the submission stands.
export async function canvasAssignment(env, course_id, assignment_id) {
  const a = await api(env, `/courses/${Number(course_id)}/assignments/${Number(assignment_id)}?include[]=submission`);
  return {
    name: a.name, due: due(a.due_at, env.TIMEZONE), day: dayLabel(due(a.due_at, env.TIMEZONE)), available_from: due(a.unlock_at, env.TIMEZONE), closes: due(a.lock_at, env.TIMEZONE),
    points: a.points_possible, submit_as: a.submission_types, status: status(a.submission, a.submission_types),
    grade: a.submission?.grade ?? null, url: a.html_url,
    instructions: htmlText(a.description).slice(0, 6000) || '(no instructions written in Canvas; there may be an attached file)',
    rubric: (a.rubric || []).map((r) => `${r.description} (${r.points} pts)${r.long_description ? `: ${htmlText(r.long_description)}` : ''}`).join('\n').slice(0, 3000) || undefined,
  };
}

// Anything else the user asks about (announcements, modules, pages, syllabus, discussions, files),
// read only. HTML in the answer is turned into text.
export async function canvasGet(env, path) {
  const tidy = (v) => (typeof v === 'string' && /<[a-z][\s\S]*>/i.test(v) ? htmlText(v)
    : Array.isArray(v) ? v.map(tidy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)])) : v);
  return JSON.stringify(tidy(await api(env, path))).slice(0, 8000);
}

// ---- Grades ----
// Every 10 minutes: grades that were published since the last look go into the grades table, so
// the assistant knows them; a new exam or quiz grade is also told to the user right away. The first
// look only records what is already there.
export async function checkGrades(env) {
  if (!env.CANVAS_TOKEN) return 'no CANVAS_TOKEN';
  const known = new Map((await env.DB.prepare('SELECT assignment_id, score FROM grades').all()).results.map((r) => [r.assignment_id, r.score]));
  const fresh = [];
  for (const c of await activeCourses(env)) {
    for (const a of await api(env, `/courses/${c.id}/assignments?include[]=submission&include[]=score_statistics&per_page=100`)) {
      const s = a.submission;
      if (!s || s.score == null || s.excused || known.get(a.id) === s.score) continue;
      fresh.push({
        assignment_id: a.id, course_id: c.id, course: className(c), name: a.name, score: s.score, points: a.points_possible ?? null,
        grade: s.grade ?? null, mean: a.score_statistics?.mean ?? null,
        test: isTest(a.name) || (a.submission_types || []).includes('online_quiz') || Boolean(a.is_quiz_assignment),
      });
    }
  }
  if (fresh.length) {
    await env.DB.batch(fresh.map((g) => env.DB.prepare(`INSERT INTO grades (assignment_id, course_id, course, name, score, points, grade, mean, test)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(assignment_id) DO UPDATE SET score = excluded.score, grade = excluded.grade,
      mean = excluded.mean, graded_seen_at = CURRENT_TIMESTAMP`)
      .bind(g.assignment_id, g.course_id, g.course, g.name, g.score, g.points, g.grade, g.mean, g.test ? 1 : 0)));
  }
  if (!(await getState(env, 'grades_seeded'))) {
    await setState(env, 'grades_seeded', new Date().toISOString());
    return `${fresh.length} grades on record (first look: nothing sent)`;
  }
  const tests = fresh.filter((g) => g.test);
  if (tests.length) await sendToUser(env, await runAgent(env, gradeNews(tests)));
  return `${fresh.length} new grades, ${tests.length} exam or quiz grades told`;
}

export const gradeLine = (g) => {
  const pct = g.points ? Math.round((g.score / g.points) * 1000) / 10 : null;
  const avg = g.mean != null && g.points ? `, class average ${Math.round((g.mean / g.points) * 1000) / 10}%` : '';
  return `${g.name} (${g.course}): ${g.score}${g.points ? `/${g.points}` : ''}${pct != null ? ` = ${pct}%` : ''}${g.grade && !/^[\d.]+$/.test(g.grade) ? ` (${g.grade})` : ''}${avg}`;
};

export const gradeNews = (tests) =>
  `Automatic: ${tests.length > 1 ? 'grades were' : 'a grade was'} just published on Canvas:\n${tests.map(gradeLine).join('\n')}\n` +
  'Give me the result in a sentence or two. A strong result (about 85% or more, or well above the class average): celebrate it. ' +
  'A weak one (under about 70%, or well below the average): comfort me kindly, put it in perspective, and offer to help me prepare for the next one. ' +
  'Anything in between: be encouraging. Keep it brief.';

// ---- Nudges ----
// Once an evening (NUDGE_HOUR, 8pm by default): online work due in the next 30 hours that Canvas
// shows as not turned in. In-class, paper and outside-site work is never nudged (Canvas can't
// tell), and each assignment is nudged once.
export const ONLINE = ['online_upload', 'online_text_entry', 'online_url', 'online_quiz', 'media_recording', 'discussion_topic', 'student_annotation'];
export const needsNudge = (a, now) => {
  const s = a.submission || {};
  const dueAt = Date.parse(a.due_at || '');
  return dueAt > now && dueAt <= now + 30 * 3600000 && (a.submission_types || []).some((t) => ONLINE.includes(t))
    && !s.submitted_at && !s.excused && s.workflow_state !== 'graded' && s.workflow_state !== 'submitted';
};

export async function dueNudge(env) {
  if (!env.CANVAS_TOKEN) return 'no CANVAS_TOKEN';
  const now = Date.now();
  const told = new Set(JSON.parse((await getState(env, 'nudged')) || '[]'));
  const due = [];
  for (const c of await activeCourses(env)) {
    for (const a of await api(env, `/courses/${c.id}/assignments?include[]=submission&bucket=future&per_page=100`)) {
      if (needsNudge(a, now) && !told.has(a.id)) due.push({ id: a.id, line: `- ${a.name} (${c.course_code || c.name}), due ${dayLabel(due0(a.due_at, env.TIMEZONE))} at ${due0(a.due_at, env.TIMEZONE).slice(11, 16)}` });
    }
  }
  if (!due.length) return 'nothing to nudge';
  await sendToUser(env, `Due soon and not turned in yet, according to Canvas:\n${due.map((d) => d.line).join('\n')}\nAlready handed in somewhere else? Then you can skip this.`);
  await setState(env, 'nudged', JSON.stringify([...told, ...due.map((d) => d.id)].slice(-300)));
  return `${due.length} nudged`;
}
const due0 = (iso, tz) => new Date(iso).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T').slice(0, 16);
