// Canvas API tools against a fake Canvas: read only, token only to the school, HTML made readable.
// Every course, assignment and score here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlText, canvasIds, canvasPath, canvasAssignment, canvasAssignments, canvasGet } from '../src/canvas.js';

const env = { CANVAS_TOKEN: 'tok', CANVAS_FEED_URL: 'https://canvas.example.edu/feeds/calendars/user_x.ics', TIMEZONE: 'America/New_York' };

test('Canvas HTML becomes plain text with links kept', () => {
  assert.equal(htmlText('<p>Watch <a href="https://x.edu/talk.mp4">the talk</a>&nbsp;&amp; reply:</p><ul><li>Part A</li><li>Part B</li></ul>'),
    'Watch the talk (https://x.edu/talk.mp4) & reply:\n\n- Part A\n- Part B');
});

test('calendar feed links give the course and assignment', () => {
  assert.deepEqual(canvasIds('https://canvas.example.edu/calendar?include_contexts=course_88&month=2&year=2027#assignment_901'), { course_id: 88, assignment_id: 901 });
  assert.equal(canvasIds('no link here'), null);
});

test('only Canvas API paths are allowed', () => {
  assert.equal(canvasPath('/courses/1/modules?include[]=items'), '/courses/1/modules?include[]=items');
  for (const bad of ['courses/1', '/../users/self', 'https://evil.example/x', '/courses/1 2', 7]) assert.throws(() => canvasPath(bad));
});

test('reads are GET only, with the token sent to Canvas and nowhere else', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.authorization });
    if (url.includes('/assignments/901')) {
      return Response.json({ name: 'Field Report', due_at: '2027-02-18T04:59:00Z', points_possible: 50, submission_types: ['online_upload'],
        description: '<p>Three photos, one page.</p>', rubric: [{ description: 'Observations', points: 15, long_description: '<b>Specific</b> details' }],
        submission: { workflow_state: 'unsubmitted', missing: false }, html_url: 'https://canvas.example.edu/courses/88/assignments/901' });
    }
    if (url.includes('/courses?')) return Response.json([{ id: 88, name: 'Geology 105', enrollments: [] }]);
    // Page 1 of assignments points page 2 at another site: it must not be followed.
    return Response.json([{ id: 901, course_id: 88, name: 'Field Report', due_at: new Date(Date.now() + 3 * 86400000).toISOString(), submission: null }],
      { headers: { link: '<https://evil.example/api/v1/next>; rel="next"' } });
  };

  const a = await canvasAssignment(env, 88, 901);
  assert.equal(a.due, '2027-02-17T23:59');
  assert.equal(a.instructions, 'Three photos, one page.');
  assert.equal(a.rubric, 'Observations (15 pts): Specific details');
  assert.equal(a.status, 'not submitted');

  const found = await canvasAssignments(env, { search: 'field' });
  assert.equal(found[0].assignment_id, 901);
  assert.match(await canvasGet(env, '/courses/88/assignments/901'), /Three photos, one page\./);

  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.ok(calls.every((c) => c.url.startsWith('https://canvas.example.edu/api/v1/') && c.auth === 'Bearer tok'));
});

test('without a token it says Canvas is not connected', async () => {
  await assert.rejects(canvasAssignment({ ...env, CANVAS_TOKEN: '' }, 1, 2), /not connected/);
});

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isTest, checkGrades, gradeLine, gradeNews } from '../src/canvas.js';
import { scanDoneText } from '../src/groupme.js';

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } };
}

test('exams and quizzes are told apart from homework by name', () => {
  for (const t of ['Final Exam', 'Pop quiz: rocks and minerals', 'Quizzes for week 3', 'Midterms', 'Practice test'])
    assert.equal(isTest(t), true, t);
  for (const t of ['Field journal entry', 'Group slide deck', 'Peer review', 'Contestant bios', 'Office visit'])
    assert.equal(isTest(t), false, t);
});

test('grades: the first look only records, later ones are recorded and homework is not announced', async () => {
  let hwScore = 8;
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url.includes('/bots/post')) { posted.push(init.body); return new Response('', { status: 202 }); }
    if (url.includes('/courses?')) return Response.json([{ id: 1, name: 'Geology 105', enrollments: [] }]);
    return Response.json([
      { id: 30, name: 'Exam 1', points_possible: 40, submission: { score: 37, workflow_state: 'graded' }, score_statistics: { mean: 30.2 } },
      { id: 31, name: 'Map exercise', points_possible: 10, submission: { score: hwScore, workflow_state: 'graded' } },
      { id: 32, name: 'Field journal', points_possible: 10, submission: { score: null, workflow_state: 'unsubmitted' } },
    ]);
  };
  const genv = { ...env, DB: d1(), GROUPME_TOKEN: 't', GROUPME_BOT_ID: 'b' };
  assert.match(await checkGrades(genv), /^2 grades on record \(first look/);
  assert.equal(posted.length, 0);
  assert.match(await checkGrades(genv), /^0 new grades/); // nothing changed
  hwScore = 10; // the teacher regraded the exercise
  assert.match(await checkGrades(genv), /^1 new grades, 0 exam or quiz grades told/);
  assert.equal(posted.length, 0);
  assert.equal((await genv.DB.prepare('SELECT score FROM grades WHERE assignment_id = 31').first()).score, 10);
});

test('grade news gives score, percent and class average, and asks to cheer or comfort', () => {
  const g = { name: 'Exam 1', course: 'Geology 105', score: 37, points: 40, grade: '92.5', mean: 30.2 };
  assert.equal(gradeLine(g), 'Exam 1 (Geology 105): 37/40 = 92.5%, class average 75.5%');
  assert.match(gradeNews([g]), /celebrate.*comfort/s);
});

test('the daily check says how it went', () => {
  assert.match(scanDoneText({ total: 5, found: 0, daily: true }), /^Daily check done! I went through 5 chats.*Nothing new/);
  assert.match(scanDoneText({ total: 5, found: 1, daily: true }), /Found 1 new plan\./);
});
