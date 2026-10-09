-- Unique timetable sessions (one row per class occurrence)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
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
