/**
 * Skill installer (plan §5.2 — Phase 3.5).
 *
 * Validates a GitHub repo URL, clones it via `runShell`, vets the skill,
 * auto-generates SKILL.md via Haiku if missing, and inserts into the
 * registry as `unvetted`.
 *
 * All shell operations use `runShell` with argv arrays — never string
 * interpolation — so argument injection is impossible.
 */
import { z } from "zod";
import type { ShellResult } from "../tools/shell.js";
import type { SkillRegistryDB, SkillRow } from "./_registry-stub.js";

// ----------------------------- Types ----------------------------------------

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/.*)?$/;
const SLUG_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/;
const MAX_SLUG_LEN = 64;

const InstallRequestSchema = z.object({
  repo_url: z.string().min(1).refine(
    (u) => GITHUB_URL_RE.test(u),
    { message: "repo_url must be a valid https://github.com/... URL" },
  ),
  subpath: z.string().default(""),
  slug_override: z.string().optional(),
  skip_vet: z.boolean().default(false),
});

export type InstallRequest = z.infer<typeof InstallRequestSchema>;

export interface InstallResult {
  slug: string;
  commit_sha: string;
  skill_md_generated: boolean;
  vet_passed: boolean | null;
  row: SkillRow;
}

export interface VetResult {
  passed: boolean;
  fatal: boolean;
  reasons: string[];
}

export interface InstallDeps {
  registry: SkillRegistryDB;
  /** execFile-based shell runner. Must accept trusted calls for git clone. */
  runShell: (cmd: string[], opts?: { cwd?: string; callerRole?: string; timeoutMs?: number }) => Promise<ShellResult>;
  /** Vet function from Agent A (or stub). Returns pass/fail + reasons. */
  skillVet: (skillDir: string) => Promise<VetResult>;
  /**
   * Haiku call for SKILL.md generation. Receives the README content and
   * returns the generated SKILL.md text.
   */
  generateSkillMd?: (readmeContent: string) => Promise<string>;
  /** Read a file from disk — injectable for tests. */
  readFile: (path: string) => Promise<string>;
  /** Write a file to disk — injectable for tests. */
  writeFile: (path: string, content: string) => Promise<void>;
  /** Check if a file exists — injectable for tests. */
  fileExists: (path: string) => Promise<boolean>;
  /** Base directory for cloned skills. Defaults to `./skills`. */
  skillsDir?: string;
}

// ----------------------------- Errors ---------------------------------------

export class SkillInstallError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_URL"
      | "INVALID_SLUG"
      | "ALREADY_EXISTS"
      | "CLONE_FAILED"
      | "VET_FATAL"
      | "SKILL_MD_GEN_FAILED",
  ) {
    super(`install: ${message}`);
    this.name = "SkillInstallError";
  }
}

// ----------------------------- Helpers --------------------------------------

/**
 * Derive a URL-safe slug from a GitHub repo URL.
 *   https://github.com/owner/repo-name → repo-name
 *   https://github.com/owner/repo-name/tree/main/sub → repo-name--sub
 */
export function deriveSlug(repoUrl: string, subpath: string): string {
  const url = new URL(repoUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  // segments: [owner, repo, maybe tree/branch/subpath...]
  const repoName = (segments[1] ?? "skill").replace(/\.git$/, "");
  const sub = subpath.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
  const raw = sub ? `${repoName}--${sub}` : repoName;
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, MAX_SLUG_LEN);
}

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug) || slug.length > MAX_SLUG_LEN) {
    throw new SkillInstallError(
      `invalid slug "${slug}" — must match ${SLUG_RE.source}, max ${MAX_SLUG_LEN} chars`,
      "INVALID_SLUG",
    );
  }
}

// ----------------------------- Main -----------------------------------------

export async function installSkill(
  req: InstallRequest,
  deps: InstallDeps,
): Promise<InstallResult> {
  // 1. Validate input
  const input = InstallRequestSchema.parse(req);

  // 2. Derive + validate slug
  const slug = input.slug_override ?? deriveSlug(input.repo_url, input.subpath);
  validateSlug(slug);

  // 3. Check registry for existing
  const existing = deps.registry.get(slug);
  if (existing) {
    throw new SkillInstallError(
      `skill "${slug}" already installed (commit ${existing.commit_sha})`,
      "ALREADY_EXISTS",
    );
  }

  // 4. Clone via runShell (trusted for git)
  const skillsDir = deps.skillsDir ?? "./skills";
  const clonePath = `${skillsDir}/${slug}`;
  const cloneResult = await deps.runShell(
    ["git", "clone", "--depth", "1", input.repo_url, clonePath],
    { callerRole: "system", timeoutMs: 60_000 },
  );
  if (cloneResult.exitCode !== 0) {
    throw new SkillInstallError(
      `git clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr.slice(0, 200)}`,
      "CLONE_FAILED",
    );
  }

  // 5. Get commit SHA
  const shaResult = await deps.runShell(
    ["git", "rev-parse", "HEAD"],
    { cwd: clonePath, callerRole: "system" },
  );
  const commitSha = shaResult.stdout.trim().slice(0, 40);

  // 6. Determine the skill root (may be a subpath within the clone)
  const skillRoot = input.subpath
    ? `${clonePath}/${input.subpath.replace(/^\/+/, "")}`
    : clonePath;

  // 7. Vet the skill (unless skipped)
  let vetPassed: boolean | null = null;
  if (!input.skip_vet) {
    const vetResult = await deps.skillVet(skillRoot);
    vetPassed = vetResult.passed;
    if (vetResult.fatal) {
      throw new SkillInstallError(
        `vet failed fatally: ${vetResult.reasons.join("; ")}`,
        "VET_FATAL",
      );
    }
  }

  // 8. Auto-generate SKILL.md if missing
  let skillMdGenerated = false;
  const skillMdPath = `${skillRoot}/SKILL.md`;
  const hasSkillMd = await deps.fileExists(skillMdPath);
  if (!hasSkillMd && deps.generateSkillMd) {
    const readmePath = `${skillRoot}/README.md`;
    const hasReadme = await deps.fileExists(readmePath);
    if (hasReadme) {
      const readmeContent = await deps.readFile(readmePath);
      const generated = await deps.generateSkillMd(readmeContent);
      await deps.writeFile(skillMdPath, generated);
      skillMdGenerated = true;
    }
  }

  // 9. Insert into registry as unvetted
  const row = deps.registry.insert({
    slug,
    repo_url: input.repo_url,
    subpath: input.subpath,
    commit_sha: commitSha,
    trust_level: "unvetted",
    metadata: {
      skill_md_generated: skillMdGenerated,
      vet_passed: vetPassed,
    },
  });

  return {
    slug,
    commit_sha: commitSha,
    skill_md_generated: skillMdGenerated,
    vet_passed: vetPassed,
    row,
  };
}
