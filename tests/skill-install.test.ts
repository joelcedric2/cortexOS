import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  installSkill,
  deriveSlug,
  SkillInstallError,
} from "../src/skills/install.js";
import type { InstallDeps, VetResult } from "../src/skills/install.js";
import { InMemorySkillRegistry } from "./helpers/in-memory-skill-registry.js";
import type { ShellResult } from "../src/tools/shell.js";

// ----------------------------- Helpers --------------------------------------

function shellOk(stdout = ""): ShellResult {
  return { stdout, stderr: "", exitCode: 0, truncated: { stdout: false, stderr: false } };
}

function shellFail(stderr = "fatal: error", code = 128): ShellResult {
  return { stdout: "", stderr, exitCode: code, truncated: { stdout: false, stderr: false } };
}

function makeDeps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  const fs = new Map<string, string>();
  return {
    registry: new InMemorySkillRegistry(),
    runShell: async () => shellOk("abc123def456\n"),
    skillVet: async () => ({ passed: true, fatal: false, reasons: [] }),
    generateSkillMd: async (readme: string) => `# SKILL\n\nGenerated from: ${readme.slice(0, 20)}`,
    readFile: async (path: string) => fs.get(path) ?? "",
    writeFile: async (path: string, content: string) => { fs.set(path, content); },
    fileExists: async (path: string) => fs.has(path),
    skillsDir: "/tmp/test-skills",
    ...overrides,
  };
}

// ----------------------------- deriveSlug -----------------------------------

describe("deriveSlug", () => {
  test("extracts repo name from simple URL", () => {
    assert.equal(deriveSlug("https://github.com/owner/my-skill", ""), "my-skill");
  });

  test("strips .git suffix", () => {
    assert.equal(deriveSlug("https://github.com/owner/my-skill.git", ""), "my-skill");
  });

  test("appends subpath with double-dash separator", () => {
    assert.equal(
      deriveSlug("https://github.com/owner/mono-repo", "packages/tool"),
      "mono-repo-packages-tool",
    );
  });

  test("lowercases and normalizes special chars", () => {
    assert.equal(deriveSlug("https://github.com/owner/My_Skill.Name", ""), "my-skill-name");
  });

  test("caps at 64 characters", () => {
    const long = "a".repeat(100);
    const slug = deriveSlug(`https://github.com/owner/${long}`, "");
    assert.ok(slug.length <= 64);
  });
});

// ----------------------------- installSkill ---------------------------------

describe("installSkill — happy path", () => {
  test("installs a skill and returns correct result", async () => {
    const shells: Array<{ cmd: string[] }> = [];
    const fs = new Map<string, string>();
    fs.set("/tmp/test-skills/my-tool/README.md", "# My Tool\nDoes stuff.");

    const deps = makeDeps({
      runShell: async (cmd, opts) => {
        shells.push({ cmd });
        if (cmd[1] === "clone") return shellOk();
        if (cmd[1] === "rev-parse") return shellOk("abc123def456789012345678901234567890\n");
        return shellOk();
      },
      readFile: async (path) => fs.get(path) ?? "",
      writeFile: async (path, content) => { fs.set(path, content); },
      fileExists: async (path) => fs.has(path),
    });

    const result = await installSkill({
      repo_url: "https://github.com/owner/my-tool",
    }, deps);

    assert.equal(result.slug, "my-tool");
    assert.equal(result.commit_sha, "abc123def456789012345678901234567890");
    assert.equal(result.skill_md_generated, true);
    assert.equal(result.vet_passed, true);
    assert.equal(result.row.trust_level, "unvetted");

    // Verify git clone was called with argv array (no injection)
    const cloneCall = shells.find((s) => s.cmd[1] === "clone");
    assert.ok(cloneCall);
    assert.deepEqual(cloneCall.cmd.slice(0, 4), ["git", "clone", "--depth", "1"]);
  });

  test("does not generate SKILL.md when it already exists", async () => {
    const fs = new Map<string, string>();
    fs.set("/tmp/test-skills/my-tool/SKILL.md", "# Existing");
    let generateCalled = false;

    const deps = makeDeps({
      fileExists: async (path) => fs.has(path),
      generateSkillMd: async () => { generateCalled = true; return ""; },
    });

    const result = await installSkill({
      repo_url: "https://github.com/owner/my-tool",
    }, deps);

    assert.equal(result.skill_md_generated, false);
    assert.equal(generateCalled, false);
  });

  test("skips vet when skip_vet is true", async () => {
    let vetCalled = false;
    const deps = makeDeps({
      skillVet: async () => { vetCalled = true; return { passed: true, fatal: false, reasons: [] }; },
    });

    const result = await installSkill({
      repo_url: "https://github.com/owner/my-tool",
      skip_vet: true,
    }, deps);

    assert.equal(vetCalled, false);
    assert.equal(result.vet_passed, null);
  });
});

