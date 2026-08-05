/**
 * try_activate_skill() — transactional skill activation gate (Chamber week-1).
 *
 * Law:
 * - executable ⇔ zero open holds (FM-2)
 * - load_bearing + stale/expired/defeated belief → open belief_stale hold (FM-1)
 * - mutation delta vs last CRITIC-CLEARED snapshot only (FM-3)
 * - a gate releases only its own hold kind
 * - capability_manifest: deny over-ask when present
 * - fork C: shadow mode logs shadow_would_refuse but may still activate until flip
 */

import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit.ts";
import { newId } from "./hash.ts";
import type { ActivateResult, ActivateSkillInput } from "./types.ts";
import { openDeliberation } from "./faculty.ts";
import { skillSecretScanRefuse } from "./secret_scan.ts";

function emitGate(
  db: DatabaseSync,
  row: {
    turnId?: string;
    gate: string;
    action: string;
    subjectKind?: string;
    subjectId?: string;
    detail?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO gate_event (id, turn_id, gate, action, subject_kind, subject_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId("ge"),
    row.turnId ?? null,
    row.gate,
    row.action,
    row.subjectKind ?? null,
    row.subjectId ?? null,
    row.detail ? JSON.stringify(row.detail) : null,
  );

  // Mirrored into the hash-chained log for the reason given at the identical
  // point in src/commit_belief.ts: `gate_event` is unchained, and the decision
  // about whether a skill may mutate anything belongs in the tamper-evident
  // record rather than beside it. `appendAudit` self-selects between opening
  // its own transaction and joining the caller's, which this file needs —
  // emitGate runs here both before the BEGIN IMMEDIATE and inside it.
  appendAudit(db, {
    category: "gate",
    action: `${row.gate}:${row.action}`,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    turnId: row.turnId,
    detail: { gate: row.gate, decision: row.action, ...(row.detail ?? {}) },
  });
}

/**
 * Record a refusal that has just been rolled back.
 *
 * Runs outside any transaction, so both the `gate_event` row and the chained
 * `audit_event` row autocommit and survive. Wrapped because this is the last
 * act before returning REFUSED: a failure to *write the record* must not
 * replace a clean refusal with a thrown exception, which would lose the
 * refusal itself on top of losing its record.
 */
function emitRefusal(
  db: DatabaseSync,
  row: Parameters<typeof emitGate>[1],
): void {
  try {
    emitGate(db, row);
  } catch {
    /* best-effort, as in src/commit_belief.ts */
  }
}

function suspensionMode(db: DatabaseSync): "shadow" | "teeth" {
  const flip = db
    .prepare(`SELECT value FROM chamber_config WHERE key = 'suspension_flip_at'`)
    .get() as { value: string } | undefined;
  const mode = db
    .prepare(`SELECT value FROM chamber_config WHERE key = 'suspension_mode'`)
    .get() as { value: string } | undefined;

  if (flip?.value) {
    const flipAt = Date.parse(flip.value);
    if (!Number.isNaN(flipAt) && Date.now() >= flipAt) {
      return "teeth";
    }
  }
  return mode?.value === "teeth" ? "teeth" : "shadow";
}

function openHolds(db: DatabaseSync, skillId: string): { id: string; kind: string }[] {
  return db
    .prepare(
      `SELECT id, kind FROM skill_holds
       WHERE skill_id = ? AND released_at IS NULL`,
    )
    .all(skillId) as { id: string; kind: string }[];
}

function latestClearedSnapshot(
  db: DatabaseSync,
  skillId: string,
): { id: string; cleared_hash: string | null; capability_manifest: string | null } | undefined {
  return db
    .prepare(
      `SELECT id, cleared_hash, capability_manifest FROM skill_snapshot
       WHERE name = ?
         AND critic_clearance = 'passed'
         AND cleared_hash IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(skillId) as
    | { id: string; cleared_hash: string | null; capability_manifest: string | null }
    | undefined;
}

function openHold(
  db: DatabaseSync,
  skillId: string,
  kind: string,
  gate: string,
  beliefId?: string,
): string {
  const id = newId("hld");
  db.prepare(
    `INSERT INTO skill_holds (id, skill_id, kind, created_by_gate, belief_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, skillId, kind, gate, beliefId ?? null);
  emitGate(db, {
    gate: "hold",
    action: kind === "shadow_would_refuse" ? "shadow_would_refuse" : "suspended",
    subjectKind: "skill",
    subjectId: skillId,
    detail: { holdId: id, kind, beliefId },
  });
  return id;
}

export function tryActivateSkill(
  db: DatabaseSync,
  input: ActivateSkillInput,
): ActivateResult {
  const { skillId, currentContentHash, requestedCapabilities = [], turnId } = input;
  const mode = suspensionMode(db);
  const wouldRefuse: string[] = [];

  try {
    db.exec("BEGIN IMMEDIATE");

    // 1. Existing open holds
    const holds = openHolds(db, skillId);
    if (holds.length > 0) {
      const ids = holds.map((h) => h.id);
      // Emitted *after* the rollback, not before it. A gate row written inside
      // this transaction is discarded along with everything else the rollback
      // undoes — so the refusal landed in neither `gate_event` nor
      // `audit_event`, and no table anywhere recorded that a skill had been
      // blocked. src/commit_belief.ts already does it in this order.
      db.exec("ROLLBACK");
      emitRefusal(db, {
        turnId,
        gate: "hold",
        action: "blocked",
        subjectKind: "skill",
        subjectId: skillId,
        detail: { holdIds: ids },
      });
      return {
        ok: false,
        status: "REFUSED",
        holdIds: ids,
        reason: "open skill holds",
      };
    }

    // 1b. Credential pattern scan on skill body (fail closed)
    const skillRow = db
      .prepare(
        `SELECT body, content_hash AS contentHash FROM skill_registry WHERE id = ?`,
      )
      .get(skillId) as { body: string; contentHash: string } | undefined;
    if (skillRow?.body) {
      const secretRefuse = skillSecretScanRefuse(skillRow.body);
      if (secretRefuse) {
        // After the rollback — see the note on the open-holds path above. This
        // is the refusal that most needed recording: a skill blocked for
        // carrying a credential pattern left no trace at all.
        db.exec("ROLLBACK");
        emitRefusal(db, {
          turnId,
          gate: "hold",
          action: "blocked",
          subjectKind: "skill",
          subjectId: skillId,
          detail: { reason: "secret_scan" },
        });
        return {
          ok: false,
          status: "REFUSED",
          holdIds: [],
          reason: secretRefuse,
        };
      }
    }

    // 2. Load-bearing dependency freshness (FM-1)
    const deps = db
      .prepare(
        `SELECT sd.belief_id, sd.load_bearing, b.status AS belief_status
         FROM skill_dependencies sd
         JOIN belief b ON b.id = sd.belief_id
         WHERE sd.skill_id = ?`,
      )
      .all(skillId) as {
      belief_id: string;
      load_bearing: number;
      belief_status: string;
    }[];

    for (const dep of deps) {
      if (
        dep.load_bearing === 1 &&
        ["expired", "suspended", "superseded"].includes(dep.belief_status)
      ) {
        if (mode === "teeth") {
          const hid = openHold(
            db,
            skillId,
            "belief_stale",
            "expiry",
            dep.belief_id,
          );
          db.exec("COMMIT");
          return {
            ok: false,
            status: "REFUSED",
            holdIds: [hid],
            reason: `load_bearing belief stale: ${dep.belief_id}`,
          };
        }
        // shadow: record what teeth would do, continue
        openHold(db, skillId, "shadow_would_refuse", "expiry", dep.belief_id);
        wouldRefuse.push(`stale:${dep.belief_id}`);
      }
    }

    // 3. Mutation vs last CLEARED snapshot (FM-3)
    const cleared = latestClearedSnapshot(db, skillId);
    if (!cleared || !cleared.cleared_hash) {
      if (mode === "teeth") {
        const hid = openHold(db, skillId, "mutation_pending", "mutation");
        db.exec("COMMIT");
        return {
          ok: false,
          status: "REFUSED",
          holdIds: [hid],
          reason: "no critic-cleared snapshot",
        };
      }
      openHold(db, skillId, "shadow_would_refuse", "mutation");
      wouldRefuse.push("no_cleared_snapshot");
    } else if (cleared.cleared_hash !== currentContentHash) {
      if (mode === "teeth") {
        const hid = openHold(db, skillId, "mutation_pending", "mutation");
        emitGate(db, {
          turnId,
          gate: "mutation",
          action: "blocked",
          subjectKind: "skill",
          subjectId: skillId,
          detail: {
            cleared_hash: cleared.cleared_hash,
            current: currentContentHash,
          },
        });
        db.exec("COMMIT");
        return {
          ok: false,
          status: "REFUSED",
          holdIds: [hid],
          reason: "content diverged from last critic-cleared snapshot",
        };
      }
      openHold(db, skillId, "shadow_would_refuse", "mutation");
      wouldRefuse.push("mutation_delta");
      emitGate(db, {
        turnId,
        gate: "mutation",
        action: "shadow_would_refuse",
        subjectKind: "skill",
        subjectId: skillId,
      });
    }

    // 4. Capability manifest (when present)
    if (cleared?.capability_manifest) {
      let manifest: string[] = [];
      try {
        manifest = JSON.parse(cleared.capability_manifest) as string[];
      } catch {
        db.exec("ROLLBACK");
        return {
          ok: false,
          status: "REFUSED",
          holdIds: [],
          reason: "capability_manifest JSON invalid — fail closed",
        };
      }
      const over = requestedCapabilities.filter((c) => !manifest.includes(c));
      if (over.length > 0) {
        // After the rollback — see the note on the open-holds path above.
        db.exec("ROLLBACK");
        emitRefusal(db, {
          turnId,
          gate: "manifest",
          action: "blocked",
          subjectKind: "skill",
          subjectId: skillId,
          detail: { over },
        });
        return {
          ok: false,
          status: "REFUSED",
          holdIds: [],
          reason: `capabilities not in manifest: ${over.join(",")}`,
        };
      }
    } else {
      emitGate(db, {
        turnId,
        gate: "manifest",
        action: "absent",
        subjectKind: "skill",
        subjectId: skillId,
      });
    }

    // 5. Faculty parliament for elevated/consequential (or config faculty_required_on_activate)
    const stakes = input.stakes ?? "routine";
    const facultyRequired =
      !input.skipFaculty &&
      (stakes === "elevated" ||
        stakes === "consequential" ||
        (
          db
            .prepare(
              `SELECT value FROM chamber_config WHERE key = 'faculty_required_on_activate'`,
            )
            .get() as { value: string } | undefined
        )?.value === "1");

    let deliberationId: string | undefined;
    if (facultyRequired) {
      const delib = openDeliberation(db, {
        subjectKind: "skill",
        subjectId: skillId,
        question: `Activate skill ${skillId}?`,
        stakes: stakes === "routine" ? "elevated" : stakes,
        context: {
          isSkillMutation: true,
          riskTags: input.riskTags,
          hasSources: true,
        },
      });
      deliberationId = delib.id;
      if (delib.status !== "passed") {
        emitGate(db, {
          turnId,
          gate: "activate",
          action: "blocked",
          subjectKind: "skill",
          subjectId: skillId,
          detail: {
            deliberationId: delib.id,
            status: delib.status,
            outcome: delib.outcome,
          },
        });
        db.exec("COMMIT");
        return {
          ok: false,
          status: "REFUSED",
          holdIds: [],
          reason: `faculty ${delib.status}: ${delib.outcome}`,
          deliberationId: delib.id,
        };
      }
    }

    emitGate(db, {
      turnId,
      gate: "activate",
      action: "activated",
      subjectKind: "skill",
      subjectId: skillId,
      detail: { mode, wouldRefuse, deliberationId },
    });

    db.exec("COMMIT");
    return {
      ok: true,
      mode: wouldRefuse.length > 0 ? "shadow_activated" : "activated",
      deliberationId,
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    try {
      emitGate(db, {
        turnId,
        gate: "activate",
        action: "failed_closed",
        subjectKind: "skill",
        subjectId: skillId,
        detail: { error: String(err) },
      });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      status: "REFUSED",
      holdIds: [],
      reason: `activate failed closed: ${String(err)}`,
    };
  }
}

/**
 * Release a hold — ONLY the same gate kind that opened it (FM-2).
 */
export function releaseHold(
  db: DatabaseSync,
  holdId: string,
  releasedByGate: string,
  expectedKind: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db
      .prepare(
        `SELECT id, kind, created_by_gate, released_at FROM skill_holds WHERE id = ?`,
      )
      .get(holdId) as
      | {
          id: string;
          kind: string;
          created_by_gate: string;
          released_at: string | null;
        }
      | undefined;

    if (!row) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "hold not found" };
    }
    if (row.released_at) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "hold already released" };
    }
    if (row.kind !== expectedKind) {
      db.exec("ROLLBACK");
      emitGate(db, {
        gate: "hold",
        action: "blocked",
        subjectId: holdId,
        detail: {
          reason: "kind_mismatch",
          expected: expectedKind,
          actual: row.kind,
        },
      });
      return { ok: false, reason: "gate may only release its own hold kind" };
    }

    db.prepare(
      `UPDATE skill_holds
       SET released_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), released_by = ?
       WHERE id = ?`,
    ).run(releasedByGate, holdId);

    emitGate(db, {
      gate: "hold",
      action: "released",
      subjectId: holdId,
      detail: { kind: row.kind, by: releasedByGate },
    });

    db.exec("COMMIT");
    return { ok: true };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return { ok: false, reason: String(err) };
  }
}