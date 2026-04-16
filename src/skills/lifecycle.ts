/**
 * Skill lifecycle state machine (plan §5.5.5 — Phase 3.7).
 *
 * Manages skill trust progression from unvetted → user-trusted →
 * system-trusted, with quarantine/deprecation paths for failing skills.
 *
 * Valid transitions:
 *   unvetted → user-trusted        (first install confirm)
 *   user-trusted → system-trusted  (20 successful autonomous uses)
 *   system-authored → system-trusted (20 successful uses)
 *   * → quarantined                (failure rate > 30% rolling 7d)
 *   quarantined → deprecated       (3 failed evolution attempts)
 *   deprecated → user-trusted      (manual user resurrection)
 */

import type { SkillRegistryDB } from "./skill-registry-db.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SkillLifecycleState =
  | "unvetted"
  | "user-trusted"
  | "system-trusted"
  | "system-authored"
  | "quarantined"
  | "deprecated";

export interface LifecycleTransition {
  from: SkillLifecycleState;
  to: SkillLifecycleState;
  trigger: string;
  timestamp: Date;
}

/**
 * Minimal interface for usage ledger queries.
 * Stubbed here so lifecycle.ts compiles without Agent A's file.
 */
export interface UsageLedgerLike {
  successRate(skillId: string, days: number): number;
  bySkill(skillId: string, days: number): Array<{ outcome: string }>;
}

export interface LifecycleDeps {
  registry: SkillRegistryDB;
  ledger: UsageLedgerLike;
  /** Count of failed evolution attempts for a skill (rolling 7d). */
  failedEvolutionCount?: (skillId: string) => number;
  /** Override clock for tests. */
  now?: () => Date;
}

// ─── Transition table ───────────────────────────────────────────────────────

interface TransitionRule {
  from: SkillLifecycleState;
  to: SkillLifecycleState;
}

/**
 * All explicitly allowed transitions. The `* → quarantined` wildcard is
 * handled separately — every non-quarantined/non-deprecated state may
 * transition to quarantined.
 */
const EXPLICIT_TRANSITIONS: readonly TransitionRule[] = [
  { from: "unvetted", to: "user-trusted" },
  { from: "user-trusted", to: "system-trusted" },
  { from: "system-authored", to: "system-trusted" },
  { from: "quarantined", to: "deprecated" },
  { from: "deprecated", to: "user-trusted" },
] as const;

const QUARANTINABLE: ReadonlySet<SkillLifecycleState> = new Set([
  "unvetted",
  "user-trusted",
  "system-trusted",
  "system-authored",
]);

// ─── Errors ─────────────────────────────────────────────────────────────────

export class LifecycleError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_TRANSITION" | "SKILL_NOT_FOUND",
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const AUTO_PROMOTE_THRESHOLD = 20;
const QUARANTINE_FAILURE_RATE = 0.3;
const DEPRECATION_EVOLUTION_FAILURES = 3;
const ROLLING_WINDOW_DAYS = 7;

// ─── Class ──────────────────────────────────────────────────────────────────

export class SkillLifecycle {
  /**
   * Check whether a state transition is structurally valid,
   * without looking at any data.
   */
  canTransition(
    current: SkillLifecycleState,
    target: SkillLifecycleState,
  ): boolean {
    // Wildcard: any quarantinable state → quarantined
    if (target === "quarantined" && QUARANTINABLE.has(current)) {
      return true;
    }

    return EXPLICIT_TRANSITIONS.some(
      (r) => r.from === current && r.to === target,
    );
  }

  /**
   * Perform a lifecycle transition, persisting the new trust level.
   * Throws LifecycleError if the transition is invalid or the skill
   * does not exist.
   */
  transition(
    skillId: string,
    target: SkillLifecycleState,
    trigger: string,
    deps: { registry: SkillRegistryDB; now?: () => Date },
  ): LifecycleTransition {
    const row = deps.registry.get(skillId);
    if (!row) {
      throw new LifecycleError(
        `skill "${skillId}" not found`,
        "SKILL_NOT_FOUND",
      );
    }

    const current = row.trust_level as SkillLifecycleState;
    if (!this.canTransition(current, target)) {
      throw new LifecycleError(
        `invalid transition: ${current} → ${target}`,
        "INVALID_TRANSITION",
      );
    }

    // Persist: SkillRegistryDB only knows the original TrustLevel union.
    // For states it doesn't have (system-authored, deprecated), we use
    // setTrustLevel which does a raw SQL UPDATE.
    deps.registry.setTrustLevel(
      skillId,
      target as Parameters<SkillRegistryDB["setTrustLevel"]>[1],
    );

    const now = deps.now?.() ?? new Date();
    return { from: current, to: target, trigger, timestamp: now };
  }

  /**
   * Run automatic transition rules against a skill and return the first
   * applicable transition, or null if none apply.
   *
   * Rules checked in order:
   * 1. Quarantine: failure rate > 30% over rolling 7d (min 5 runs)
   * 2. Deprecate: quarantined + 3 failed evolutions
   * 3. Auto-promote: user-trusted/system-authored → system-trusted at 20 successes
   */
  checkAutoTransitions(
    skillId: string,
    deps: LifecycleDeps,
  ): LifecycleTransition | null {
    const row = deps.registry.get(skillId);
    if (!row) return null;

    const current = row.trust_level as SkillLifecycleState;
    const nowFn = deps.now ?? (() => new Date());

    // Rule 1: Quarantine on high failure rate
    if (QUARANTINABLE.has(current)) {
      const runs = deps.ledger.bySkill(skillId, ROLLING_WINDOW_DAYS);
      if (runs.length >= 5) {
        const rate = deps.ledger.successRate(skillId, ROLLING_WINDOW_DAYS);
        const failureRate = 1 - rate;
        if (failureRate > QUARANTINE_FAILURE_RATE) {
          return this.transition(skillId, "quarantined", "auto:high-failure-rate", {
            registry: deps.registry,
            now: nowFn,
          });
        }
      }
    }

    // Rule 2: Deprecate after repeated evolution failures
    if (current === "quarantined" && deps.failedEvolutionCount) {
      const failures = deps.failedEvolutionCount(skillId);
      if (failures >= DEPRECATION_EVOLUTION_FAILURES) {
        return this.transition(skillId, "deprecated", "auto:evolution-failures-exceeded", {
          registry: deps.registry,
          now: nowFn,
        });
      }
    }

    // Rule 3: Auto-promote to system-trusted
    if (current === "user-trusted" || current === "system-authored") {
      const runs = deps.ledger.bySkill(skillId, ROLLING_WINDOW_DAYS);
      const successes = runs.filter((r) => r.outcome === "success").length;
      if (successes >= AUTO_PROMOTE_THRESHOLD) {
        return this.transition(skillId, "system-trusted", "auto:promotion-threshold", {
          registry: deps.registry,
          now: nowFn,
        });
      }
    }

    return null;
  }
}
