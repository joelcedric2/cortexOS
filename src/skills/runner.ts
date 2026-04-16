/**
 * Skill runner (plan §5.2 — Phase 3.5).
 *
 * Looks up a skill by slug, determines its entrypoint, executes it in a
 * sandboxed environment (sandbox-exec on darwin, fallback on other OS),
 * and records the run outcome.
 *
 * Sandbox profile (darwin only): deny default, allow process-*, allow
 * file-read of skill path, allow file-write to skill/tmp. On non-darwin
 * falls back to plain `runShell` with a console.warn.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ShellResult } from "../tools/shell.js";
import type { SkillRegistryDB } from "./skill-registry-db.js";
import type { SkillUsageLedger } from "./usage-ledger.js";

// ----------------------------- Constants ------------------------------------

const MAX_TIMEOUT_S = 300;
const DEFAULT_TIMEOUT_S = 30;
const STDOUT_CAP = 256 * 1024; // 256 KB
const STDERR_CAP = 64 * 1024; // 64 KB

// ----------------------------- Types ----------------------------------------

const RunSkillInputSchema = z.object({
  slug: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  timeout_s: z.number().int().min(1).max(MAX_TIMEOUT_S).default(DEFAULT_TIMEOUT_S),
  stdin: z.string().optional(),
});

export type RunSkillInput = z.infer<typeof RunSkillInputSchema>;

export interface RunSkillOutput {
  slug: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  sandboxed: boolean;
  truncated: { stdout: boolean; stderr: boolean };
}

export interface RunSkillDeps {
  registry: SkillRegistryDB;
  /** execFile-based shell runner. */
  runShell: (cmd: string[], opts?: {
    cwd?: string;
    callerRole?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }) => Promise<ShellResult>;
  /** Read a file from disk. */
  readFile: (path: string) => Promise<string>;
  /** Check if a file exists. */
  fileExists: (path: string) => Promise<boolean>;
  /** Base directory for installed skills. */
  skillsDir?: string;
  /** Override platform detection for tests. */
  platform?: NodeJS.Platform;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Optional usage ledger for telemetry. */
  ledger?: SkillUsageLedger;
}

// ----------------------------- Errors ---------------------------------------

export class SkillRunError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NOT_FOUND"
      | "QUARANTINED"
      | "NO_ENTRYPOINT"
      | "EXECUTION_FAILED"
      | "TIMEOUT",
  ) {
    super(`run: ${message}`);
    this.name = "SkillRunError";
  }
}

// ----------------------------- Entrypoint resolution ------------------------

interface Entrypoint {
  binary: string;
  args: string[];
}

/**
 * Determine the entrypoint for a skill:
 * 1. package.json "main" field → node
 * 2. main.py exists → python3
 * 3. SKILL.md "entrypoint:" declaration
 * 4. index.js / index.ts fallback
 */
async function resolveEntrypoint(
  skillRoot: string,
  deps: Pick<RunSkillDeps, "readFile" | "fileExists">,
): Promise<Entrypoint> {
  // 1. Check package.json
  const pkgPath = `${skillRoot}/package.json`;
  if (await deps.fileExists(pkgPath)) {
    const raw = await deps.readFile(pkgPath);
    try {
      const pkg = JSON.parse(raw) as { main?: string };
      if (pkg.main) {
        return { binary: "node", args: [`${skillRoot}/${pkg.main}`] };
      }
    } catch {
      // Invalid package.json — fall through
    }
  }

  // 2. Check main.py
  if (await deps.fileExists(`${skillRoot}/main.py`)) {
    return { binary: "python3", args: [`${skillRoot}/main.py`] };
  }

  // 3. Check SKILL.md for entrypoint declaration
  const skillMdPath = `${skillRoot}/SKILL.md`;
  if (await deps.fileExists(skillMdPath)) {
    const content = await deps.readFile(skillMdPath);
    const match = content.match(/^entrypoint:\s*(.+)$/m);
    if (match) {
      const parts = match[1].trim().split(/\s+/);
      const [binary, ...args] = parts;
      return { binary, args: args.map((a) => a.startsWith("./") ? `${skillRoot}/${a.slice(2)}` : a) };
    }
  }

  // 4. Fallback: index.js / index.ts
  if (await deps.fileExists(`${skillRoot}/index.js`)) {
    return { binary: "node", args: [`${skillRoot}/index.js`] };
  }
  if (await deps.fileExists(`${skillRoot}/index.ts`)) {
    return { binary: "npx", args: ["tsx", `${skillRoot}/index.ts`] };
  }

  throw new SkillRunError(
    `no entrypoint found in ${skillRoot}`,
    "NO_ENTRYPOINT",
  );
}

