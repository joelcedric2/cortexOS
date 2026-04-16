import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SkillTools } from "../src/mcp/skill-tools.js";
import type { SkillToolsDeps } from "../src/mcp/skill-tools.js";
import { InMemorySkillRegistry } from "../src/skills/_registry-stub.js";
import type { InstallDeps } from "../src/skills/install.js";
import type { RunSkillDeps } from "../src/skills/runner.js";
import type { ShellResult } from "../src/tools/shell.js";

// ----------------------------- Helpers --------------------------------------

function shellOk(stdout = ""): ShellResult {
  return { stdout, stderr: "", exitCode: 0, truncated: { stdout: false, stderr: false } };
}

function makeToolsDeps(overrides: Partial<SkillToolsDeps> = {}): SkillToolsDeps {
  const registry = new InMemorySkillRegistry();
  const fs = new Map<string, string>();
  fs.set("./skills/test-skill/package.json", JSON.stringify({ main: "index.js" }));

  const installDeps: InstallDeps = {
    registry,
    runShell: async () => shellOk("abc123\n"),
    skillVet: async () => ({ passed: true, fatal: false, reasons: [] }),
    readFile: async (path) => fs.get(path) ?? "",
    writeFile: async (path, content) => { fs.set(path, content); },
    fileExists: async (path) => fs.has(path),
    skillsDir: "./skills",
  };

  const runDeps: RunSkillDeps = {
    registry,
    runShell: async () => shellOk("output\n"),
    readFile: async (path) => fs.get(path) ?? "",
    fileExists: async (path) => fs.has(path),
    skillsDir: "./skills",
    platform: "darwin",
    now: () => 1000,
  };

  return {
    installDeps,
    runDeps,
    ...overrides,
  };
}

// ----------------------------- skill_discover --------------------------------

describe("skill_discover MCP tool", () => {
  test("returns empty when no discover function is wired", async () => {
    const tools = new SkillTools(makeToolsDeps());
    const result = await tools.discover({ need: "format markdown" });
    assert.deepEqual(result, { skills: [] });
  });

  test("delegates to skillDiscover when wired", async () => {
    const deps = makeToolsDeps({
      skillDiscover: async (need) => ({
        skills: [
          { slug: "markdown-fmt", description: "Formats markdown", confidence: 0.95 },
        ],
      }),
    });
    const tools = new SkillTools(deps);
    const result = await tools.discover({ need: "format markdown" });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].slug, "markdown-fmt");
    assert.equal(result.skills[0].confidence, 0.95);
  });

  test("rejects empty need string", async () => {
    const tools = new SkillTools(makeToolsDeps());
    await assert.rejects(
      () => tools.discover({ need: "" }),
    );
  });
});

// ----------------------------- skill_install --------------------------------

describe("skill_install MCP tool", () => {
  test("installs a skill from a valid GitHub URL", async () => {
    const tools = new SkillTools(makeToolsDeps());
    const result = await tools.install({
      repo_url: "https://github.com/owner/test-skill",
    });
    assert.equal(result.slug, "test-skill");
    assert.equal(result.row.trust_level, "unvetted");
  });

  test("rejects non-GitHub URL", async () => {
    const tools = new SkillTools(makeToolsDeps());
    await assert.rejects(
      () => tools.install({ repo_url: "https://gitlab.com/owner/repo" }),
    );
  });

  test("passes subpath through", async () => {
    const tools = new SkillTools(makeToolsDeps());
    const result = await tools.install({
      repo_url: "https://github.com/owner/monorepo",
      subpath: "packages/tool",
    });
    assert.ok(result.slug.includes("monorepo"));
  });
});

// ----------------------------- skill_use ------------------------------------

describe("skill_use MCP tool", () => {
  test("runs a registered skill and returns output", async () => {
    const deps = makeToolsDeps();
    const tools = new SkillTools(deps);

    // First install a skill so the registry knows about it
    await tools.install({
      repo_url: "https://github.com/owner/test-skill",
    });

    const result = await tools.use({ slug: "test-skill" });
    assert.equal(result.slug, "test-skill");
    assert.equal(result.exitCode, 0);
  });

  test("rejects unknown skill", async () => {
    const tools = new SkillTools(makeToolsDeps());
    await assert.rejects(
      () => tools.use({ slug: "nonexistent" }),
    );
  });

  test("passes args and env through", async () => {
    const shells: Array<{ cmd: string[] }> = [];
    const deps = makeToolsDeps();
    deps.runDeps.runShell = async (cmd) => {
      shells.push({ cmd });
      return shellOk("done\n");
    };
    const tools = new SkillTools(deps);

    await tools.install({
      repo_url: "https://github.com/owner/test-skill",
    });

    await tools.use({
      slug: "test-skill",
      args: ["--verbose"],
      env: { DEBUG: "1" },
      timeout_s: 60,
    });

    assert.ok(shells.some((s) => s.cmd.includes("--verbose")));
  });
});

// ----------------------------- Round-trip -----------------------------------

describe("skill MCP tools — round-trip with in-memory fakes", () => {
  test("discover → install → use full round-trip", async () => {
    const deps = makeToolsDeps({
      skillDiscover: async (need) => ({
        skills: [
          { slug: "my-formatter", description: `Formats: ${need}`, confidence: 0.9 },
        ],
      }),
    });
    // Ensure the run deps fileExists sees the package.json for the new skill
    const runFs = new Map<string, string>();
    runFs.set("./skills/my-formatter/package.json", JSON.stringify({ main: "index.js" }));
    deps.runDeps.fileExists = async (path) => runFs.has(path);
    deps.runDeps.readFile = async (path) => runFs.get(path) ?? "";
    const tools = new SkillTools(deps);

    // 1. Discover
    const discovered = await tools.discover({ need: "format code" });
    assert.equal(discovered.skills.length, 1);

    // 2. Install (using a matching repo)
    const installed = await tools.install({
      repo_url: "https://github.com/owner/my-formatter",
    });
    assert.equal(installed.slug, "my-formatter");
    assert.equal(installed.row.trust_level, "unvetted");

    // 3. Use
    const output = await tools.use({ slug: "my-formatter" });
    assert.equal(output.slug, "my-formatter");
    assert.equal(output.exitCode, 0);

    // 4. Verify registry state
    const skill = deps.installDeps.registry.get("my-formatter");
    assert.ok(skill);
    assert.equal(skill.run_count, 1);
  });
});
