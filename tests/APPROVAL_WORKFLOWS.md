# Automated approval workflows

## Flow

```text
proposeWrite() → status=pending
       ↓
evaluateWorkflows(writeId)   # first matching rule by priority
       ↓
  auto_approve  → decideWrite(approved, auto_policy)
  auto_reject   → decideWrite(rejected, auto_policy)
  require_human → leave pending
  require_critic→ leave pending + note
  rate_limited  → leave pending
```

## Seeded rules (priority order)

| Priority | Workflow | Outcome |
|----------|----------|---------|
| 10 | constitution always | require_human |
| 20 | consequential stakes | require_human |
| 30–32 | background/dream skill create/delete | require_human |
| 40 | background without reason | auto_reject |
| 80–81 | foreground routine memory/user **add** | auto_approve (rate limited) |
| 1000 | default | require_human |

## Hard rails

- `constitution` never auto-approves (code + rule)
- Master switch: `workflows.auto_approve_enabled`
- Rate limit per workflow (`max_auto_per_hour`)
- TTL expiry still **≠** approve

## Acceptance

| # | Name | Pass |
|---|------|------|
| W1 | constitution queued | propose constitution → evaluate → `queued_human` |
| W2 | fg memory add auto | foreground routine memory add → `auto_approve` |
| W3 | bg skill create human | background skill create → `queued_human` |
| W4 | bg no reason reject | background_review empty reason → `auto_reject` |
| W5 | rate limit | exceed max_auto_per_hour → `rate_limited`, stays pending |
| W6 | master off | `workflows.auto_approve_enabled=off` → auto paths become human |
| W7 | default human | unmatched pattern → `queued_human` |

## Integration

```ts
import { proposeWrite } from "./approvals.ts";
import { evaluateWorkflows } from "./approval_workflows.ts";

const q = proposeWrite(db, { ... });
if (q.status === "queued") {
  const w = evaluateWorkflows(db, q.writeId);
  // w.applied === 'auto_approve' → caller may markApplied + execute payload
}
```
