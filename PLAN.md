# Chamber plan (execution)

## Phase 1 — in progress / shipped this sprint

- [x] Model adapter (`src/model.ts`) — stub default; `CHAMBER_MODEL=openai` optional
- [x] Every completion → `recordSpend`
- [x] Evidence completion contracts (`src/contract.ts`) — strict refuse via `CHAMBER_STRICT_CONTRACT=1`
- [x] Expiry job (`src/expiry.ts`) — `chamber expiry` + auto on turn
- [x] CLI turn wired through model + contract + spend
- [x] Harness phase1 tests (34/34 total)

## Next

- Tree-sitter hybrid index (Merkle + AST chunks)
- Search → belief_source debt payment proposal
- Optional SCIP consumer
- Sandbox tool path

## Non-goals (unchanged)

No in-house compiler, no swarm theater, no “local = cloud quality” claims.
