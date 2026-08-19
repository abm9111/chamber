-- Chamber week-1 schema (SQLite)
-- Invariant: no assertion becomes executable, citable, or load-bearing except
-- through a gate whose check and write commit in one transaction.

PRAGMA foreign_keys = ON;

-- ─── Belief ledger ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS belief (
  id                TEXT PRIMARY KEY,
  content           TEXT NOT NULL,
  epistemic_type    TEXT NOT NULL
                    CHECK (epistemic_type IN (
                      'observation','inference','belief',
                      'commitment','unknown','defeater'
                    )),
  claim_hash        TEXT NOT NULL,
  -- confidence is UI/ranking only; NO gate may branch on it (Kimi anti-feature #2)
  confidence        REAL CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  half_life_seconds INTEGER,
  expires_at        TEXT,                    -- ISO-8601; denormalized for expiry scan
  revision_of       TEXT REFERENCES belief(id),
  committed_path    TEXT NOT NULL
                    CHECK (committed_path IN ('fast','deep','deep_lite')),
  stakes            TEXT NOT NULL DEFAULT 'routine'
                    CHECK (stakes IN ('routine','consequential')),
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','expired','superseded')),
  author_family     TEXT,
  session_id        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (claim_hash, revision_of)
);

CREATE INDEX IF NOT EXISTS idx_belief_claim_hash ON belief(claim_hash);
CREATE INDEX IF NOT EXISTS idx_belief_expires ON belief(expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_belief_type_path ON belief(epistemic_type, committed_path);

-- ─── Sources (replaces mirrored arrays) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS belief_source (
  id                TEXT PRIMARY KEY,
  belief_id         TEXT NOT NULL REFERENCES belief(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL
                    CHECK (kind IN (
                      'transcript','url','vault_page','x_tweet','belief'
                    )),
  ref_id            TEXT NOT NULL,           -- page_id | tweet_id | belief_id | ...
  snapshot_hash     TEXT NOT NULL,           -- content pin; never URL alone
  -- The `path#pN` this pin was minted against, recorded at commit time.
  --
  -- `ref_id` is a document id, which is opaque and stops resolving the moment
  -- ingest deletes the row — and ingest deletes rows whenever a note shrinks.
  -- Without the position, a pin whose row is gone can only report `not_found`
  -- ("your citation was never real") even when the cited text sits intact a
  -- few passages higher in the same note, because the snapshot hash contains
  -- the old position and so matches nothing. KNOWN_LIMITATIONS 6.
  --
  -- NULL for rows written before this column existed, and for `kind='belief'`
  -- sources, which are ledger edges rather than corpus positions.
  pinned_ref        TEXT,
  -- The ingest root `pinned_ref` is relative to. `source_ref` is root-relative,
  -- so it names a path and not a file: two configured vaults may each hold
  -- `notes/index.md`. Recorded for the same reason as pinned_ref — once the row
  -- is swept there is nothing left to ask which vault the pin belonged to, and
  -- deriving it from whichever rows still hold that path resolves into the
  -- wrong corpus as soon as the pin's own vault no longer has the file.
  pinned_root       TEXT,
  span_hash         TEXT,                    -- exact quoted span
  context_hash      TEXT,                    -- ±N tokens around span
  provenance        TEXT
                    CHECK (provenance IS NULL OR provenance IN (
                      'direct','fts','vector','quoted_via','transcript'
                    )),
  pays_subclaim     TEXT,                    -- which minted debt this retires
  retriever_family  TEXT,
  retrieved_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_belief_source_belief ON belief_source(belief_id);
CREATE INDEX IF NOT EXISTS idx_belief_source_snap ON belief_source(snapshot_hash);

-- ─── Citation debt ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS citation_debt (
  id                TEXT PRIMARY KEY,
  claim_hash        TEXT NOT NULL,           -- upsert key; kills revision-mint livelock
  belief_id         TEXT REFERENCES belief(id), -- follows claim across revisions
  claim_text        TEXT NOT NULL,
  subclaim          TEXT,                    -- optional finer grain
  blocking          INTEGER NOT NULL DEFAULT 1
                    CHECK (blocking IN (0,1)), -- 0 for defeater/unknown path debts
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','proposed_paid','paid','waived','expired')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at           TEXT,
  expires_at        TEXT,                    -- NOT NULL semantics when waived (app enforces)
  waived_by         TEXT CHECK (waived_by IS NULL OR waived_by IN ('human','epistemology')),
  waiver_reason     TEXT,
  source_snapshot_hash TEXT,                 -- payment pins content, not URL
  UNIQUE (claim_hash, subclaim)
);

CREATE INDEX IF NOT EXISTS idx_debt_claim ON citation_debt(claim_hash);
CREATE INDEX IF NOT EXISTS idx_debt_status_blocking
  ON citation_debt(status, blocking) WHERE status IN ('pending','proposed_paid');

-- ─── Skills ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS skill_snapshot (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  semantic_vector   BLOB,                    -- optional; opaque to SQL
  cleared_hash      TEXT,                    -- last critic-cleared content hash
  cleared_vector    BLOB,
  author_signature  TEXT,
  critic_clearance  TEXT
                    CHECK (critic_clearance IS NULL OR critic_clearance IN (
                      'passed','pending','denied'
                    )),
  critic_family     TEXT,
  capability_manifest TEXT,                  -- JSON array; enforced when non-null
  last_verified_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_skill_snap_name ON skill_snapshot(name, created_at DESC);

-- Status is DERIVED from holds — never written by gates as source of truth.
CREATE TABLE IF NOT EXISTS skill_holds (
  id                TEXT PRIMARY KEY,
  skill_id          TEXT NOT NULL,           -- logical skill name/id
  kind              TEXT NOT NULL
                    CHECK (kind IN (
                      'mutation_pending','belief_stale',
                      'constitutional','manual','shadow_would_refuse'
                    )),
  created_by_gate   TEXT NOT NULL,
  belief_id         TEXT REFERENCES belief(id), -- when kind=belief_stale
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_at       TEXT,
  released_by       TEXT,
  CHECK (
    (released_at IS NULL AND released_by IS NULL) OR
    (released_at IS NOT NULL AND released_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_holds_open
  ON skill_holds(skill_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_holds_kind ON skill_holds(kind, skill_id);

CREATE TABLE IF NOT EXISTS skill_dependencies (
  skill_id          TEXT NOT NULL,
  belief_id         TEXT NOT NULL REFERENCES belief(id),
  load_bearing      INTEGER NOT NULL DEFAULT 1 CHECK (load_bearing IN (0,1)),
  provenance        TEXT NOT NULL DEFAULT 'declared'
                    CHECK (provenance IN ('declared','observed')),
  last_confirmed_at TEXT,
  PRIMARY KEY (skill_id, belief_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_deps_belief ON skill_dependencies(belief_id);

-- ─── Expiry / re-evaluation ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS re_evaluation_ticket (
  id                TEXT PRIMARY KEY,
  belief_id         TEXT NOT NULL REFERENCES belief(id),
  cause             TEXT NOT NULL
                    CHECK (cause IN (
                      'half_life','defeater','source_expired','aporia_cluster'
                    )),
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','renewed','expired','revised')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at       TEXT,
  resolved_by       TEXT
                    CHECK (resolved_by IS NULL OR resolved_by IN (
                      'agent','epistemology','human'
                    )),
  UNIQUE (belief_id, cause, status) -- app soft-enforces one open per cause
);

CREATE INDEX IF NOT EXISTS idx_ticket_open
  ON re_evaluation_ticket(status) WHERE status = 'open';

-- ─── Gate audit spine ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gate_event (
  id                TEXT PRIMARY KEY,
  turn_id           TEXT,
  gate              TEXT NOT NULL
                    CHECK (gate IN (
                      'debt','expiry','mutation','router','hold',
                      'aporia','commit','activate','dream','manifest'
                    )),
  action            TEXT NOT NULL
                    CHECK (action IN (
                      'minted','blocked','passed','waived','escalated',
                      'suspended','released','timeout','breach',
                      'failed_closed','shadow_would_refuse','activated',
                      'proposed','absent'
                    )),
  subject_kind      TEXT,
  subject_id        TEXT,
  detail_json       TEXT,
  latency_ms        INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_gate_event_gate_time ON gate_event(gate, created_at);
CREATE INDEX IF NOT EXISTS idx_gate_event_action ON gate_event(action, created_at);

-- ─── Waiver budget (hardening #1, ship with debt) ────────────────────────────

CREATE TABLE IF NOT EXISTS waiver_ledger (
  window_start      TEXT NOT NULL,           -- ISO date of window
  used              INTEGER NOT NULL DEFAULT 0,
  cap               INTEGER NOT NULL DEFAULT 5,
  PRIMARY KEY (window_start)
);

-- ─── Config: shadow-mode flip (fork C) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS chamber_config (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
);

INSERT OR IGNORE INTO chamber_config(key, value) VALUES
  ('suspension_mode', 'shadow'),             -- shadow | teeth
  ('suspension_flip_at', datetime('now', '+7 days')),
  ('waiver_cap_per_week', '5');
