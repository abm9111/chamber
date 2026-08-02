# Spend meter + write approvals (week-1.5)

Hermes field P0: cost tax and silent memory/skill writes.

## Defaults (must stay safe)

| Policy key | Default | Meaning |
|------------|---------|---------|
| `memory.write_approval` | `on` | MEMORY/USER-class writes queue |
| `skills.write_approval` | `on` | skill create/edit/patch queues |
| `belief.assertion_approval` | `on` | belief/commitment may queue |
| `auto_skill_improve` | `quarantine` | background skill writes queue only; never silent apply |
| `pending_ttl_hours` | `72` | expire ≠ approve |
| `spend_alert_usd_micros_24h` | `5000000` | $5 soft alert |

## Acceptance checks

| # | Name | Pass condition |
|---|------|----------------|
| S1 | `spend_records_channels` | `recordSpend` for chat + memory_fork → `spendLastHours(24).byChannel` includes both |
| S2 | `spend_footer_nonzero` | After spends, `formatSpendFooter` contains channel names and dollar amount |
| S3 | `alert_fires` | Push micros over threshold → `report.alert` non-null |
| A1 | `skills_default_queue` | `proposeWrite` skill from `background_review` → `status=queued` (not applied) |
| A2 | `auto_improve_off` | Set `auto_skill_improve=off` → background skill propose → `rejected_by_policy` |
| A3 | `expire_not_approve` | Pending past `expires_at` → `expireStalePending` sets `expired`; `decideWrite(approve)` fails |
| A4 | `human_approve_then_apply` | `decideWrite(approved)` → status approved; only then `markApplied` |
| A5 | `policy_defaults_on` | Fresh DB: `getApprovalPolicy()` has memory/skills write_approval = `on` |

## Integration notes

- Call `recordSpend` from every model completion path (chat, fork, dream, cron, critic, faculty).
- Call `proposeWrite` before any skill_manage / memory write from agent code.
- UI/Telegram: show `formatSpendFooter(spendLastHours(24))` and `listPendingQueue()`.
- Never auto-approve on TTL (FM-7).