describe("installSkill — rejection cases", () => {
  test("rejects non-GitHub URL", async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => installSkill({ repo_url: "https://gitlab.com/owner/repo" }, deps),
      (err: unknown) => err instanceof Error && err.message.includes("github.com"),
    );
  });

  test("rejects empty URL", async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => installSkill({ repo_url: "" }, deps),
    );
  });

  test("rejects invalid slug override", async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => installSkill({
        repo_url: "https://github.com/owner/tool",
        slug_override: "INVALID SLUG!",
      }, deps),
      (err: unknown) => err instanceof SkillInstallError && err.code === "INVALID_SLUG",
    );
  });

  test("rejects when slug already in registry", async () => {
    const registry = new InMemorySkillRegistry();
    registry.insert({
      id: "my-tool",
      name: "my-tool",
      repo_url: "https://github.com/owner/my-tool",
      subpath: "",
      commit_sha: "old",
      trust_level: "unvetted",
    });

    const deps = makeDeps({ registry });
    await assert.rejects(
      () => installSkill({
        repo_url: "https://github.com/owner/my-tool",
      }, deps),
      (err: unknown) => err instanceof SkillInstallError && err.code === "ALREADY_EXISTS",
    );
  });

  test("rejects when git clone fails", async () => {
    const deps = makeDeps({
      runShell: async (cmd) => {
        if (cmd[1] === "clone") return shellFail("fatal: repository not found");
        return shellOk("abc123\n");
      },
    });

    await assert.rejects(
      () => installSkill({
        repo_url: "https://github.com/owner/my-tool",
      }, deps),
      (err: unknown) => err instanceof SkillInstallError && err.code === "CLONE_FAILED",
    );
  });

  test("rejects when vet fails fatally", async () => {
    const deps = makeDeps({
      skillVet: async (): Promise<VetResult> => ({
        passed: false,
        fatal: true,
        reasons: ["malicious code detected"],
      }),
    });

    await assert.rejects(
      () => installSkill({
        repo_url: "https://github.com/owner/my-tool",
      }, deps),
      (err: unknown) => err instanceof SkillInstallError && err.code === "VET_FATAL",
    );
  });
});

describe("installSkill — SKILL.md auto-gen via mocked Haiku", () => {
  test("generates SKILL.md from README when missing", async () => {
    const fs = new Map<string, string>();
    fs.set("/tmp/test-skills/my-tool/README.md", "# My Amazing Tool\n\nIt does amazing things.");
    let generatedContent = "";

    const deps = makeDeps({
      readFile: async (path) => fs.get(path) ?? "",
      writeFile: async (path, content) => {
        fs.set(path, content);
        if (path.endsWith("SKILL.md")) generatedContent = content;
      },
      fileExists: async (path) => fs.has(path),
      generateSkillMd: async (readme) => `# SKILL\n\nBased on: ${readme.slice(0, 30)}`,
    });

    const result = await installSkill({
      repo_url: "https://github.com/owner/my-tool",
    }, deps);

    assert.equal(result.skill_md_generated, true);
    assert.ok(generatedContent.includes("# SKILL"));
    assert.ok(generatedContent.includes("Based on: # My Amazing Tool"));
  });

  test("skips generation when no README exists", async () => {
    let generateCalled = false;
    const deps = makeDeps({
      fileExists: async () => false,
      generateSkillMd: async () => { generateCalled = true; return ""; },
    });

    const result = await installSkill({
      repo_url: "https://github.com/owner/my-tool",
    }, deps);

    assert.equal(result.skill_md_generated, false);
    assert.equal(generateCalled, false);
  });

  test("skips generation when generateSkillMd dep is not provided", async () => {
    const fs = new Map<string, string>();
    fs.set("/tmp/test-skills/my-tool/README.md", "# README");

    const deps = makeDeps({
      generateSkillMd: undefined,
      readFile: async (path) => fs.get(path) ?? "",
      fileExists: async (path) => fs.has(path),
    });

    const result = await installSkill({
      repo_url: "https://github.com/owner/my-tool",
    }, deps);

    assert.equal(result.skill_md_generated, false);
  });
});
