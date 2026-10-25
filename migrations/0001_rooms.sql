-- The SQL revision is the private compare-and-swap generation. The public game
-- revision lives inside data and does not advance for presence heartbeats.
CREATE TABLE rooms (
  code TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  next_ai_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX rooms_expiry ON rooms (expires_at);
