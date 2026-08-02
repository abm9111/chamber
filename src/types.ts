/** Chamber week-1 types — aligned with sql/schema.sql */

export type EpistemicType =
  | "observation"
  | "inference"
  | "belief"
  | "commitment"
  | "unknown"
  | "defeater";

export type Stakes = "routine" | "consequential";
export type CommittedPath = "fast" | "deep" | "deep_lite";

export type SourceKind =
  | "transcript"
  | "url"
  | "vault_page"
  | "x_tweet"
  | "belief";

export type HoldKind =
  | "mutation_pending"
  | "belief_stale"
  | "constitutional"
  | "manual"
  | "shadow_would_refuse";

export type GateName =
  | "debt"
  | "expiry"
  | "mutation"
  | "router"
  | "hold"
  | "aporia"
  | "commit"
  | "activate"
  | "dream"
  | "manifest";

export type GateAction =
  | "minted"
  | "blocked"
  | "passed"
  | "waived"
  | "escalated"
  | "suspended"
  | "released"
  | "timeout"
  | "breach"
  | "failed_closed"
  | "shadow_would_refuse"
  | "activated"
  | "proposed"
  | "absent";

export interface SourceRef {
  kind: SourceKind;
  refId: string;
  snapshotHash: string;
  spanHash?: string;
  contextHash?: string;
  provenance?: "direct" | "fts" | "vector" | "quoted_via" | "transcript";
  paysSubclaim?: string;
  retrieverFamily?: string;
}

export interface CommitBeliefInput {
  type: EpistemicType;
  text: string;
  sources: SourceRef[];
  authorFamily: string;
  sessionId?: string;
  revisionOf?: string | null;
  stakes?: Stakes;
  /** Fast path only allowed for observation | inference */
  path: CommittedPath;
  halfLifeSeconds?: number;
  turnId?: string;
}

export type CommitResult =
  | { ok: true; beliefId: string }
  | { ok: false; status: "REJECTED" | "PARKED"; reason: string; debtIds?: string[] };

export interface ActivateSkillInput {
  skillId: string;
  /** Current on-disk content hash of the skill body */
  currentContentHash: string;
  /** Tools/hosts/paths this activation wants to use */
  requestedCapabilities?: string[];
  turnId?: string;
  /** When elevated/consequential, faculty parliament must pass */
  stakes?: "routine" | "elevated" | "consequential";
  /** Skip faculty (tests / already deliberated) */
  skipFaculty?: boolean;
  riskTags?: string[];
}

export type ActivateResult =
  | {
      ok: true;
      mode: "activated" | "shadow_activated";
      deliberationId?: string;
    }
  | {
      ok: false;
      status: "REFUSED";
      holdIds: string[];
      reason: string;
      deliberationId?: string;
    };
