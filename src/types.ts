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
  /**
   * Refuse an assertion that ends up with no source surviving verification,
   * instead of committing it with citation debt. This is what `--strict`
   * means, and it can only be decided in here: whether a citation *survived*
   * is known only after commitBelief has re-checked every pin, so a caller
   * counting the sources it handed over cannot tell "cited nothing" from
   * "cited only things that failed". Off by default — debt is the everyday
   * answer.
   */
  requireVerifiedSupport?: boolean;
}

/**
 * A cited source the commit gate refused to count as support, and why.
 * Present on success as well as failure: a claim can commit while some of its
 * citations are dropped, and the caller must be able to see which.
 */
export interface RejectedSource {
  refId: string;
  reason: string;
}

export type CommitResult =
  | { ok: true; beliefId: string; rejectedSources?: RejectedSource[] }
  | {
      ok: false;
      status: "REJECTED" | "PARKED";
      reason: string;
      debtIds?: string[];
      rejectedSources?: RejectedSource[];
    };

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
