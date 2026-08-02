-- Incremental Merkle Mountain Range (MMR-style peaks)
-- Append-only: each new audit leaf updates O(log n) peaks — no full tree rebuild.
-- Root = bag-hash of peaks (left-to-right). Always fresh after every append.

PRAGMA foreign_keys = ON;

-- Peak stack: at most one peak per height (classic MMR peaks invariant)
CREATE TABLE IF NOT EXISTS merkle_inc_peak (
  height            INTEGER NOT NULL PRIMARY KEY CHECK (height >= 0),
  hash              TEXT NOT NULL,
  -- leaf range covered by this peak (inclusive seq in audit_event)
  from_seq          INTEGER NOT NULL,
  to_seq            INTEGER NOT NULL
);

-- Single-row live state
CREATE TABLE IF NOT EXISTS merkle_inc_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  leaf_count        INTEGER NOT NULL DEFAULT 0,
  root_hash         TEXT,                 -- NULL when leaf_count = 0
  last_seq          INTEGER,              -- last audit seq absorbed
  algorithm         TEXT NOT NULL DEFAULT 'sha256_mmr_peaks_v1',
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO merkle_inc_state(id, leaf_count) VALUES (1, 0);

-- Optional path cache for inclusion proofs without rebuild (leaf → peak)
CREATE TABLE IF NOT EXISTS merkle_inc_path (
  leaf_seq          INTEGER PRIMARY KEY,
  leaf_hash         TEXT NOT NULL,
  -- JSON: [{sibling, wasRight}, ...] from leaf up to its peak
  path_json         TEXT NOT NULL,
  peak_height       INTEGER NOT NULL,
  peak_hash         TEXT NOT NULL
);

INSERT OR IGNORE INTO chamber_config(key, value) VALUES
  ('merkle.incremental', 'on'),
  ('merkle.inc_algorithm', 'sha256_mmr_peaks_v1');
