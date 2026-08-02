-- Local vector search (Chamber corpus plane)
-- Embeddings stored as Float32 little-endian BLOB; similarity in app (cosine).
-- No cloud dependency. Real embedders inject vectors; localHashEmbed is the zero-dep default.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vector_document (
  id                TEXT PRIMARY KEY,
  source_kind       TEXT NOT NULL
                    CHECK (source_kind IN (
                      'vault_page','x_tweet','transcript','note','skill','other'
                    )),
  source_ref        TEXT,                  -- page path, tweet id, etc.
  title             TEXT,
  body              TEXT NOT NULL,
  -- Content pin for citation debt payment (same rules as belief_source)
  snapshot_hash     TEXT NOT NULL,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_vector_doc_kind ON vector_document(source_kind);
CREATE INDEX IF NOT EXISTS idx_vector_doc_snap ON vector_document(snapshot_hash);
CREATE INDEX IF NOT EXISTS idx_vector_doc_ref ON vector_document(source_ref);

CREATE TABLE IF NOT EXISTS vector_embedding (
  document_id       TEXT PRIMARY KEY REFERENCES vector_document(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,         -- e.g. local-hash-v1 | injected:model-name
  dims              INTEGER NOT NULL CHECK (dims > 0),
  -- Float32 LE bytes; length must be dims * 4
  vector_blob       BLOB NOT NULL,
  embedded_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_vector_emb_model ON vector_embedding(model);

-- Optional FTS5 over body/title for hybrid retrieval
CREATE VIRTUAL TABLE IF NOT EXISTS vector_document_fts USING fts5(
  title,
  body,
  content='vector_document',
  content_rowid='rowid'
);

-- Keep FTS in sync via triggers
CREATE TRIGGER IF NOT EXISTS vector_document_ai AFTER INSERT ON vector_document BEGIN
  INSERT INTO vector_document_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS vector_document_ad AFTER DELETE ON vector_document BEGIN
  INSERT INTO vector_document_fts(vector_document_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS vector_document_au AFTER UPDATE ON vector_document BEGIN
  INSERT INTO vector_document_fts(vector_document_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO vector_document_fts(rowid, title, body)
  VALUES (new.rowid, new.title, new.body);
END;

INSERT OR IGNORE INTO chamber_config(key, value) VALUES
  ('vector.enabled', 'on'),
  ('vector.default_model', 'local-hash-v1'),
  ('vector.default_dims', '256');
