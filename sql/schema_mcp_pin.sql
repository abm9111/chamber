-- MCP schema pins (anti rug-pull)

CREATE TABLE IF NOT EXISTS mcp_schema_pin (
  endpoint      TEXT PRIMARY KEY,
  list_hash     TEXT NOT NULL,
  tool_count    INTEGER NOT NULL,
  pinned_at     TEXT NOT NULL,
  tools_json    TEXT
);

CREATE TABLE IF NOT EXISTS mcp_tool_pin (
  endpoint           TEXT NOT NULL,
  tool_name          TEXT NOT NULL,
  schema_hash        TEXT NOT NULL,
  description_hash   TEXT NOT NULL,
  pinned_at          TEXT NOT NULL,
  PRIMARY KEY (endpoint, tool_name)
);
