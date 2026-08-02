# QM → Chamber architecture porting notes

**Source:** [yc-software/qm](https://github.com/yc-software/qm) (YC multiplayer agent harness, MIT, 2026-07-31)  
**Rule:** Port **patterns**, not authority model. Chamber gates stay above any harness loop.

```
QM:     Slack/Web → Core API → Agent loop → Sandbox
Chamber: Surface  → Gates (debt/faculty/approve) → Loop/tools → Audit/MMR
```

---

## QM architecture (compressed)

```
Postgres (sessions, memory, queue)
        ↕
Headless core: API (identity, policy, scheduler) ↔ Agent loop (Pi / OpenCode / Claude Code / …)
        ↕
Per-scope sandbox (files, tools, logged-in services)
        ↕
Plugins: Slack (Bolt), Web UI (Vite/Lit), admin, portal
```

| QM idea | Detail |
|---------|--------|
| **Scope** | Person or room: own memory, files, permissions, crons, sandbox |
| **Substrates** | Harness, session store, sandbox, memory behind interfaces + one wiring file |
| **Deploy dir** | Org-specific config/skills/infra outside core package |
| **Security postures** | Strict (approve every tool) / Auto (classifier) / Dangerous |
| **Command policy** | Hard denials even in Dangerous |
| **Persistence** | Postgres for durable sessions/queue |
| **Execution** | Durable job/worker pool (vs OpenClaw monolithic in-memory) |

---

## Port map

| QM pattern | Chamber today | Port? | How (without breaking gates) |
|------------|---------------|-------|------------------------------|
| Headless core + plugins | CLI + HTTP server | **Yes** | Keep `server.ts` as core API; Slack/Telegram as **plugins** that only call gated `/turn` |
| Swappable harness/model | `model.ts` completeSync | **Yes** | Interface: `HarnessAdapter.complete(messages)`; Ollama / cloud behind same spend meter |
| Per-scope isolation | Single DB, sessions | **Partial → Yes** | `scope_id` on session/memory/skill; no cross-scope belief load-bearing without grant |
| Durable job queue | Cron due-runner only | **Yes (P1)** | Table `job_queue` + worker loop for cron, dream, expiry, MCP refresh — still gated actions |
| Security postures | Approvals default ON | **Yes** | Map: Strict=always human; Auto=classifier + debt; never add QM “Dangerous” as default |
| Predeclared command policy | Tool allowlist + risk tags | **Align** | Merge QM-style hard denials into `sandbox.ts` / tool risk |
| Scoped memory | memory layers | **Yes** | Bind `remember` to `session.profile_id` / scope; USER.md per scope |
| Skill promote org-wide | skill_registry + approve | **Yes** | “Promote” = admin approve → `active` + optional scope=`org` |
| Deploy directory | `deploy/` | **Already** | Keep org secrets/Caddy/token out of core |
| Postgres | SQLite | **Later** | Only when multi-node queue needs it; SQLite fine for single-node Chamber |
| Cloud-first Fly/AWS | Optional compose | **Optional** | Not required for kernel |

---

## What **not** to port

| QM / Hermes trait | Why skip |
|-------------------|----------|
| Auto tool loop without pause in “Dangerous” | Violates Chamber fail-closed |
| Agent acts fully as user with their creds by default | Needs explicit grant + audit per secret |
| Skills that self-activate from experience | Learning loop stays **propose-only** |
| Classifier-only screening as sole control | Use as **input** to faculty/debt, not replacement |
| Replacing faculty with Slack emoji reacts | Human approve queue can *integrate* Slack reactions later — not replace ledger |

---

## Concrete Chamber modules to add (ordered)

### 1. Plugin surface contract (½–1 day)

```ts
// src/plugins/types.ts
export interface ChamberPlugin {
  name: string;
  start(ctx: {
    turn: (text: string, meta: { channel: string; scopeId: string }) => Promise<string>;
  }): Promise<void>;
  stop?(): Promise<void>;
}
```

Telegram / Slack / HTTP become plugins. **Only** entry is gated `turn`.

### 2. Scope row (1 day)

```sql
scope (id, kind: user|room|org, parent_id, policy: strict|auto)
```

Session, memory, skill_registry gain `scope_id`. Activate skill checks scope policy + existing holds/faculty.

### 3. Durable job queue (1–2 days)

```sql
job_queue (
  id, kind, payload_json, status, attempts,
  run_after, locked_by, last_error
)
```

Workers: `expiry`, `cron`, `dream`, `oauth_refresh`.  
Each job handler calls **existing** gated functions — queue is transport, not authority.

### 4. Posture config (½ day)

```ts
CHAMBER_POSTURE=strict|auto   // no "dangerous" default
```

- `strict`: every skill/tool activate → pending_write  
- `auto`: routine stakes may auto-approve **only** via existing workflow table; elevated still human/faculty  

### 5. Harness adapter interface (1 day)

```ts
interface ModelHarness {
  id: string;
  complete(req: CompleteRequest): CompleteResult;
}
```

Register stub / Ollama / API. Spend + contract still wrap every completion.

---

## Security posture mapping

| QM | Chamber equivalent |
|----|-------------------|
| Strict | `approvals` always + faculty on elevated |
| Auto | Classifier optional **before** `commitBelief`; debt still blocks |
| Dangerous | **Do not implement** as a product default |

Command hard denials (rm -rf, DROP TABLE, …) → extend sandbox allowlist denials (already partially there).

---

## Suggested 5-day port sprint

| Day | Deliverable |
|-----|-------------|
| 1 | `ChamberPlugin` + move Telegram runner behind it |
| 2 | `scope` schema + session/memory bind |
| 3 | `job_queue` + worker for expiry/cron |
| 4 | Posture env + hard denial list alignment |
| 5 | `ModelHarness` interface + docs |

Exit criteria: same 70+ harness tests green; one plugin posts into gated turn; cron via queue not inline only.

---

## Bottom line

| Take from QM | Keep in Chamber |
|--------------|-----------------|
| Plugin surfaces, scopes, durable queue, deploy dir, posture names | Debt, faculty, no self-approve, MMR audit, OAuth pin/quarantine |

QM is a **company fleet harness**. Chamber is a **constitution**. Port the fleet machinery; do not port “trust the loop.”
