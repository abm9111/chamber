-- Hierarchical long-term memory (Chamber Phase 4)
-- Layers: working → episodic → semantic → skill_note
-- Provenance required; forgetting is explicit status change + optional skill holds.

CREATE TABLE IF NOT EXISTS memory_item (
  id                TEXT PRIMARY KEY,
  layer             TEXT NOT NULL
                    CHECK (layer IN ('working','episodic','semantic','skill_note')),
  title             TEXT,
  body              TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  -- provenance
  source_kind       TEXT,                    -- transcript|belief|human|tool|dream
  source_ref        TEXT,
  snapshot_hash     TEXT,
  belief_id         TEXT REFERENCES belief(id),
  -- lifecycle
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','decayed','archived','forgotten','pending_harvest')),
  salience          REAL NOT NULL DEFAULT 0.5,  -- 0..1
  half_life_seconds INTEGER,                    -- null = no auto-decay
  expires_at        TEXT,
  access_count      INTEGER NOT NULL DEFAULT 0,
  last_accessed_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  forgotten_at      TEXT,
  forget_reason     TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_layer_status
  ON memory_item(layer, status);
CREATE INDEX IF NOT EXISTS idx_memory_expires
  ON memory_item(expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_hash ON memory_item(content_hash);

-- Promotion / demotion proposals from dream cycle (never auto-applied)
CREATE TABLE IF NOT EXISTS memory_proposal (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL
                    CHECK (kind IN (
                      'promote','demote','forget','merge','harvest'
                    )),
  memory_id         TEXT REFERENCES memory_item(id),
  from_layer        TEXT,
  to_layer          TEXT,
  rationale         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','rejected','expired')),
  pending_write_id  TEXT,                    -- link to approvals.pending_write when queued
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at       TEXT,
  resolved_by       TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_prop_pending
  ON memory_proposal(status) WHERE status = 'pending';
