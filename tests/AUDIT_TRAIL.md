# Audit trail (hash-chained)

## Model

```text
audit_event (append-only)
  seq, id, category, action, actor, subject_*, detail_json
  prev_hash → entry_hash = sha256(prev_hash || "\n" || canonical_payload)

audit_chain_tip (single row)
  last_seq, last_hash
```

Categories: `gate | approval | spend | ledger | skill | constitution | session | system | security`

## API

| Function | Use |
|----------|-----|
| `appendAudit` | Standalone event (owns TX) |
| `appendAuditInTx` | Inside `commit_belief` / activate TX |
| `verifyAuditChain` | Full walk; dream/cron or pre-commit |
| `assertAuditChainOrThrow` | Fail closed when chain broken |
| `queryAudit` | Filter by category / subject / session |
| `auditGate` / `auditApproval` | Convenience |

## Acceptance

| # | Name | Pass |
|---|------|------|
| T1 | genesis | First event has `prev_hash=GENESIS` |
| T2 | link | Second event `prev_hash` equals first `entry_hash` |
| T3 | tip | `audit_chain_tip.last_hash` equals latest `entry_hash` |
| T4 | tamper detect | After manual UPDATE of detail_json, `verifyAuditChain().ok === false` |
| T5 | fail closed | With `audit.fail_closed_on_break=on`, broken chain → `assertAuditChainOrThrow` throws |
| T6 | query | `queryAudit({ category: 'gate' })` returns only gate rows |

## Integration points

```text
commit_belief success/fail     → category=ledger|gate
try_activate_skill             → category=skill|gate
proposeWrite / decideWrite     → category=approval
evaluateWorkflows              → category=approval
recordSpend                    → category=spend
policy/config change           → category=system
provider red-path              → category=security
```

## Policy

- `audit.chain_enabled` = on  
- `audit.fail_closed_on_break` = on  

Never UPDATE/DELETE `audit_event` rows in application code.
