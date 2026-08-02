# Chamber week-1 acceptance tests

If any of these fail, Chamber is Hermes-with-paperwork.

| # | Name | Pass condition |
|---|------|----------------|
| 1 | `debt_blocks_commit` | Open blocking `citation_debt` on claim scope → `commitBelief` returns `REJECTED`, **zero** new `belief` rows, `gate_event` with `action=blocked` exists. |
| 2 | `retraction_is_free` | Same open debts; commit `defeater` and `unknown` → both `ok: true`, **no** new blocking debt minted (FM-5). |
| 3 | `gate_write_atomicity` | Fault between check and insert → no belief row, no sources, no minted debt; `failed_closed` event (FM-6). |
| 4 | `timeout_parks` | Critic/waiver timeout → request `PARKED` / not authorized; retry does not auto-pass (FM-7). |
| 5 | `expiry_suspends_skill` | Expire belief with `skill_dependencies.load_bearing=1` → `tryActivateSkill` REFUSED (teeth mode) and exactly one open `belief_stale` hold (FM-1). |
| 6 | `mutation_vs_cleared_only` | After critic-clear, mutate skill twice without critic → quarantine vs **cleared** hash, not last write (FM-3). |
| 7 | `gate_releases_own_kind` | Expiry gate attempts to release `mutation_pending` hold → rejected; hold remains open (FM-2). |
| 8 | `fast_path_zero_faculty_calls` | Pure observation/inference turn → faculty model invocation counter **== 0**. |
| 9 | `router_uncertainty_fails_deep` | Router confidence below threshold → route is `deep_lite`, never `fast`. |
| 10 | `claim_hash_inherits_debt` | Re-assert existing `claim_hash` as revision → parent open blocking debts attach; child commit blocks until paid. |

## Instrumentation alerts (ship with gates)

| ID | Query intent | Alert |
|----|--------------|-------|
| M1 | Debt blocks / 7d | `= 0` (dead) or `> 30/100 turns` (inflation) |
| M2 | Waiver rate + median decision latency | rate `> 60%` or median `< 30s` or TTL lapse `> 20%` |
| M3 | Active beliefs past `expires_at` without open ticket | count `> 0` ever |
| M4 | Hold `breach` vs `blocked` | any `breach > 0` = P0 |
| M5 | `skill_snapshot` hash changes − mutation gate events | `≠ 0` |
| M6 | `belief` rows with `epistemic_type='belief' AND committed_path='fast'` | must be **0** |
| M7 | Same `claim_hash` debt minted ≥ 3× in 30d | any hit |

## Shadow mode (fork C)

- Config: `suspension_mode=shadow`, `suspension_flip_at=now+7d` written at ship.
- Days 0–7: stale/mutation checks open `shadow_would_refuse` holds and emit events; activation may return `shadow_activated`.
- After flip: real `REFUSED` + `belief_stale` / `mutation_pending` holds.
