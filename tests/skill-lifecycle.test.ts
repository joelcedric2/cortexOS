import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SkillRegistryDB } from "../src/skills/skill-registry-db.js";
import {
  SkillLifecycle,
  LifecycleError,
  type SkillLifecycleState,
  type UsageLedgerLike,
  type LifecycleDeps,
} from "../src/skills/lifecycle.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLedger(opts: {
  successRate?: number;
  runs?: Array<{ outcome: string }>;
}): UsageLedgerLike {
  return {
    successRate: () => opts.successRate ?? 1.0,
    bySkill: () => opts.runs ?? [],
  };
}

function insertSkill(
  db: SkillRegistryDB,
  id: string,
  trust: string = "unvetted",
): void {
  db.insert({ id, name: id, trust_level: trust as "unvetted" });
}

const NOW = new Date("2026-04-15T00:00:00Z");

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SkillLifecycle", () => {
  let db: SkillRegistryDB;
  let lc: SkillLifecycle;

  beforeEach(() => {
    db = new SkillRegistryDB({ dbPath: ":memory:" });
    lc = new SkillLifecycle();
  });

  afterEach(() => {
    db.close();
  });

  // ─── canTransition ──────────────────────────────────────────────────────

  describe("canTransition", () => {
    const validPairs: Array<[SkillLifecycleState, SkillLifecycleState]> = [
      ["unvetted", "user-trusted"],
      ["user-trusted", "system-trusted"],
      ["system-authored", "system-trusted"],
      ["quarantined", "deprecated"],
      ["deprecated", "user-trusted"],
      // wildcard → quarantined
      ["unvetted", "quarantined"],
      ["user-trusted", "quarantined"],
      ["system-trusted", "quarantined"],
      ["system-authored", "quarantined"],
    ];

    for (const [from, to] of validPairs) {
      test(`allows ${from} → ${to}`, () => {
        assert.equal(lc.canTransition(from, to), true);
      });
    }

    const invalidPairs: Array<[SkillLifecycleState, SkillLifecycleState]> = [
      ["unvetted", "system-trusted"],
      ["unvetted", "deprecated"],
      ["user-trusted", "unvetted"],
      ["system-trusted", "user-trusted"],
      ["quarantined", "system-trusted"],
      ["quarantined", "quarantined"],
      ["deprecated", "system-trusted"],
      ["deprecated", "quarantined"],
    ];

    for (const [from, to] of invalidPairs) {
      test(`rejects ${from} → ${to}`, () => {
        assert.equal(lc.canTransition(from, to), false);
      });
    }
  });

  // ─── transition ─────────────────────────────────────────────────────────

  describe("transition", () => {
    test("performs valid transition and persists", () => {
      insertSkill(db, "sk-1", "unvetted");
      const result = lc.transition("sk-1", "user-trusted", "install-confirm", {
        registry: db,
        now: () => NOW,
      });

      assert.equal(result.from, "unvetted");
      assert.equal(result.to, "user-trusted");
      assert.equal(result.trigger, "install-confirm");
      assert.deepEqual(result.timestamp, NOW);

      // Verify persisted
      const row = db.get("sk-1");
      assert.equal(row?.trust_level, "user-trusted");
    });

    test("throws SKILL_NOT_FOUND for missing skill", () => {
      assert.throws(
        () =>
          lc.transition("nonexistent", "user-trusted", "test", {
            registry: db,
          }),
        (err: LifecycleError) => {
          assert.equal(err.code, "SKILL_NOT_FOUND");
          return true;
        },
      );
    });

    test("throws INVALID_TRANSITION for disallowed transition", () => {
      insertSkill(db, "sk-2", "unvetted");
      assert.throws(
        () =>
          lc.transition("sk-2", "system-trusted", "test", {
            registry: db,
          }),
        (err: LifecycleError) => {
          assert.equal(err.code, "INVALID_TRANSITION");
          return true;
        },
      );
    });

    test("quarantines any quarantinable state", () => {
      insertSkill(db, "sk-3", "system-trusted");
      const result = lc.transition("sk-3", "quarantined", "high-failure-rate", {
        registry: db,
        now: () => NOW,
      });
      assert.equal(result.from, "system-trusted");
      assert.equal(result.to, "quarantined");
      assert.equal(db.get("sk-3")?.trust_level, "quarantined");
    });

    test("deprecated → user-trusted (resurrection)", () => {
      insertSkill(db, "sk-4", "deprecated" as "unvetted");
      const result = lc.transition("sk-4", "user-trusted", "user-resurrect", {
        registry: db,
        now: () => NOW,
      });
      assert.equal(result.from, "deprecated");
      assert.equal(result.to, "user-trusted");
    });
  });

  // ─── checkAutoTransitions ───────────────────────────────────────────────

  describe("checkAutoTransitions", () => {
    test("quarantines when failure rate > 30% (min 5 runs)", () => {
      insertSkill(db, "sk-a", "user-trusted");
      const runs = [
        { outcome: "success" },
        { outcome: "failure" },
        { outcome: "failure" },
        { outcome: "failure" },
        { outcome: "failure" },
      ];
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({ successRate: 0.2, runs }),
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-a", deps);
      assert.ok(result);
      assert.equal(result.to, "quarantined");
      assert.equal(result.trigger, "auto:high-failure-rate");
    });

    test("does not quarantine with < 5 runs", () => {
      insertSkill(db, "sk-b", "user-trusted");
      const runs = [
        { outcome: "failure" },
        { outcome: "failure" },
        { outcome: "failure" },
      ];
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({ successRate: 0.0, runs }),
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-b", deps);
      assert.equal(result, null);
    });

    test("does not quarantine when failure rate <= 30%", () => {
      insertSkill(db, "sk-c", "user-trusted");
      const runs = Array.from({ length: 10 }, () => ({ outcome: "success" }));
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({ successRate: 0.8, runs }),
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-c", deps);
      // Should not quarantine, may auto-promote
      if (result) {
        assert.notEqual(result.to, "quarantined");
      }
    });

    test("deprecates after 3 failed evolution attempts", () => {
      insertSkill(db, "sk-d", "quarantined");
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({}),
        failedEvolutionCount: () => 3,
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-d", deps);
      assert.ok(result);
      assert.equal(result.to, "deprecated");
      assert.equal(result.trigger, "auto:evolution-failures-exceeded");
    });

    test("does not deprecate with < 3 failed evolutions", () => {
      insertSkill(db, "sk-e", "quarantined");
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({}),
        failedEvolutionCount: () => 2,
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-e", deps);
      assert.equal(result, null);
    });

    test("auto-promotes user-trusted → system-trusted at 20 successes", () => {
      insertSkill(db, "sk-f", "user-trusted");
      const runs = Array.from({ length: 20 }, () => ({ outcome: "success" }));
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({ successRate: 1.0, runs }),
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-f", deps);
      assert.ok(result);
      assert.equal(result.to, "system-trusted");
      assert.equal(result.trigger, "auto:promotion-threshold");
    });

    test("auto-promotes system-authored → system-trusted at 20 successes", () => {
      insertSkill(db, "sk-g", "system-authored" as "unvetted");
      const runs = Array.from({ length: 25 }, () => ({ outcome: "success" }));
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({ successRate: 1.0, runs }),
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-g", deps);
      assert.ok(result);
      assert.equal(result.to, "system-trusted");
    });

    test("does not auto-promote with < 20 successes", () => {
      insertSkill(db, "sk-h", "user-trusted");
      const runs = Array.from({ length: 19 }, () => ({ outcome: "success" }));
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({ successRate: 1.0, runs }),
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-h", deps);
      assert.equal(result, null);
    });

    test("returns null for nonexistent skill", () => {
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({}),
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("nonexistent", deps);
      assert.equal(result, null);
    });

    test("quarantine takes priority over auto-promote", () => {
      insertSkill(db, "sk-i", "user-trusted");
      // 20+ runs but high failure rate
      const runs = [
        ...Array.from({ length: 20 }, () => ({ outcome: "success" })),
        ...Array.from({ length: 30 }, () => ({ outcome: "failure" })),
      ];
      const deps: LifecycleDeps = {
        registry: db,
        ledger: makeLedger({ successRate: 0.4, runs }),
        now: () => NOW,
      };
      const result = lc.checkAutoTransitions("sk-i", deps);
      assert.ok(result);
      assert.equal(result.to, "quarantined");
    });
  });
});
