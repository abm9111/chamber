-- Chamber append-only audit trail (hash-chained)
-- Tip is the only mutable pointer; rows never UPDATE/DELETE in normal operation.
-- verify_audit_chain() detects tampering → fail closed for commits.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS audit_event (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  -- Classification
  category          TEXT NOT NULL
                    CHECK (category IN (
                      'gate',           -- debt/expiry/mutation/hold/commit/activate
                      'approval',       -- propose/decide/expire/workflow
                      'spend',          -- token/cost recording
                      'ledger',         -- belief lifecycle
                      'skill',          -- snapshot/hold/activate
                      'constitution',   -- amendment/ratify
                      'session',        -- turn boundaries
                      'system',         -- config/policy changes
                      'security'        -- red-path, provider, breach
                    )),
  action            TEXT NOT NULL,
  -- Subject
  actor             TEXT,              -- human | auto_policy | agent | system | critic
  actor_detail      TEXT,              -- user id, model family, workflow id
  subject_kind      TEXT,
  subject_id        TEXT,
  -- Context
  turn_id           TEXT,
  session_id        TEXT,
  profile_id        TEXT,
  -- Payload (structured; avoid secrets)
  detail_json       TEXT,
  -- Hash chain
  prev_hash         TEXT NOT NULL,     -- 'GENESIS' for first row
  entry_hash        TEXT NOT NULL,     -- H(prev_hash || canonical_payload)
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_category_time ON audit_event(category, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_event(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_event(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_turn ON audit_event(turn_id);

-- Single-row tip (mutable pointer only)
CREATE TABLE IF NOT EXISTS audit_chain_tip (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq          INTEGER NOT NULL DEFAULT 0,
  last_hash         TEXT NOT NULL DEFAULT 'GENESIS',
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO audit_chain_tip(id, last_seq, last_hash) VALUES (1, 0, 'GENESIS');

-- Optional mirror policy: also log high-signal gate_event into audit (app-level)
INSERT OR IGNORE INTO chamber_config(key, value) VALUES
  ('audit.chain_enabled', 'on'),
  ('audit.fail_closed_on_break', 'on');
