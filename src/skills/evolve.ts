/**
 * Skill evolution loop (plan §5.5.3 — Phase 3.7).
 *
 * Clusters recent failures, proposes patches via Haiku, validates them
 * (test suite + benchmark), applies + version-bumps on success.
 *
 * Safety rails (§5.5.4):
 *   - No evolution without tests
 *   - No regressions (test suite must pass, <=10% slower)
 *   - Max 3 evolutions per skill per 7 days
 */
import { z } from "zod";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvolutionResult {
  skillId: string;
  evolved: boolean;
  fromVersion: string;
  toVersion?: string;
  patchSummary?: string;
  validationResult?: { total: number; passed: number; failed: number };
  reason?: string;
}

export interface FailureEntry {
  error_class: string;
  error_message: string;
  timestamp: string;
  run_id?: string;
}

export interface PatchFile {
  path: string;
  before: string;
  after: string;
}

export interface PatchSet {
  files: PatchFile[];
  rationale: string;
}

/**
 * Minimal ledger interface. Matches Agent A's SkillUsageLedger shape.
 */
export interface EvolveLedgerLike {
  failuresBySkill(name: string, days: number): FailureEntry[];
}

export interface EvolveDeps {
  ledger: EvolveLedgerLike;
  /** Read a file from disk. */
  readFile: (path: string) => Promise<string>;
  /** Write a file to disk. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Check if a path exists (file or dir). */
  exists: (path: string) => Promise<boolean>;
  /** List files in a directory (non-recursive). */
  readdir: (path: string) => Promise<string[]>;
  /** Copy a directory recursively. */
  copyDir: (src: string, dest: string) => Promise<void>;
  /** Remove a directory recursively. */
  rmDir: (path: string) => Promise<void>;
  /** Run a shell command, return exit code + stdout. */
  runShell: (cmd: string[], opts?: {
    cwd?: string;
    callerRole?: string;
    timeoutMs?: number;
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Haiku API call. Injected for tests. */
  callHaiku: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** Base directory for installed skills. */
  skillsDir: string;
  /** Event bus emit (optional). */
  emit?: (event: { kind: string; payload: Record<string, unknown> }) => void;
  /** Count recent evolution events for a skill (rolling 7d). */
  recentEvolutionCount?: (skillId: string) => number;
  /** Override clock for tests. */
  now?: () => Date;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CLUSTER_THRESHOLD = 3;
const ROLLING_WINDOW_DAYS = 7;
const MAX_EVOLUTIONS_PER_WEEK = 3;
const BENCHMARK_SLOWDOWN_THRESHOLD = 0.10; // 10%

// ─── Zod schema for patch set ───────────────────────────────────────────────

const PatchFileSchema = z.object({
  path: z.string().min(1),
  before: z.string(),
  after: z.string(),
});

const PatchSetSchema = z.object({
  files: z.array(PatchFileSchema).min(1),
  rationale: z.string().min(1),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Group failures by error_class, returning clusters with >= threshold entries.
 */
function clusterFailures(
  failures: FailureEntry[],
  threshold: number,
): Map<string, FailureEntry[]> {
  const groups = new Map<string, FailureEntry[]>();
  for (const f of failures) {
    const key = f.error_class;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }

  // Filter to clusters meeting the threshold
  const result = new Map<string, FailureEntry[]>();
  for (const [key, list] of groups) {
    if (list.length >= threshold) {
      result.set(key, list);
    }
  }
  return result;
}

/**
 * Read the current version from SKILL.md frontmatter.
 * Expects `version: x.y.z` somewhere in the file.
 */
function parseVersion(skillMdContent: string): string {
  const match = skillMdContent.match(/^version:\s*(.+)$/m);
  return match?.[1]?.trim() ?? "0.0.0";
}

/**
 * Bump patch component: "1.2.3" → "1.2.4"
 */
function bumpPatch(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) return "0.0.1";
  const major = parts[0];
  const minor = parts[1];
  const patch = parseInt(parts[2], 10);
  return `${major}.${minor}.${isNaN(patch) ? 1 : patch + 1}`;
}

/** Build the Haiku prompt for proposing a patch. */
function buildPatchPrompt(source: string, errorClass: string, traces: FailureEntry[]): string {
  const traceLines = traces.slice(0, 5).map((f) => `- [${f.timestamp}] ${f.error_message}`).join("\n");
  return `You are a code repair assistant. A skill is failing with a recurring error pattern.

Error class: ${errorClass}
Recent failure traces:
${traceLines}

Skill source code:
\`\`\`
${source}
\`\`\`

Propose a minimal patch. Return JSON only:
{"files": [{"path": "<relative-path>", "before": "<exact-text>", "after": "<replacement>"}], "rationale": "<1-sentence>"}

Rules: patches must be minimal, do not change test files, before strings must exactly match source text.`;
}

const PATCH_SYSTEM_PROMPT =
  "You are a code repair assistant. Return ONLY valid JSON matching the PatchSet schema. No markdown fences, no commentary.";

// ─── Core: evolve a single skill ────────────────────────────────────────────

export async function evolveSkill(
  skillId: string,
  deps: EvolveDeps,
): Promise<EvolutionResult> {
  const skillDir = `${deps.skillsDir}/${skillId}`;
  const skillMdPath = `${skillDir}/SKILL.md`;

  // Read SKILL.md for version
  const hasSkillMd = await deps.exists(skillMdPath);
  if (!hasSkillMd) {
    return {
      skillId,
      evolved: false,
      fromVersion: "0.0.0",
      reason: "no SKILL.md found",
    };
  }

  const skillMdContent = await deps.readFile(skillMdPath);
  const fromVersion = parseVersion(skillMdContent);

  // Safety: check tests exist
  const testsDir = `${skillDir}/tests`;
  const hasTests = await deps.exists(testsDir);
  if (!hasTests) {
    return {
      skillId,
      evolved: false,
      fromVersion,
      reason: "needs_tests",
    };
  }

  const testFiles = await deps.readdir(testsDir);
  if (testFiles.length === 0) {
    return {
      skillId,
      evolved: false,
      fromVersion,
      reason: "needs_tests",
    };
  }

  // Safety: max 3 evolutions per 7 days
  if (deps.recentEvolutionCount) {
    const count = deps.recentEvolutionCount(skillId);
    if (count >= MAX_EVOLUTIONS_PER_WEEK) {
      return {
        skillId,
        evolved: false,
        fromVersion,
        reason: "evolution_rate_limit",
      };
    }
  }

  // Step 1: Cluster failures
  const failures = deps.ledger.failuresBySkill(skillId, ROLLING_WINDOW_DAYS);
  const clusters = clusterFailures(failures, CLUSTER_THRESHOLD);

  if (clusters.size === 0) {
    return {
      skillId,
      evolved: false,
      fromVersion,
      reason: "no_failure_clusters",
    };
  }

  // Take the largest cluster
  let largestCluster: { errorClass: string; entries: FailureEntry[] } | undefined;
  for (const [errorClass, entries] of clusters) {
    if (!largestCluster || entries.length > largestCluster.entries.length) {
      largestCluster = { errorClass, entries };
    }
  }

  if (!largestCluster) {
    return {
      skillId,
      evolved: false,
      fromVersion,
      reason: "no_failure_clusters",
    };
  }

  // Read skill source for the prompt
  const entryFiles = ["index.ts", "index.js", "main.py", "main.ts"];
  let skillSource = "";
  for (const ef of entryFiles) {
    const efPath = `${skillDir}/${ef}`;
    if (await deps.exists(efPath)) {
      skillSource = await deps.readFile(efPath);
      break;
    }
  }

  if (!skillSource) {
    return {
      skillId,
      evolved: false,
      fromVersion,
      reason: "no_entry_source_found",
    };
  }

  // Step 2: Propose patch via Haiku
  const userPrompt = buildPatchPrompt(
    skillSource,
    largestCluster.errorClass,
    largestCluster.entries,
  );

  let patchSet: PatchSet;
  try {
    const raw = await deps.callHaiku(PATCH_SYSTEM_PROMPT, userPrompt);
    // Strip any markdown fences
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    patchSet = PatchSetSchema.parse(JSON.parse(cleaned));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      skillId,
      evolved: false,
      fromVersion,
      reason: `patch_proposal_failed: ${msg}`,
    };
  }

  // Step 3: Validate — apply patch in temp copy
  const tmpDir = `${deps.skillsDir}/.evolve-tmp-${skillId}-${Date.now()}`;
  try {
    await deps.copyDir(skillDir, tmpDir);

    // Apply patches to temp copy
    for (const file of patchSet.files) {
      const filePath = `${tmpDir}/${file.path}`;
      if (!(await deps.exists(filePath))) {
        return {
          skillId,
          evolved: false,
          fromVersion,
          reason: `patch_file_not_found: ${file.path}`,
        };
      }
      const content = await deps.readFile(filePath);
      if (!content.includes(file.before)) {
        return {
          skillId,
          evolved: false,
          fromVersion,
          reason: `patch_before_mismatch: ${file.path}`,
        };
      }
      const patched = content.replace(file.before, file.after);
      await deps.writeFile(filePath, patched);
    }

    // Run test suite on temp copy
    const testResult = await deps.runShell(
      ["node", "--import", "tsx/esm", "--test", `${tmpDir}/tests/*.test.ts`],
      { cwd: tmpDir, callerRole: "system", timeoutMs: 60_000 },
    );

    // Parse test output for pass/fail counts
    const validation = parseTestOutput(testResult.stdout + testResult.stderr);

    if (testResult.exitCode !== 0 || validation.failed > 0) {
      return {
        skillId,
        evolved: false,
        fromVersion,
        validationResult: validation,
        reason: "validation_tests_failed",
      };
    }

    // Benchmark: run a no-op timing comparison
    const benchResult = await benchmarkComparison(skillDir, tmpDir, deps);
    if (benchResult.rejected) {
      return {
        skillId,
        evolved: false,
        fromVersion,
        validationResult: validation,
        reason: `benchmark_regression: ${benchResult.slowdownPct.toFixed(1)}% slower`,
      };
    }

    // Step 4: Apply + Version bump
    for (const file of patchSet.files) {
      const srcPath = `${skillDir}/${file.path}`;
      const content = await deps.readFile(srcPath);
      const patched = content.replace(file.before, file.after);
      await deps.writeFile(srcPath, patched);
    }

    const toVersion = bumpPatch(fromVersion);
    const nowStr = (deps.now?.() ?? new Date()).toISOString().split("T")[0];

    // Update SKILL.md: bump version + append changelog
    const updatedSkillMd = skillMdContent
      .replace(/^version:\s*.+$/m, `version: ${toVersion}`)
      + `\n\n## ${toVersion} (${nowStr})\n- ${patchSet.rationale}\n`;

    await deps.writeFile(skillMdPath, updatedSkillMd);

    // Git commit
    await deps.runShell(
      ["git", "add", "."],
      { cwd: skillDir, callerRole: "system" },
    );
    await deps.runShell(
      ["git", "commit", "-m", `evolve: ${patchSet.rationale}`],
      { cwd: skillDir, callerRole: "system" },
    );

    // Step 5: Announce
    deps.emit?.({
      kind: "plan_emitted",
      payload: {
        phase: "SKILL_EVOLVED",
        skillId,
        fromVersion,
        toVersion,
        patchSummary: patchSet.rationale,
      },
    });

    return {
      skillId,
      evolved: true,
      fromVersion,
      toVersion,
      patchSummary: patchSet.rationale,
      validationResult: validation,
    };
  } finally {
    // Clean up temp directory
    try {
      await deps.rmDir(tmpDir);
    } catch {
      // Best-effort cleanup
    }
  }
}

// ─── Evolve all skills due for evolution ────────────────────────────────────

export async function evolveAllDue(
  deps: EvolveDeps & { skillIds: string[] },
): Promise<EvolutionResult[]> {
  const results: EvolutionResult[] = [];
  for (const skillId of deps.skillIds) {
    const result = await evolveSkill(skillId, deps);
    results.push(result);
  }
  return results;
}

// ─── Test output parsing ────────────────────────────────────────────────────

function parseTestOutput(
  output: string,
): { total: number; passed: number; failed: number } {
  // node --test outputs lines like:
  // # tests 5
  // # pass 4
  // # fail 1
  const totalMatch = output.match(/# tests\s+(\d+)/);
  const passMatch = output.match(/# pass\s+(\d+)/);
  const failMatch = output.match(/# fail\s+(\d+)/);

  // Also handle the unicode format: ℹ tests 5, ℹ pass 4, ℹ fail 1
  const totalMatch2 = output.match(/ℹ tests\s+(\d+)/);
  const passMatch2 = output.match(/ℹ pass\s+(\d+)/);
  const failMatch2 = output.match(/ℹ fail\s+(\d+)/);

  const total = parseInt(totalMatch?.[1] ?? totalMatch2?.[1] ?? "0", 10);
  const passed = parseInt(passMatch?.[1] ?? passMatch2?.[1] ?? "0", 10);
  const failed = parseInt(failMatch?.[1] ?? failMatch2?.[1] ?? "0", 10);

  return { total, passed, failed };
}

// ─── Benchmark comparison ───────────────────────────────────────────────────

async function benchmarkComparison(
  originalDir: string,
  patchedDir: string,
  deps: Pick<EvolveDeps, "runShell" | "exists">,
): Promise<{ rejected: boolean; slowdownPct: number }> {
  const benchScript = `${originalDir}/bench.ts`;
  if (!(await deps.exists(benchScript))) return { rejected: false, slowdownPct: 0 };

  const runBench = (cwd: string, script: string) =>
    deps.runShell(["node", "--import", "tsx/esm", script], { cwd, callerRole: "system", timeoutMs: 30_000 });

  const [origResult, patchResult] = await Promise.all([
    runBench(originalDir, benchScript),
    runBench(patchedDir, `${patchedDir}/bench.ts`),
  ]);

  const parseBenchMs = (out: string) => parseFloat(out.match(/bench_ms:\s*([\d.]+)/)?.[1] ?? "0");
  const origMs = parseBenchMs(origResult.stdout);
  const patchMs = parseBenchMs(patchResult.stdout);
  if (origMs === 0) return { rejected: false, slowdownPct: 0 };

  const slowdown = (patchMs - origMs) / origMs;
  return { rejected: slowdown > BENCHMARK_SLOWDOWN_THRESHOLD, slowdownPct: slowdown * 100 };
}
