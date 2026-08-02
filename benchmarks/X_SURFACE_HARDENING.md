# X-derived surface hardening (non-marketing)

Signal themes (agent/Discord ops, 2025–2026):

1. **Allowlist beats vibe check** — tool/host allowlists on the action path, not prompt tone.
2. **Guard the action** — policy on destructive ops; audit high-impact calls.
3. **Admin bots get nuked** — never request Administrator; least privilege invite bitmask.
4. **Prompt injection is infrastructure** — channel text is untrusted data; quarantine framing.
5. **Approvals fatigue** — rate-limit chatter so humans only see costly gates.

Chamber applied:

| Control | Where |
|---------|--------|
| Untrusted surface framing | `quarantineUntrustedText` in Discord/Slack turns |
| Strip bidi/zero-width | `stripInvisibleNoise` |
| Per user×channel rate limit | `checkRateLimit` / `CHAMBER_SURFACE_RATE_*` |
| Ignore bots/webhooks/system | `discord_runner` |
| Approve fail-closed allowlist | existing |
| Minimal Discord permission bitmask | `0x8001CC40` (no Admin) |
| Attachment metadata only | existing |

Not claimed fixed: model can still be socially engineered in-text; gates on **writes/tools** remain the real backstop.

| Spend cap fail-closed | `assertSpendBudget` / `CHAMBER_SPEND_CAP_USD` |
| MCP pin on every tools/call | `mcpToolsCall` → `verifyToolsAgainstPin` |
| Skill secret pattern scan | `skillSecretScanRefuse` in `tryActivateSkill` |
| Session→memory must gate | `remember()` forces approval for session-like sources |
| HTTP /turn quarantine + rate | `server.ts` |
