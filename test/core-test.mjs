// Offline checks for the parts that are plain logic. Run: npm test
// Every name, chat, course and date here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, canvasBody } from '../src/canvas.js';
import { eventBody, eventId, toIcs, parseIcs as parseCal, tags, localTime, updateEvent, deleteEvent, insertOnce } from '../src/calendar.js';
import { toUtc, searchWords, rank, twinNote } from '../src/agent.js';
import { looksLikePlan, eventKey, suggestionText, markNew, sameEvent, slot, findDuplicate, cancelKey, scanDoneText, splitMessage, wrongWeekday } from '../src/groupme.js';

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:event-assignment-501',
  'DTSTART:20270218T045900Z',
  'DTEND:20270218T045900Z',
  'SUMMARY:Lab report\\, final copy [CHEM 110]',
  'DESCRIPTION:Two pages.\\nInclude your data table.',
  'URL;VALUE=URI:https://canvas.example.edu/courses/7/assignments/501',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:event-assignment-502',
  'DTSTART;VALUE=DATE:20270220',
  'SUMMARY:Vocabulary quiz with a very long title that the feed folds onto the n',
  ' ext line',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:event-calendar-event-31',
  'DTSTART;TZID=America/New_York:20270219T100000',
  'DTEND;TZID=America/New_York:20270219T110000',
  'SUMMARY:Help session',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('Canvas feed parses timed, all-day, folded and TZID events', () => {
  const [a, b, c] = parseIcs(ICS);
  assert.equal(a.title, 'Lab report, final copy [CHEM 110]');
  assert.equal(a.description, 'Two pages.\nInclude your data table.');
  assert.deepEqual(a.start, { dateTime: '2027-02-18T04:59:00Z' });
  assert.equal(b.title.endsWith('next line'), true);
  assert.deepEqual(b.start, { date: '2027-02-20' });
  assert.deepEqual(c.start, { dateTime: '2027-02-19T10:00:00', timeZone: 'America/New_York' });

  const allDay = canvasBody(b, 'America/New_York');
  assert.deepEqual(allDay.end, { date: '2027-02-21' }); // the all-day end is exclusive
  assert.match(canvasBody(a, 'America/New_York').description, /^https:\/\/canvas/);
});

test('event bodies: local times keep their time zone, missing end becomes one hour', () => {
  const e = eventBody({ title: 'Book swap', start: '2027-02-16T18:00' }, 'America/New_York');
  assert.deepEqual(e.start, { dateTime: '2027-02-16T18:00:00', timeZone: 'America/New_York' });
  assert.deepEqual(e.end, { dateTime: '2027-02-16T19:00:00', timeZone: 'America/New_York' });
  const d = eventBody({ title: 'Ski trip', start: '2027-02-16', all_day: true }, 'America/New_York');
  assert.deepEqual([d.start, d.end], [{ date: '2027-02-16' }, { date: '2027-02-17' }]);
});

test('local time to UTC handles daylight saving', () => {
  assert.equal(toUtc('2027-03-20T19:00', 'America/New_York'), '2027-03-20T23:00:00.000Z'); // EDT
  assert.equal(toUtc('2027-01-20', 'America/New_York'), '2027-01-20T05:00:00.000Z'); // EST
});

test('event ids are stable and use only URL-safe characters', async () => {
  const id = await eventId('canvas:xyz');
  assert.equal(id, await eventId('canvas:xyz'));
  assert.match(id, /^[0-9a-v]{32}$/);
});

test('only chats that mention a plan go to the model', () => {
  assert.equal(looksLikePlan({ text: 'meetup friday at 6pm by the fountain' }), true);
  assert.equal(looksLikePlan({ text: 'haha true' }), false);
  assert.equal(looksLikePlan({ text: '', event: { type: 'calendar.event.created' } }), true);
});

test('a GroupMe event is suggested once, however the title is punctuated', () => {
  assert.equal(eventKey({ title: 'Garden Club work day!', start: '2027-02-20T10:00' }),
    eventKey({ title: 'garden club Work Day', start: '2027-02-20T09:30' }));
  assert.notEqual(eventKey({ title: 'Rehearsal', start: '2027-02-20T10:00' }), eventKey({ title: 'Rehearsal', start: '2027-02-21T10:00' }));
});

test('the question the user gets lists number, title, day, time, place, chat and quote', () => {
  const text = suggestionText([
    { id: 21, title: 'Garden Club work day', start: '2027-02-20T10:00', all_day: 0, location: 'Greenhouse', grp: 'Garden Club', quote: 'work day sat 10 at the greenhouse' },
    { id: 22, title: 'Seed order deadline', start: '2027-02-23', all_day: 1, location: null, grp: 'Garden Club', quote: '' },
  ]);
  assert.equal(text, '21. Garden Club work day, Sat, Feb 20, 10:00 AM, Greenhouse (Garden Club): "work day sat 10 at the greenhouse"\n22. Seed order deadline, Tue, Feb 23 (Garden Club)');
});

