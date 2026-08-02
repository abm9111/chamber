-- Automated approval workflows (Chamber)
-- Fail-closed: no rule match → stays pending for human.
-- Expire ≠ approve. Constitution never auto-approves.

PRAGMA foreign_keys = ON;

-- ─── Workflow definition ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_workflow (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  description       TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  priority          INTEGER NOT NULL DEFAULT 100,  -- lower runs first
  -- Match conditions (NULL = any)
  match_target      TEXT,   -- memory|skill|... or NULL
  match_action      TEXT,   -- add|patch|... or NULL
  match_origin      TEXT,   -- foreground|background_review|... or NULL
  match_stakes      TEXT CHECK (match_stakes IS NULL OR match_stakes IN ('routine','consequential')),
  -- Outcome
  outcome           TEXT NOT NULL
                    CHECK (outcome IN (
                      'auto_approve',
                      'auto_reject',
                      'require_human',
                      'require_critic'      -- queue until critic family signs
                    )),
  reject_reason     TEXT,
  -- Safety rails
  max_auto_per_hour INTEGER,               -- rate limit per workflow; NULL = unlimited
  require_payload_keys TEXT,             -- JSON array of required payload keys
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_enabled_pri
  ON approval_workflow(enabled, priority) WHERE enabled = 1;

-- ─── Workflow run audit ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_workflow_event (
  id                TEXT PRIMARY KEY,
  workflow_id       TEXT NOT NULL REFERENCES approval_workflow(id),
  pending_write_id  TEXT NOT NULL REFERENCES pending_write(id),
  decision          TEXT NOT NULL
                    CHECK (decision IN (
                      'auto_approve','auto_reject','require_human',
                      'require_critic','rate_limited','skipped'
                    )),
  detail_json       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_wf_event_pending ON approval_workflow_event(pending_write_id);
CREATE INDEX IF NOT EXISTS idx_wf_event_time ON approval_workflow_event(created_at);

-- ─── Seed safe default workflows ─────────────────────────────────────────────
-- Priority: lower number = higher precedence.

INSERT OR IGNORE INTO approval_workflow(
  id, name, description, enabled, priority,
  match_target, match_action, match_origin, match_stakes, outcome, reject_reason, max_auto_per_hour
) VALUES
-- Never auto: constitution
('wf_constitution_human', 'constitution_always_human',
 'Constitutional amendments always require human ratification',
 1, 10, 'constitution', NULL, NULL, NULL, 'require_human', NULL, NULL),

-- Never auto: consequential stakes
('wf_consequential_human', 'consequential_always_human',
 'Consequential stakes never auto-approve',
 1, 20, NULL, NULL, NULL, 'consequential', 'require_human', NULL, NULL),

-- Never auto: background skill create/delete
('wf_bg_skill_create_human', 'background_skill_create_human',
 'Background skill create/delete always human',
 1, 30, 'skill', 'create', 'background_review', NULL, 'require_human', NULL, NULL),

('wf_bg_skill_delete_human', 'background_skill_delete_human',
 'Background skill delete always human',
 1, 31, 'skill', 'delete', 'background_review', NULL, 'require_human', NULL, NULL),

('wf_dream_skill_human', 'dream_skill_writes_human',
 'Dream cycle skill writes always human',
 1, 32, 'skill', NULL, 'dream', NULL, 'require_human', NULL, NULL),

-- Auto-reject: empty payload theater
('wf_reject_empty_reason', 'reject_empty_background_reason',
 'Background writes without reason are rejected',
 1, 40, NULL, NULL, 'background_review', 'routine', 'auto_reject',
 'background write missing reason', NULL),

-- Auto-approve: foreground routine memory add only (narrow)
('wf_fg_memory_add', 'foreground_routine_memory_add',
 'Foreground routine memory add may auto-approve',
 1, 80, 'memory', 'add', 'foreground', 'routine', 'auto_approve', NULL, 30),

-- Auto-approve: foreground routine user_profile add
('wf_fg_user_add', 'foreground_routine_user_add',
 'Foreground routine user profile add may auto-approve',
 1, 81, 'user_profile', 'add', 'foreground', 'routine', 'auto_approve', NULL, 20),

-- Default catch-all: human (explicit, last)
('wf_default_human', 'default_require_human',
 'No safer rule matched — human queue',
 1, 1000, NULL, NULL, NULL, NULL, 'require_human', NULL, NULL);

INSERT OR IGNORE INTO approval_policy(key, value) VALUES
  ('workflows.enabled', 'on'),
  ('workflows.auto_approve_enabled', 'on');  -- master switch for auto_approve outcomes
