-- QM-inspired: scopes + durable job queue (Chamber gates still apply)

CREATE TABLE IF NOT EXISTS scope (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('user','room','org','system')),
  parent_id     TEXT,
  title         TEXT,
  policy        TEXT NOT NULL DEFAULT 'auto'
                CHECK (policy IN ('strict','auto')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO scope (id, kind, title, policy)
VALUES ('default', 'org', 'Default org scope', 'auto');

CREATE TABLE IF NOT EXISTS job_queue (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN (
                  'expiry','cron','dream','oauth_refresh','custom'
                )),
  payload_json  TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN (
                  'pending','running','done','failed','cancelled'
                )),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_after     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  locked_by     TEXT,
  locked_at     TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_queue_poll
  ON job_queue (status, run_after);


-- Session scope bind (QM-inspired isolation; safe if column already exists)
-- SQLite ignores failed ALTERs when applied carefully from db.ts helper.
