-- Faculty parliament (Chamber Phase 5) — narrow, blocking votes
-- Five faculties aligned to Chamber's philosophical spine.
-- Cosplay forbidden: votes are Postgres-style rows with real refuse power.

CREATE TABLE IF NOT EXISTS faculty_vote (
  id                TEXT PRIMARY KEY,
  deliberation_id   TEXT NOT NULL,
  faculty           TEXT NOT NULL
                    CHECK (faculty IN (
                      'mind_consciousness',
                      'epistemology',
                      'applied_ethics',
                      'language_logic',
                      'philosophy_of_tech'
                    )),
  vote              TEXT NOT NULL
                    CHECK (vote IN ('approve','reject','abstain','defer')),
  rationale         TEXT,
  model_family      TEXT,                    -- null = rule/heuristic vote
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (deliberation_id, faculty)
);

CREATE INDEX IF NOT EXISTS idx_faculty_delib ON faculty_vote(deliberation_id);

CREATE TABLE IF NOT EXISTS deliberation (
  id                TEXT PRIMARY KEY,
  subject_kind      TEXT NOT NULL
                    CHECK (subject_kind IN ('skill','belief','memory','tool','constitution','other')),
  subject_id        TEXT NOT NULL,
  question          TEXT NOT NULL,
  stakes            TEXT NOT NULL DEFAULT 'routine'
                    CHECK (stakes IN ('routine','elevated','consequential')),
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','passed','rejected','parked','timed_out')),
  required_quorum   INTEGER NOT NULL DEFAULT 3,
  timeout_at        TEXT,
  outcome           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_delib_open ON deliberation(status) WHERE status = 'open';

-- Shared durable workspace with simple lock (not CRDT)
CREATE TABLE IF NOT EXISTS workspace_object (
  key               TEXT PRIMARY KEY,
  value_json        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  locked_by         TEXT,
  locked_at         TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by        TEXT
);
