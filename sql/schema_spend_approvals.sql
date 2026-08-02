-- Chamber week-1.5: spend meter + write approvals (default ON)
-- Apply after schema.sql
-- Field P0 from Hermes UX research: cost tax + silent skill/memory writes

PRAGMA foreign_keys = ON;

-- ─── Spend events (background burn must be visible) ──────────────────────────

CREATE TABLE IF NOT EXISTS spend_event (
  id                TEXT PRIMARY KEY,
  channel           TEXT NOT NULL
                    CHECK (channel IN (
                      'chat',           -- main turn completion
                      'memory_fork',    -- background memory/skill review
                      'dream',          -- offline consolidation
                      'cron',           -- scheduled jobs
                      'subagent',       -- delegated workers
                      'critic',         -- skill mutation critic
                      'faculty',        -- parliament / deep-path faculty calls
                      'other'
                    )),
  model             TEXT,
  model_family      TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd_micros   INTEGER NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0),
  -- micros: $0.000001 precision; avoid float money
  turn_id           TEXT,
  session_id        TEXT,
  profile_id        TEXT,
  detail_json       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_spend_created ON spend_event(created_at);
CREATE INDEX IF NOT EXISTS idx_spend_channel_time ON spend_event(channel, created_at);
CREATE INDEX IF NOT EXISTS idx_spend_session ON spend_event(session_id, created_at);

-- ─── Pending writes (approvals default ON) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS pending_write (
  id                TEXT PRIMARY KEY,
  target            TEXT NOT NULL
                    CHECK (target IN (
                      'memory',         -- MEMORY-class ledger projection
                      'user_profile',   -- USER-class
                      'belief',         -- direct ledger assertion (optional path)
                      'skill',          -- skill create/edit/patch/delete
                      'skill_file',     -- supporting file under a skill
                      'constitution'    -- amendment proposal only
                    )),
  action            TEXT NOT NULL
                    CHECK (action IN (
                      'add','replace','remove','create','edit','patch',
                      'delete','write_file','remove_file','commit'
                    )),
  subject           TEXT NOT NULL,          -- skill name, claim_hash, etc.
  payload_json      TEXT NOT NULL,          -- full proposed write
  origin            TEXT NOT NULL
                    CHECK (origin IN (
                      'foreground','background_review','dream',
                      'cron','subagent','human'
                    )),
  author_family     TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending','approved','rejected','expired','applied'
                    )),
  reason            TEXT,                  -- why the agent wants this write
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at        TEXT,
  decided_by        TEXT,                  -- human | auto_policy
  decision_note     TEXT,
  expires_at        TEXT,                  -- pending TTL; expire ≠ approve
  applied_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_status
  ON pending_write(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_target ON pending_write(target, status);

-- ─── Approval policy (defaults = ON / safe) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_policy (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
);

-- Default ON: Hermes users discovered approvals exist but off — Chamber inverts that.
INSERT OR IGNORE INTO approval_policy(key, value) VALUES
  ('memory.write_approval', 'on'),
  ('skills.write_approval', 'on'),
  ('belief.assertion_approval', 'on'),      -- belief|commitment commits may queue
  ('auto_skill_improve', 'quarantine'),     -- off | quarantine | on (on = unsafe)
  ('pending_ttl_hours', '72'),
  ('spend_alert_usd_micros_24h', '5000000'); -- $5.00 default soft alert

-- Ensure chamber_config has spend-related keys
INSERT OR IGNORE INTO chamber_config(key, value) VALUES
  ('spend_meter', 'on'),
  ('show_spend_each_turn', 'on');