// ----------------------------- Sandbox profile (darwin) ---------------------

/**
 * Generate a sandbox-exec profile that:
 * - Denies all by default
 * - Allows process operations (fork/exec)
 * - Allows file-read of the skill path
 * - Allows file-write to skill/tmp only
 * - Allows sysctl-read, mach-lookup (needed for node to start)
 */
function buildSandboxProfile(skillRoot: string): string {
  // Escape quotes in the path for the SBPL
  const escaped = skillRoot.replace(/"/g, '\\"');
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-read* (subpath "${escaped}"))`,
    `(allow file-read* (subpath "/usr"))`,
    `(allow file-read* (subpath "/bin"))`,
    `(allow file-read* (subpath "/Library"))`,
    `(allow file-read* (subpath "/System"))`,
    `(allow file-read* (subpath "/dev"))`,
    `(allow file-read* (subpath "/private"))`,
    `(allow file-read* (subpath "/var"))`,
    `(allow file-write* (subpath "${escaped}/tmp"))`,
    `(allow file-write* (subpath "/dev/null"))`,
  ].join("\n");
}

// ----------------------------- Truncation -----------------------------------

function truncate(s: string, cap: number): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: s.slice(0, cap), truncated: true };
}

// ----------------------------- Main -----------------------------------------

export async function runSkill(
  input: RunSkillInput,
  deps: RunSkillDeps,
): Promise<RunSkillOutput> {
  const parsed = RunSkillInputSchema.parse(input);

  // 1. Look up skill
  const skill = deps.registry.get(parsed.slug);
  if (!skill) {
    throw new SkillRunError(`skill "${parsed.slug}" not found`, "NOT_FOUND");
  }
  if (skill.trust_level === "quarantined") {
    throw new SkillRunError(
      `skill "${parsed.slug}" is quarantined — cannot run`,
      "QUARANTINED",
    );
  }

  // 2. Resolve entrypoint
  const skillsDir = deps.skillsDir ?? "./skills";
  const skillRoot = skill.subpath
    ? `${skillsDir}/${parsed.slug}/${skill.subpath}`
    : `${skillsDir}/${parsed.slug}`;

  const entrypoint = await resolveEntrypoint(skillRoot, deps);

  // 3. Build command
  const cmd = [entrypoint.binary, ...entrypoint.args, ...parsed.args];

  // 4. Execute (sandboxed on darwin, fallback otherwise)
  const platform = deps.platform ?? process.platform;
  const timeoutMs = parsed.timeout_s * 1000;
  const nowFn = deps.now ?? Date.now;
  const startMs = nowFn();
  let sandboxed = false;
  let result: ShellResult;

  if (platform === "darwin") {
    // Use sandbox-exec with a restrictive profile
    const profile = buildSandboxProfile(skillRoot);
    const sandboxCmd = ["sandbox-exec", "-p", profile, ...cmd];
    sandboxed = true;
    result = await deps.runShell(sandboxCmd, {
      cwd: skillRoot,
      callerRole: "system",
      timeoutMs,
      env: parsed.env,
    });
  } else {
    // Non-darwin: warn and run without sandbox
    console.warn(`[skill-runner] sandbox-exec unavailable on ${platform}; running unsandboxed`);
    result = await deps.runShell(cmd, {
      cwd: skillRoot,
      callerRole: "system",
      timeoutMs,
      env: parsed.env,
    });
  }

  const durationMs = nowFn() - startMs;

  // 5. Truncate outputs
  const stdoutT = truncate(result.stdout, STDOUT_CAP);
  const stderrT = truncate(result.stderr, STDERR_CAP);

  // 6. Record run outcome
  const outcome = result.exitCode === 0 ? "success" : "fail";
  deps.registry.recordRun(parsed.slug, outcome);

  // 7. Write to usage ledger if wired
  if (deps.ledger) {
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ slug: parsed.slug, args: parsed.args }))
      .digest("hex")
      .slice(0, 16);
    deps.ledger.record({
      skill_name: parsed.slug,
      input_hash: inputHash,
      outcome: outcome as "success" | "fail",
      latency_ms: durationMs,
      output_summary: stdoutT.text.slice(0, 200) || undefined,
      error_msg: result.exitCode !== 0 ? stderrT.text.slice(0, 500) || undefined : undefined,
    });
  }

  return {
    slug: parsed.slug,
    exitCode: result.exitCode,
    stdout: stdoutT.text,
    stderr: stderrT.text,
    durationMs,
    sandboxed,
    truncated: { stdout: stdoutT.truncated, stderr: stderrT.truncated },
  };
}
