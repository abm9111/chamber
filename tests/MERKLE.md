# Merkle root verification

## Model

```text
Leaves     = audit_event.entry_hash in seq order for [from_seq, to_seq]
Parent     = sha256(leftHex || rightHex)
Odd node   = sha256(x || x)
Checkpoint = stored root_hash + range + checkpoint_link to previous root
Tip        = latest published root (merkle_tip)
```

Algorithm id: `sha256_binary_merkle_v1`

## API

| Function | Role |
|----------|------|
| `buildMerkleLayers` | Pure tree build |
| `proveInclusion` / `verifyInclusionProof` | Leaf ↔ root proof |
| `createMerkleCheckpoint` | Persist root for a seq range |
| `proveAuditSeq` | Proof that audit seq is in a checkpoint |
| `verifyMerkleCheckpoint` | Recompute root vs stored |
| `verifyCheckpointChain` | Link between successive roots |
| `maybeAutoCheckpoint` | Every N new events (default 64) |
| `getMerkleTip` | Current published root |

## Acceptance

| # | Name | Pass |
|---|------|------|
| M1 | root stable | Same leaves → same root |
| M2 | inclusion ok | `verifyInclusionProof(proveInclusion(leaves, i))` ok for all i |
| M3 | bad sibling fails | Flip one sibling → verify fails |
| M4 | checkpoint roundtrip | create → verifyMerkleCheckpoint ok |
| M5 | seq proof | proveAuditSeq(seq) verifies against checkpoint root |
| M6 | chain link | Second checkpoint `checkpoint_link` binds to first root |
| M7 | tamper leaves | Change audit entry_hash in range → verifyMerkleCheckpoint fails |

## Integration

```text
after appendAudit batch / dream cycle:
  maybeAutoCheckpoint(db)

export / external pin:
  getMerkleTip(db) → publish root_hash + checkpoint id

dispute / audit request:
  proveAuditSeq(db, seq) → hand proof + root to verifier
```

## Config

```text
merkle.enabled = on
merkle.auto_checkpoint_every_n = 64
```
