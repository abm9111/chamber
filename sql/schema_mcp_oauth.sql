-- MCP OAuth token store (Chamber client). Never log token plaintext in audit detail.

CREATE TABLE IF NOT EXISTS mcp_oauth_token (
  resource_url      TEXT PRIMARY KEY,        -- normalized MCP resource URL
  issuer            TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  access_token      TEXT NOT NULL,           -- prefer encrypt via CHAMBER_TOKEN_KEY later
  refresh_token     TEXT,
  scopes            TEXT,
  token_type        TEXT NOT NULL DEFAULT 'Bearer',
  expires_at        TEXT,                    -- ISO-8601
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS mcp_oauth_meta_cache (
  key               TEXT PRIMARY KEY,        -- prm:<url> | as:<issuer>
  body_json         TEXT NOT NULL,
  fetched_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at        TEXT
);
