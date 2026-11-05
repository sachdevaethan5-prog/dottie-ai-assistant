-- Notes: a topic, said by the user (guess = 0) or worked out by the assistant (guess = 1, until
-- the user confirms), and an optional last day it matters (until).
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, topic TEXT, guess INTEGER NOT NULL DEFAULT 0, until TEXT, updated_at TEXT);
-- Every note's earlier wording, kept when it is updated, merged or deleted, so nothing is lost.
CREATE TABLE IF NOT EXISTS note_history (id INTEGER PRIMARY KEY, note_id INTEGER, text TEXT NOT NULL, why TEXT, changed_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT NOT NULL, due TEXT, done INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
-- GroupMe events waiting for the user's yes. key = date + title, so one event is only suggested once.
CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, start TEXT NOT NULL, end_at TEXT, all_day INTEGER NOT NULL DEFAULT 0, location TEXT, grp TEXT, quote TEXT, status TEXT NOT NULL DEFAULT 'asked', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- What each GroupMe chat is and whether to watch it. asked = the user has been asked about it
-- once, so it isn't asked again. calendar is unused: everything goes on the user's own calendar.
CREATE TABLE IF NOT EXISTS chats (name TEXT PRIMARY KEY COLLATE NOCASE, about TEXT, calendar TEXT, muted INTEGER NOT NULL DEFAULT 0, asked INTEGER NOT NULL DEFAULT 0);
-- Published Canvas grades, so the assistant knows them as soon as they come out.
CREATE TABLE IF NOT EXISTS grades (assignment_id INTEGER PRIMARY KEY, course_id INTEGER, course TEXT, name TEXT, score REAL, points REAL, grade TEXT, mean REAL, test INTEGER NOT NULL DEFAULT 0, graded_seen_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- Reminders. at = when it is due (UTC ISO); every = day, weekday, week or month for repeating ones.
CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, text TEXT NOT NULL, at TEXT NOT NULL, every TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- What the assistant learned from reading the user's chats (organizers, regular meeting times,
-- costs, sign-ups, links), one fact a row, replaced each time a chat is read again. Searched, not in
-- every prompt. until = the day it stops mattering (an event that's over), when it has one.
CREATE TABLE IF NOT EXISTS chat_facts (id INTEGER PRIMARY KEY, chat TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, until TEXT);