test('memory search drops filler words and ranks rows that match more words first', () => {
  const words = searchWords('When is Theo birthday? Do you remember?');
  assert.deepEqual(words, ['theo', 'birthday']);
  const rows = [
    { id: 1, text: 'Theo lives down the hall' },
    { id: 2, text: "Theo's birthday is August 9" },
    { id: 3, text: 'Volunteers at the animal shelter' },
    { id: 4, text: 'Grandpa birthday in October' },
  ];
  assert.deepEqual(rank(rows, words, 'text').map((r) => r.id), [2, 4, 1]);
});

test('plan words count only as whole words', () => {
  for (const t of ['rehearsal tmrw', 'GBM thursday', 'game saturday night', 'event got cancelled', 'due Mar 3'])
    assert.equal(looksLikePlan({ text: t }), true, t);
  for (const t of ['need money lol', 'that monster energy', 'satisfied', 'sunburn is real'])
    assert.equal(looksLikePlan({ text: t }), false, t);
});

test('only messages after the last one seen are new', () => {
  const msgs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(markNew(msgs, 'b').map((m) => m.isNew), [false, false, true]);
  assert.deepEqual(markNew(msgs, 'c').map((m) => m.isNew), [false, false, false]);
  assert.deepEqual(markNew(msgs, undefined).map((m) => m.isNew), [true, true, true]); // first look
  assert.deepEqual(markNew(msgs, 'old').map((m) => m.isNew), [true, true, true]); // more than 25 new
});

test('events written for iCloud read back the same, deadlines have no end, alarms are skipped', () => {
  const tz = 'America/New_York';
  const swap = toIcs('abc123', { ...eventBody({ title: 'Book swap; bring 2 books', start: '2027-02-16T19:00', location: 'Cafe, 2nd floor' }, tz), source: 'groupme' }, tz);
  assert.match(swap, /DTSTART:20270217T000000Z\r\n/); // 7pm EST = midnight UTC
  const [m] = parseCal(swap);
  assert.equal(m.title, 'Book swap; bring 2 books');
  assert.equal(m.location, 'Cafe, 2nd floor');
  assert.equal(m.source, 'groupme');
  assert.equal(localTime(m.start, tz), '2027-02-16T19:00');
  assert.equal(localTime(m.end, tz), '2027-02-16T20:00');

  const due = toIcs('d1', { summary: 'Lab report due', start: { dateTime: '2027-02-18T04:59:00Z' }, end: { dateTime: '2027-02-18T04:59:00Z' } }, tz);
  assert.match(due, /DTSTART:20270218T045900Z\r\nDTEND:20270218T045900Z\r\n/); // iCloud needs an end
  assert.match(toIcs('x', { summary: 'a'.repeat(200), start: { date: '2027-02-12' } }, tz), /\r\n a/); // long lines folded

  const withAlarm = 'BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Lecture\r\nDTSTART:20270212T150000Z\r\nRRULE:FREQ=WEEKLY\r\nBEGIN:VALARM\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT';
  const [c] = parseCal(withAlarm);
  assert.equal(c.title, 'Lecture');
  assert.equal(c.description, undefined);
  assert.equal(c.rrule, 'FREQ=WEEKLY');
});

test('iCloud XML answers are read whatever namespace prefix they use', () => {
  const xml = '<multistatus xmlns="DAV:"><response><href>/99/calendars/home/</href><propstat><prop><displayname>Home</displayname></prop></propstat></response><d:response><d:href>/99/calendars/family/</d:href></d:response></multistatus>';
  assert.equal(tags(xml, 'response').length, 2);
  assert.deepEqual(tags(xml, 'href'), ['/99/calendars/home/', '/99/calendars/family/']);
  assert.deepEqual(tags(xml, 'displayname'), ['Home']);
});

test('duplicates: same day and clearly the same thing, not just a shared word', () => {
  const dup = (a, b) => sameEvent(slot(a[0], a[1]), slot(b[0], b[1]));
  assert.equal(dup(['Garden Club work day', '2027-02-20T10:00'], ['Work Day', '2027-02-20T10:00']), true);
  assert.equal(dup(['Food drive', '2027-02-12'], ['Food Drive!!', '2027-02-12T15:00']), true);
  assert.equal(dup(['Choir warmup', '2027-02-11T17:00'], ['Choir rehearsal', '2027-02-11T17:15']), true); // shared word, 15 min apart
  assert.equal(dup(['Work day', '2027-02-20T10:00'], ['Work day', '2027-02-27T10:00']), false); // next week
  assert.equal(dup(['Study hall', '2027-02-20T09:00'], ['Physics study group', '2027-02-20T15:00']), false); // hours apart
  assert.equal(dup(['GBM', '2027-02-20T10:00'], ['Yoga', '2027-02-20T10:00']), false); // nothing shared
  const existing = [slot('Recital', '2027-03-06T19:00'), slot('Exam 1 [Geology]', '2027-02-17T13:00')];
  assert.equal(findDuplicate(slot('Piano Studio Recital', '2027-03-06T19:00'), existing)?.title, 'Recital');
  assert.equal(findDuplicate(slot('Recital program printing', '2027-03-06T09:00'), existing), undefined);
});

