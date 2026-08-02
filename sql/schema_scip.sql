-- SCIP consumer (Chamber) — store symbols + occurrences + relationships
-- Chamber does NOT generate SCIP; it ingests indexes produced by scip-* tools.

CREATE TABLE IF NOT EXISTS scip_document (
  id                TEXT PRIMARY KEY,
  relative_path     TEXT NOT NULL UNIQUE,
  content_hash      TEXT,
  indexed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS scip_symbol (
  id                TEXT PRIMARY KEY,
  symbol            TEXT NOT NULL UNIQUE,
  kind              TEXT,                    -- method/class/type/...
  display_name      TEXT,
  documentation     TEXT
);

CREATE TABLE IF NOT EXISTS scip_occurrence (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES scip_document(id),
  symbol_id         TEXT REFERENCES scip_symbol(id),
  symbol            TEXT,
  range_start_line  INTEGER,
  range_start_char  INTEGER,
  range_end_line    INTEGER,
  range_end_char    INTEGER,
  role              TEXT                     -- definition|reference|...
);

CREATE INDEX IF NOT EXISTS idx_scip_occ_symbol ON scip_occurrence(symbol);
CREATE INDEX IF NOT EXISTS idx_scip_occ_doc ON scip_occurrence(document_id);

CREATE TABLE IF NOT EXISTS scip_relationship (
  id                TEXT PRIMARY KEY,
  from_symbol       TEXT NOT NULL,
  to_symbol         TEXT NOT NULL,
  kind              TEXT NOT NULL            -- calls|implements|types|references
);

CREATE INDEX IF NOT EXISTS idx_scip_rel_from ON scip_relationship(from_symbol);
CREATE INDEX IF NOT EXISTS idx_scip_rel_to ON scip_relationship(to_symbol);
CREATE INDEX IF NOT EXISTS idx_scip_rel_kind ON scip_relationship(kind);
