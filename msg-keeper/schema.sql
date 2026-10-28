-- owner_id: the only Telegram user the bot works for (first /start).
-- conn:<id>: business connections checked to belong to the owner.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Messages other people sent the owner, kept so they can be shown after a delete or edit.
CREATE TABLE IF NOT EXISTS messages (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  from_name TEXT NOT NULL,
  from_username TEXT,
  kind TEXT NOT NULL,        -- text, photo, video, voice, ... (see MEDIA in src/worker.js)
  text TEXT,                 -- text or caption
  file_id TEXT,
  sent_at INTEGER NOT NULL,  -- unix time from Telegram
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_at ON messages (at);
