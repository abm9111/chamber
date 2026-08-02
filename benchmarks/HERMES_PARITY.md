# Hermes feature parity — under Chamber gates

**Policy:** Chamber grows Hermes *surfaces*. It does **not** adopt Hermes *authority* (self-approved skills, uncitable MEMORY as warrant).

## Feature map (2026-07-31)

| Hermes feature | Chamber | Module |
|----------------|---------|--------|
| SOUL / USER / MEMORY | **Done** | `profiles.ts` |
| Session history + FTS search | **Done** | `sessions.ts` (CLI + HTTP turns) |
| Cron automations | **Done** | `cron.ts` — interval + 5-field subset |
| Skills library | **Done** | `skills_registry.ts` |
| Skill import (markdown/dir) | **Done** | `skill_import.ts` |
| Learning loop | **Governed** | pending only |
| MCP tool manifests | **Done** | `mcp_bridge.ts` |
| Telegram gateway | **Done** | `gateway_runner.ts` |
| Discord / Slack | **Stub+send** | optional tokens |
| Console gateway | **Done** | default |
| Skill Hub remote | **Local only** | import/registry |
| Auto skill self-improve | **Refused** | by design |

## CLI

```bash
chamber turn "…"
chamber session-search AED
chamber skill-import fixtures/skills
chamber mcp-import fixtures/mcp/sample_server.json
chamber skills
chamber cron add dig interval:1h "digest"
npm run gateway
```

## Tests

parity **5/5** · full harness **60/60**
