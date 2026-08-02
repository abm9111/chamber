-- Hermes-parity surfaces under Chamber gates
-- Profiles (SOUL / USER / MEMORY), sessions+FTS, cron, skill registry, learning proposals

-- ─── Profiles (Hermes SOUL.md / USER.md / MEMORY.md analogs) ─────────────────
CREATE TABLE IF NOT EXISTS profile_doc (
  id                TEXT PRIMARY KEY,        -- 'soul' | 'user' | 'memory' | custom
  kind              TEXT NOT NULL
                    CHECK (kind IN ('soul','user','memory','custom')),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  content_hash      TEXT NOT NULL,
  max_chars         INTEGER,                 -- soft capacity (Hermes-style caps)
  version           INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by        TEXT
);

-- ─── Sessions (cross-session recall) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
  id                TEXT PRIMARY KEY,
  profile_id        TEXT NOT NULL DEFAULT 'default',
  channel           TEXT NOT NULL DEFAULT 'cli'
                    CHECK (channel IN (
                      'cli','http','telegram','discord','slack','whatsapp','cron','other'
                    )),
  title             TEXT,
  started_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at          TEXT,
  metadata_json     TEXT
);

CREATE TABLE IF NOT EXISTS session_message (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES session(id),
  role              TEXT NOT NULL
                    CHECK (role IN ('user','assistant','system','tool')),
  content           TEXT NOT NULL,
  turn_id           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sess_msg_session ON session_message(session_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS session_message_fts USING fts5(
  content,
  message_id UNINDEXED,
  session_id UNINDEXED,
  role UNINDEXED,
  tokenize = 'porter'
);

-- ─── Cron (Hermes scheduled automations) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS cron_job (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  schedule          TEXT NOT NULL,           -- cron expr or interval:1h
  prompt            TEXT NOT NULL,           -- natural language task
  channel           TEXT NOT NULL DEFAULT 'cron',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       TEXT,
  next_run_at       TEXT,
  last_status       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ─── Skill registry (Hermes skills, Chamber-gated) ───────────────────────────
CREATE TABLE IF NOT EXISTS skill_registry (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  trigger_pattern   TEXT,                    -- when to suggest
  body              TEXT NOT NULL,            -- markdown + YAML frontmatter style
  content_hash      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','pending','active','archived','quarantine')),
  source            TEXT NOT NULL DEFAULT 'human'
                    CHECK (source IN ('human','learned','imported','synth')),
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activated_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_skill_reg_status ON skill_registry(status);

-- Learning loop proposals (never auto-activate)
CREATE TABLE IF NOT EXISTS learning_proposal (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL
                    CHECK (kind IN ('create_skill','patch_skill','memory_write','profile_write')),
  title             TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  evidence          TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','rejected','expired')),
  pending_write_id  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at       TEXT
);