test('events on other calendars are never changed', async () => {
  const other = 'FAMILY-CAL/event7'; // ids of events on other calendars carry the folder
  await assert.rejects(updateEvent({}, other, { title: 'x' }), /other calendars/);
  await assert.rejects(deleteEvent({}, other), /other calendars/);
  await assert.rejects(insertOnce({}, other, { summary: 'x' }), /other calendars/);
});

test('a possible duplicate says where it is and waits for a yes', () => {
  const note = twinNote({ title: 'Work Day', time: '10:00', calendar: 'Family' });
  assert.match(note, /Family calendar as "Work Day" at 10:00/);
  assert.match(note, /Not added yet/);
  assert.match(note, /force true/);
});

test('a called-off notice is keyed so it is only said once', () => {
  assert.equal(cancelKey({ title: 'Work Day!', date: '2027-02-20' }, '2027-02-11'), cancelKey({ title: 'work day', date: '2027-02-20T10:00' }, '2027-02-12'));
  assert.equal(cancelKey({ title: 'Picnic' }, '2027-02-11'), '2027-02-11:picnic');
});

test('the scan-done message says how many chats and what was found', () => {
  assert.match(scanDoneText({ total: 7, found: 0 }), /7 chats.*Nothing new/);
  assert.match(scanDoneText({ total: 1, found: 3 }), /1 chat from.*Found 3 new plans/);
});

import { dayLabel, dateTable } from '../src/calendar.js';
import { status } from '../src/canvas.js';

test('duplicates: different kinds or numbers are different things, course names ignored', () => {
  const dup = (a, b) => sameEvent(slot(a, '2027-03-09T23:59'), slot(b, '2027-03-09T23:59'));
  assert.equal(dup('Module 2 HW [Geology]', 'Module 2 Quiz [Geology]'), false);
  assert.equal(dup('Reading Response #4 [Art History]', 'Reading Response #5 [Art History]'), false);
  assert.equal(dup('Module 2 HW [Geology]', 'Module 2 HW'), true);
  assert.equal(dup('Checkpoint 6, part 2', 'Checkpoint 6 Part 2 [Intro Psychology]'), true);
});

test('weekdays come from the calendar, not the model', () => {
  assert.equal(dayLabel('2027-03-07T23:59'), 'Sun Mar 7');
  assert.equal(dayLabel('2027-03-05'), 'Fri Mar 5');
  assert.match(dateTable('2027-02-03', 8), /^Wed 2027-02-03, Thu 2027-02-04, .*Tue 2027-02-09\nWed 2027-02-10$/s);
});

test('in-class and outside-site work is never called missing', () => {
  assert.match(status({ workflow_state: 'unsubmitted' }, ['on_paper']), /in class/);
  assert.match(status({ workflow_state: 'unsubmitted' }, ['external_tool']), /outside site/);
  assert.equal(status({ workflow_state: 'graded', score: 17 }, ['on_paper']), 'graded 17');
  assert.equal(status({ workflow_state: 'unsubmitted', missing: true }, ['online_upload']), 'missing');
});

test('a scan the user asked for lists everything still waiting', () => {
  const waiting = [{ id: 4, title: 'Choir rehearsal', start: '2027-02-11T17:00', all_day: 0, grp: 'Choir', quote: '' },
    { id: 9, title: 'Board game night', start: '2027-02-12T20:00', all_day: 0, grp: 'Floor 4', quote: '' }];
  const text = scanDoneText({ total: 11, found: 0 }, waiting);
  assert.match(text, /^Scan done! I went through 11 chats from the last six months\. Nothing new\.\n\nEverything not on your calendar yet:\n4\. Choir rehearsal, Thu, Feb 11, 5:00 PM/);
  assert.match(text, /add 4 and 9/);
});

test('long messages split at line breaks into parts GroupMe takes', () => {
  const para = (n) => `${'word '.repeat(60).trim()} ${n}`;
  const text = [para(1), para(2), para(3), para(4)].join('\n');
  const parts = splitMessage(text, 700);
  assert.ok(parts.every((p) => p.length <= 700));
  assert.equal(parts.join('\n'), text);
  assert.deepEqual(splitMessage('short'), ['short']);
});

test('a weekday in the words that the date is not on is caught', () => {
  assert.equal(wrongWeekday('Potluck (Sunday)', '2027-03-05'), 'Sun'); // Mar 5 is a Friday
  assert.equal(wrongWeekday('rehearsal sunday 3pm', '2027-03-07T15:00'), null); // Mar 7 is a Sunday
  assert.equal(wrongWeekday('no day named here', '2027-03-07'), null);
});

test('a one-word title is not enough to call two events the same', () => {
  assert.equal(sameEvent(slot('Piano Studio Recital programs due', '2027-03-06'), slot('Piano', '2027-03-06T11:00')), false);
  assert.equal(sameEvent(slot('Piano Studio Recital', '2027-03-06T19:00'), slot('Recital', '2027-03-06T19:00')), true); // same time
  assert.equal(sameEvent(slot('Recital', '2027-03-06T19:00'), slot('recital!', '2027-03-06')), true); // same single word
});
