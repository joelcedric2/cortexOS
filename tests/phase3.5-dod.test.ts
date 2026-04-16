/**
 * Phase 3.5 DoD — Dynamic Skill Loader (NCHINDA_PLAN.md §5.2 + §6)
 *
 * Full lifecycle smoke test: discover → install → trust → run → record.
 *
 * Uses the real SkillRegistryDB with :memory: SQLite, and mocks for
 * shell (git clone), skill vet, Haiku SKILL.md generation, and discovery.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { SkillRegistryDB } from "../src/skills/skill-registry-db.js";
import { installSkill } from "../src/skills/install.js";
import type { InstallDeps } from "../src/skills/install.js";
import { runSkill } from "../src/skills/runner.js";
import type { RunSkillDeps } from "../src/skills/runner.js";
import { SkillTools } from "../src/mcp/skill-tools.js";
import type { SkillToolsDeps } from "../src/mcp/skill-tools.js";
import type { ShellResult } from "../src/tools/shell.js";

// ──────────────────────────────── helpers ──────────────────────────────────

function shellOk(stdout = "", stderr = ""): ShellResult {
  return { stdout, stderr, exitCode: 0, truncated: { stdout: false, stderr: false } };
}

function makeRegistry(): SkillRegistryDB {
  return new SkillRegistryDB({ dbPath: ":memory:" });
}

// ──────────────────────────────── DoD test ─────────────────────────────────

describe("Phase 3.5 DoD — Dynamic Skill Loader lifecycle", () => {
  test("discover → install → trust → run → record full lifecycle", async () => {
    // ── 1. Wire up real registry with :memory: SQLite ──
    const registry = makeRegistry();

    // ── 2. Mock discover returning 1 candidate ──
    const mockDiscover = async (need: string) => ({
      skills: [
        {
          slug: "tiktok-scraper",
          description: `Scrapes TikTok data for: ${need}`,
          confidence: 0.92,
        },
      ],
    });

    // ── 3. Mock shell for git clone + rev-parse ──
    const mockRunShell = async (
      cmd: string[],
      _opts?: { cwd?: string; callerRole?: string; timeoutMs?: number; env?: Record<string, string> },
    ): Promise<ShellResult> => {
      if (cmd[0] === "git" && cmd[1] === "clone") return shellOk();
      if (cmd[0] === "git" && cmd[1] === "rev-parse") return shellOk("deadbeef1234567890abcdef1234567890abcdef\n");
      // sandbox-exec wraps the real command on darwin
      if (cmd[0] === "sandbox-exec") return shellOk("skill output: help text\n");
      return shellOk("fallback output\n");
    };

    // ── 4. Mock vet ──
    const mockVet = async (_dir: string) => ({
      passed: true,
      fatal: false,
      reasons: [] as string[],
    });

    // ── 5. Mock Haiku for SKILL.md generation ──
    const mockGenerateSkillMd = async (readme: string) =>
      `# SKILL\n\nAuto-generated from: ${readme.slice(0, 30)}`;

    // ── 6. In-memory filesystem ──
    const fs = new Map<string, string>();
    fs.set("./skills/tiktok-scraper/README.md", "# TikTok Scraper\n\nScrapes TikTok videos.");
    fs.set("./skills/tiktok-scraper/package.json", JSON.stringify({ main: "index.js" }));

    // ── 7. Build deps ──
    const installDeps: InstallDeps = {
      registry,
      runShell: mockRunShell,
      skillVet: mockVet,
      generateSkillMd: mockGenerateSkillMd,
      readFile: async (path) => fs.get(path) ?? "",
      writeFile: async (path, content) => { fs.set(path, content); },
      fileExists: async (path) => fs.has(path),
      skillsDir: "./skills",
    };

    const runDeps: RunSkillDeps = {
      registry,
      runShell: mockRunShell,
      readFile: async (path) => fs.get(path) ?? "",
      fileExists: async (path) => fs.has(path),
      skillsDir: "./skills",
      platform: "darwin",
      now: (() => {
        let t = 1000;
        return () => (t += 10);
      })(),
    };

    const toolsDeps: SkillToolsDeps = {
      installDeps,
      runDeps,
      skillDiscover: mockDiscover,
    };

    const tools = new SkillTools(toolsDeps);

    // ── STEP 1: skill_discover("scrape tiktok") ──
    const discovered = await tools.discover({ need: "scrape tiktok" });
    assert.equal(discovered.skills.length, 1);
    assert.equal(discovered.skills[0].slug, "tiktok-scraper");
    assert.ok(discovered.skills[0].confidence > 0.9);

    // ── STEP 2: skill_install(candidate.url) ──
    const installed = await installSkill(
      { repo_url: "https://github.com/owner/tiktok-scraper" },
      installDeps,
    );
    assert.equal(installed.slug, "tiktok-scraper");
    assert.equal(installed.vet_passed, true);
    assert.equal(installed.skill_md_generated, true);

    // ── STEP 3: verify registry has skill at trust_level "unvetted" ──
    const beforeTrust = registry.get("tiktok-scraper");
    assert.ok(beforeTrust);
    assert.equal(beforeTrust.trust_level, "unvetted");

    // ── STEP 4: setTrustLevel(id, "user-trusted") ──
    registry.setTrustLevel("tiktok-scraper", "user-trusted");
    const afterTrust = registry.get("tiktok-scraper");
    assert.ok(afterTrust);
    assert.equal(afterTrust.trust_level, "user-trusted");

    // ── STEP 5: skill_use(slug, ["--help"]) ──
    const output = await runSkill(
      { slug: "tiktok-scraper", args: ["--help"] },
      runDeps,
    );
    assert.equal(output.slug, "tiktok-scraper");
    assert.equal(output.exitCode, 0);
    assert.ok(output.stdout.includes("skill output"));
    assert.equal(output.sandboxed, true);

    // ── STEP 6: recordRun already called by runSkill; verify ──
    const afterRun = registry.get("tiktok-scraper");
    assert.ok(afterRun);
    assert.equal(afterRun.success_count, 1);

    // ── STEP 7: verify full lifecycle state ──
    assert.equal(afterRun.trust_level, "user-trusted");
    assert.equal(afterRun.fail_count, 0);
    assert.ok(afterRun.commit_sha?.startsWith("deadbeef"));

    // ── Cleanup ──
    registry.close();
  });

  test("quarantined skill cannot be run", async () => {
    const registry = makeRegistry();

    registry.insert({
      id: "bad-skill",
      name: "bad-skill",
      repo_url: "https://github.com/owner/bad-skill",
      trust_level: "unvetted",
    });
    registry.setTrustLevel("bad-skill", "quarantined");

    const fs = new Map<string, string>();
    fs.set("./skills/bad-skill/package.json", JSON.stringify({ main: "index.js" }));

    const runDeps: RunSkillDeps = {
      registry,
      runShell: async () => shellOk(),
      readFile: async (path) => fs.get(path) ?? "",
      fileExists: async (path) => fs.has(path),
      skillsDir: "./skills",
      platform: "darwin",
    };

    await assert.rejects(
      () => runSkill({ slug: "bad-skill" }, runDeps),
      (err: unknown) => err instanceof Error && err.message.includes("quarantined"),
    );

    registry.close();
  });

  test("promoteToSystemTrusted works after threshold runs", async () => {
    const registry = makeRegistry();

    registry.insert({
      id: "reliable-skill",
      name: "reliable-skill",
      trust_level: "user-trusted",
    });

    // Record enough successful runs to meet default threshold (20)
    for (let i = 0; i < 20; i++) {
      registry.recordRun("reliable-skill", "success");
    }

    const promoted = registry.promoteToSystemTrusted("reliable-skill");
    assert.equal(promoted, true);

    const row = registry.get("reliable-skill");
    assert.ok(row);
    assert.equal(row.trust_level, "system-trusted");
    assert.equal(row.success_count, 20);

    registry.close();
  });

  test("registry list filters by trust_level", async () => {
    const registry = makeRegistry();

    registry.insert({ id: "s1", name: "skill-1", trust_level: "unvetted" });
    registry.insert({ id: "s2", name: "skill-2", trust_level: "user-trusted" });
    registry.insert({ id: "s3", name: "skill-3", trust_level: "unvetted" });

    const unvetted = registry.list({ trust_level: "unvetted" });
    assert.equal(unvetted.length, 2);

    const trusted = registry.list({ trust_level: "user-trusted" });
    assert.equal(trusted.length, 1);
    assert.equal(trusted[0].name, "skill-2");

    registry.close();
  });
});
