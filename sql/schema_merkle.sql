-- Merkle root checkpoints over audit_event.entry_hash leaves
-- Enables inclusion proofs without re-walking the full hash chain every time.
-- Checkpoints are append-only; roots may be exported / pinned externally.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS merkle_checkpoint (
  id                TEXT PRIMARY KEY,
  from_seq          INTEGER NOT NULL,
  to_seq            INTEGER NOT NULL,
  leaf_count        INTEGER NOT NULL CHECK (leaf_count > 0),
  root_hash         TEXT NOT NULL,
  -- Optional: hash of (prev_checkpoint.root || this.root) for checkpoint chain
  prev_checkpoint_id TEXT REFERENCES merkle_checkpoint(id),
  checkpoint_link   TEXT,              -- sha256(prev.root || "\n" || root) or GENESIS
  algorithm         TEXT NOT NULL DEFAULT 'sha256_binary_merkle_v1',
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  note              TEXT,
  CHECK (to_seq >= from_seq)
);

CREATE INDEX IF NOT EXISTS idx_merkle_range ON merkle_checkpoint(from_seq, to_seq);
CREATE INDEX IF NOT EXISTS idx_merkle_created ON merkle_checkpoint(created_at);

-- Latest published root pointer (mutable tip only)
CREATE TABLE IF NOT EXISTS merkle_tip (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  checkpoint_id     TEXT REFERENCES merkle_checkpoint(id),
  root_hash         TEXT,
  to_seq            INTEGER,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO merkle_tip(id) VALUES (1);

INSERT OR IGNORE INTO chamber_config(key, value) VALUES
  ('merkle.enabled', 'on'),
  ('merkle.auto_checkpoint_every_n', '64');
