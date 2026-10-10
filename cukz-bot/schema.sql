-- Unique timetable sessions (one row per class occurrence); rebuilt on every load (src/timetable.js)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,     -- event key from the file
  date TEXT NOT NULL,      -- YYYY-MM-DD (Astana local)
  start TEXT NOT NULL,     -- HH:MM
  end TEXT NOT NULL,       -- HH:MM
  code TEXT, title TEXT, type TEXT, rooms TEXT, staff TEXT, grp TEXT
);
CREATE INDEX IF NOT EXISTS sessions_date ON sessions(date, start);
-- Which sessions each student attends: JSON array of session ids
CREATE TABLE IF NOT EXISTS students (sid TEXT PRIMARY KEY, sessions TEXT NOT NULL);
-- Telegram users and their saved student number
CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER PRIMARY KEY,
  sid TEXT,
  remind INTEGER NOT NULL DEFAULT 1,
  created TEXT DEFAULT CURRENT_TIMESTAMP
);
-- Small settings: admin, Microsoft tokens, source link, timetable meta
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
-- Telegram file_id of each rendered timetable image, keyed by a hash of what it shows
CREATE TABLE IF NOT EXISTS images (k TEXT PRIMARY KEY, file_id TEXT NOT NULL);
-- Everyone who has written to the bot (UTC times), for /stats
CREATE TABLE IF NOT EXISTS seen (chat_id INTEGER PRIMARY KEY, first TEXT NOT NULL, last TEXT NOT NULL);
INSERT OR IGNORE INTO seen (chat_id, first, last) SELECT chat_id, created, created FROM users WHERE created IS NOT NULL;
