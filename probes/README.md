# Probes

Runnable evidence for the findings in `docs/REVIEW_2026-08-02.md`. These are not
tests — they are demonstrations that a defect is real, written so the defect can
be re-proven rather than taken on faith.

**Each probe exits `1` while the defect is present and `0` once it is fixed.**
That inversion is deliberate: when a probe starts passing, promote it into
`tests/harness.ts` as a negative regression test and delete it from here.

| Probe | Proves | Fixed by |
|-------|--------|----------|
| `sandbox_escape.ts` | `CHAMBER_SANDBOX_REQUIRED=1` is a no-op; sandboxed code reads/writes `$HOME` and reaches the network | Phase 1.1 |
| `gate_audit.ts` | `commit_belief` / `try_activate_skill` write only unchained `gate_event` | Phase 1.2 |
| `pin_bypass.ts` | The citation gate is satisfied by a fabricated source pin | Phase 1.3 |
| `debt_paraphrase.ts` | Citation debt blocks verbatim repetition only; a paraphrase of a blocked claim commits freely | — |
| `verify_partial_drift.ts` | A belief losing only some pins still makes `chamber verify` exit 0 | — |
| `harness_declaration_guards.ts` | A test declared past the harness's drain loop or summary is never invoked, and the suite still prints `N/N passed`, exit 0 | 2026-08-16 |
| `seatbelt/` | What macOS `sandbox-exec` can and cannot enforce — read before writing the seatbelt backend | Phase 1.1 |

## Run

```bash
CHAMBER_SANDBOX_REQUIRED=1 node --experimental-strip-types probes/sandbox_escape.ts
node --experimental-strip-types probes/gate_audit.ts
node --experimental-strip-types probes/pin_bypass.ts
node --experimental-strip-types probes/debt_paraphrase.ts
node --experimental-strip-types probes/verify_partial_drift.ts
node --experimental-strip-types probes/harness_declaration_guards.ts
```

Or all of them: `npm run probes` (reports which defects are still present).

## Why these exist

The suite is 99/99 green and every one of these defects survives it. The existing
sandbox test (`tests/harness.ts:992`) asserts only that `echo` runs and produces
output — it never asserts that the sandbox *isolates* anything. Tests that assert
the property you already believed will stay green through exactly this class of
failure. These probes assert the property nobody checked.
