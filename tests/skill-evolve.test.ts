import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  evolveSkill,
  evolveAllDue,
  type EvolveDeps,
  type FailureEntry,
  type PatchSet,
} from "../src/skills/evolve.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const SKILL_MD = `---
name: test-skill
version: 1.0.3
---
# test-skill
A skill for testing.
`;

const SKILL_SOURCE = `export function run(input: string): string {
  const data = JSON.parse(input);
  return data.value.toUpperCase();
}
`;

const PATCHED_SOURCE = `export function run(input: string): string {
  const data = JSON.parse(input);
  return (data.value ?? '').toUpperCase();
}
`;

const PATCH_RESPONSE: PatchSet = {
  files: [
    {
      path: "index.ts",
      before: "return data.value.toUpperCase();",
      after: "return (data.value ?? '').toUpperCase();",
    },
  ],
  rationale: "Guard against null/undefined value property",
};

function makeFailures(count: number, errorClass: string = "TypeError"): FailureEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    error_class: errorClass,
    error_message: `Cannot read properties of undefined (reading 'toUpperCase')`,
    timestamp: new Date(Date.now() - i * 3600_000).toISOString(),
    run_id: `run-${i}`,
  }));
}

interface MockFS {
  files: Map<string, string>;
  dirs: Set<string>;
  dirContents: Map<string, string[]>;
}

function makeMockFS(overrides?: Partial<MockFS>): MockFS {
  const files = overrides?.files ?? new Map<string, string>();
  const dirs = overrides?.dirs ?? new Set<string>();
  const dirContents = overrides?.dirContents ?? new Map<string, string[]>();
  return { files, dirs, dirContents };
}

function makeDeps(opts: {
  failures?: FailureEntry[];
  fs?: MockFS;
  patchResponse?: string;
  testExitCode?: number;
  testOutput?: string;
  recentEvolutionCount?: number;
  benchExists?: boolean;
  benchOrigMs?: number;
  benchPatchMs?: number;
  emitCalls?: Array<{ kind: string; payload: Record<string, unknown> }>;
}): EvolveDeps {
  const failures = opts.failures ?? [];
  const fs = opts.fs ?? makeMockFS();
  const emitCalls = opts.emitCalls ?? [];
  const testOutput = opts.testOutput ?? "ℹ tests 3\nℹ pass 3\nℹ fail 0";

  // Set up default FS for a valid skill (only when no custom fs provided)
  if (!opts.fs) {
    if (!fs.files.has("/skills/test-skill/SKILL.md")) {
      fs.files.set("/skills/test-skill/SKILL.md", SKILL_MD);
    }
    if (!fs.files.has("/skills/test-skill/index.ts")) {
      fs.files.set("/skills/test-skill/index.ts", SKILL_SOURCE);
    }
    fs.dirs.add("/skills/test-skill/tests");
    if (!fs.dirContents.has("/skills/test-skill/tests")) {
      fs.dirContents.set("/skills/test-skill/tests", ["run.test.ts"]);
    }
  }

  return {
    ledger: {
      failuresBySkill: () => failures,
    },
    readFile: async (path: string) => {
      const content = fs.files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path: string, content: string) => {
      fs.files.set(path, content);
    },
    exists: async (path: string) => {
      if (opts.benchExists !== undefined && path.endsWith("bench.ts")) {
        return opts.benchExists;
      }
      return fs.files.has(path) || fs.dirs.has(path);
    },
    readdir: async (path: string) => {
      return fs.dirContents.get(path) ?? [];
    },
    copyDir: async (src: string, dest: string) => {
      // Copy all files from src to dest
      for (const [key, value] of fs.files) {
        if (key.startsWith(src)) {
          const newKey = key.replace(src, dest);
          fs.files.set(newKey, value);
        }
      }
      for (const dir of fs.dirs) {
        if (dir.startsWith(src)) {
          fs.dirs.add(dir.replace(src, dest));
        }
      }
      for (const [key, value] of fs.dirContents) {
        if (key.startsWith(src)) {
          fs.dirContents.set(key.replace(src, dest), [...value]);
        }
      }
    },
    rmDir: async () => {
      // No-op in tests
    },
    runShell: async (cmd: string[]) => {
      // Git commands
      if (cmd[0] === "git") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Benchmark commands
      if (cmd.some((c) => c.includes("bench.ts"))) {
        const isOrig = cmd.some((c) => c.includes("/test-skill/bench.ts"));
        const ms = isOrig ? (opts.benchOrigMs ?? 100) : (opts.benchPatchMs ?? 105);
        return { exitCode: 0, stdout: `bench_ms: ${ms}`, stderr: "" };
      }
      // Test commands
      return {
        exitCode: opts.testExitCode ?? 0,
        stdout: testOutput,
        stderr: "",
      };
    },
    callHaiku: async () => {
      return opts.patchResponse ?? JSON.stringify(PATCH_RESPONSE);
    },
    skillsDir: "/skills",
    emit: (event) => {
      emitCalls.push(event as { kind: string; payload: Record<string, unknown> });
    },
    recentEvolutionCount: () => opts.recentEvolutionCount ?? 0,
    now: () => new Date("2026-04-15T00:00:00Z"),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("evolveSkill", () => {
  // ─── Happy path ─────────────────────────────────────────────────────────

  test("5 failures trigger evolution: patch passes, version bumps", async () => {
    const emitCalls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const deps = makeDeps({
      failures: makeFailures(5),
      emitCalls,
    });

    const result = await evolveSkill("test-skill", deps);

    assert.equal(result.evolved, true);
    assert.equal(result.fromVersion, "1.0.3");
    assert.equal(result.toVersion, "1.0.4");
    assert.equal(result.patchSummary, "Guard against null/undefined value property");
    assert.ok(result.validationResult);
    assert.equal(result.validationResult.passed, 3);
    assert.equal(result.validationResult.failed, 0);

    // Verify SKILL.md was updated
    const updatedMd = await deps.readFile("/skills/test-skill/SKILL.md");
    assert.ok(updatedMd.includes("version: 1.0.4"));
    assert.ok(updatedMd.includes("Guard against null/undefined value property"));

    // Verify source was patched
    const updatedSource = await deps.readFile("/skills/test-skill/index.ts");
    assert.ok(updatedSource.includes("(data.value ?? '')"));

    // Verify bus event
    assert.equal(emitCalls.length, 1);
    assert.equal(emitCalls[0].kind, "plan_emitted");
    assert.equal(emitCalls[0].payload.phase, "SKILL_EVOLVED");
    assert.equal(emitCalls[0].payload.fromVersion, "1.0.3");
    assert.equal(emitCalls[0].payload.toVersion, "1.0.4");
  });

  // ─── No failures ────────────────────────────────────────────────────────

  test("no failures → evolved: false", async () => {
    const deps = makeDeps({ failures: [] });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.equal(result.reason, "no_failure_clusters");
  });

  // ─── Failures below cluster threshold ───────────────────────────────────

  test("failures below cluster threshold (< 3) → no evolution", async () => {
    const deps = makeDeps({ failures: makeFailures(2) });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.equal(result.reason, "no_failure_clusters");
  });

  // ─── Validation failure ─────────────────────────────────────────────────

  test("failing validation → patch rejected", async () => {
    const deps = makeDeps({
      failures: makeFailures(5),
      testExitCode: 1,
      testOutput: "ℹ tests 3\nℹ pass 1\nℹ fail 2",
    });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.equal(result.reason, "validation_tests_failed");
    assert.ok(result.validationResult);
    assert.equal(result.validationResult.failed, 2);
  });

  // ─── No tests directory ─────────────────────────────────────────────────

  test("no tests → needs_tests, evolution skipped", async () => {
    const fs = makeMockFS();
    fs.files.set("/skills/test-skill/SKILL.md", SKILL_MD);
    fs.files.set("/skills/test-skill/index.ts", SKILL_SOURCE);
    // Deliberately not adding tests dir
    const deps = makeDeps({ failures: makeFailures(5), fs });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.equal(result.reason, "needs_tests");
  });

  // ─── Empty tests directory ──────────────────────────────────────────────

  test("empty tests dir → needs_tests", async () => {
    const fs = makeMockFS();
    fs.files.set("/skills/test-skill/SKILL.md", SKILL_MD);
    fs.files.set("/skills/test-skill/index.ts", SKILL_SOURCE);
    fs.dirs.add("/skills/test-skill/tests");
    fs.dirContents.set("/skills/test-skill/tests", []);
    const deps = makeDeps({ failures: makeFailures(5), fs });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.equal(result.reason, "needs_tests");
  });

  // ─── Rate limiting ──────────────────────────────────────────────────────

  test("max 3 evolutions per 7 days → rate limited", async () => {
    const deps = makeDeps({
      failures: makeFailures(5),
      recentEvolutionCount: 3,
    });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.equal(result.reason, "evolution_rate_limit");
  });

  // ─── Haiku failure ──────────────────────────────────────────────────────

  test("Haiku call fails → patch_proposal_failed", async () => {
    const deps = makeDeps({
      failures: makeFailures(5),
      patchResponse: "not valid json {{{",
    });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.ok(result.reason?.startsWith("patch_proposal_failed"));
  });

  // ─── No SKILL.md ────────────────────────────────────────────────────────

  test("no SKILL.md → skipped", async () => {
    const fs = makeMockFS();
    // No SKILL.md
    fs.files.set("/skills/test-skill/index.ts", SKILL_SOURCE);
    const deps = makeDeps({ failures: makeFailures(5), fs });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.equal(result.reason, "no SKILL.md found");
  });

  // ─── Benchmark regression ──────────────────────────────────────────────

  test("benchmark regression > 10% → rejected", async () => {
    const deps = makeDeps({
      failures: makeFailures(5),
      benchExists: true,
      benchOrigMs: 100,
      benchPatchMs: 115,
    });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, false);
    assert.ok(result.reason?.startsWith("benchmark_regression"));
  });

  test("benchmark within 10% tolerance → accepted", async () => {
    const deps = makeDeps({
      failures: makeFailures(5),
      benchExists: true,
      benchOrigMs: 100,
      benchPatchMs: 108,
    });
    const result = await evolveSkill("test-skill", deps);
    assert.equal(result.evolved, true);
  });

  // ─── Multiple error classes ─────────────────────────────────────────────

  test("clusters by error_class, takes largest cluster", async () => {
    const failures = [
      ...makeFailures(5, "TypeError"),
      ...makeFailures(2, "RangeError"), // below threshold
    ];
    const deps = makeDeps({ failures });
    const result = await evolveSkill("test-skill", deps);
    // Should evolve based on the TypeError cluster (5 >= 3)
    assert.equal(result.evolved, true);
  });
});

// ─── evolveAllDue ─────────────────────────────────────────────────────────

describe("evolveAllDue", () => {
  test("evolves multiple skills and returns results", async () => {
    const fs = makeMockFS();
    // Set up two skills
    for (const id of ["skill-a", "skill-b"]) {
      fs.files.set(`/skills/${id}/SKILL.md`, SKILL_MD);
      fs.files.set(`/skills/${id}/index.ts`, SKILL_SOURCE);
      fs.dirs.add(`/skills/${id}/tests`);
      fs.dirContents.set(`/skills/${id}/tests`, ["run.test.ts"]);
    }

    const deps = makeDeps({
      failures: makeFailures(5),
      fs,
    });

    const results = await evolveAllDue({
      ...deps,
      skillIds: ["skill-a", "skill-b"],
    });

    assert.equal(results.length, 2);
    // Both should attempt evolution (both have failures from the mock)
    assert.equal(results[0].skillId, "skill-a");
    assert.equal(results[1].skillId, "skill-b");
  });
});
