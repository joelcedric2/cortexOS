import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSkill, CreateSkillError } from "../src/skills/create.js";
import type { CreateSkillDeps, ResearchBrief, VetReport } from "../src/skills/create.js";
import { SkillRegistryDB } from "../src/skills/skill-registry-db.js";
import type { RunSkillOutput, RunSkillDeps } from "../src/skills/runner.js";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MOCK_RESEARCH: ResearchBrief = {
  recommended_action: "Use ffmpeg for frame extraction",
  evidence: ["ffmpeg supports all major formats", "fluent-ffmpeg npm package"],
  winning: "ffmpeg-based approach",
};

const MOCK_SKILL_MD_JSON = JSON.stringify({
  name: "video-frame-differ",
  purpose: "Extract and diff video frames",
  inputs: "Video file path and frame indices",
  outputs: "Diff image buffer",
  dependencies: ["fluent-ffmpeg"],
  network_required: false,
  entrypoint: "index.ts",
});

const MOCK_TEST_JSON = JSON.stringify({
  filename: "test.ts",
  content: `// test file\nconsole.log("tests pass");`,
});

const MOCK_IMPL_JSON = JSON.stringify({
  filename: "index.ts",
  content: `// implementation\nconsole.log("hello from skill");`,
});

function makeMockCallHaiku(responses: string[]) {
  let callIndex = 0;
  return async (_prompt: string): Promise<string> => {
    if (callIndex >= responses.length) {
      throw new Error("unexpected Haiku call");
    }
    return responses[callIndex++];
  };
}

function makeMockRunSkill(exitCode = 0): (
  input: { slug: string; args: string[]; timeout_s: number },
  deps: RunSkillDeps,
) => Promise<RunSkillOutput> {
  return async (input) => ({
    slug: input.slug,
    exitCode,
    stdout: "ok",
    stderr: "",
    durationMs: 50,
    sandboxed: false,
    truncated: { stdout: false, stderr: false },
  });
}

// ─── Test suite ────────────────────────────────────────────────────────────

describe("createSkill", () => {
  let tmpDir: string;
  let skillsDir: string;
  let registry: SkillRegistryDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skill-create-test-"));
    skillsDir = join(tmpDir, "skills");
    registry = new SkillRegistryDB({ dbPath: ":memory:" });
  });

  afterEach(() => {
    registry.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(overrides?: Partial<CreateSkillDeps>): CreateSkillDeps {
    return {
      runResearch: async () => MOCK_RESEARCH,
      callHaiku: makeMockCallHaiku([MOCK_SKILL_MD_JSON, MOCK_TEST_JSON, MOCK_IMPL_JSON]),
      skillVet: async () => ({ ok: true, reasons: [] }),
      registry,
      runSkill: makeMockRunSkill(0),
      runSkillDeps: {
        registry,
        runShell: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => "",
        fileExists: async () => false,
        skillsDir,
      },
      skillsDir,
      ...overrides,
    };
  }

  // ─── Happy path ────────────────────────────────────────────────────────

  test("full flow produces skill with SKILL.md + tests + impl + registered", async () => {
    const result = await createSkill(
      { need: "video frame differ", name: "video-frame-differ" },
      makeDeps(),
    );

    // Result shape
    assert.equal(result.id, "video-frame-differ");
    assert.ok(result.path.includes("video-frame-differ"));
    assert.ok(result.skill_md_path.endsWith("SKILL.md"));
    assert.equal(result.trust_level, "system-trusted");
    assert.deepEqual(result.test_results, { total: 1, passed: 1, failed: 0 });

    // Files on disk
    assert.ok(existsSync(result.skill_md_path), "SKILL.md should exist");
    assert.ok(existsSync(join(result.path, "index.ts")), "index.ts should exist");
    assert.ok(existsSync(join(result.path, "tests", "test.ts")), "test file should exist");

    // SKILL.md content
    const skillMd = readFileSync(result.skill_md_path, "utf-8");
    assert.ok(skillMd.includes("video-frame-differ"));
    assert.ok(skillMd.includes("entrypoint:"));

    // Registry entry
    const row = registry.get("video-frame-differ");
    assert.ok(row);
    assert.equal(row.name, "video-frame-differ");
    assert.equal(row.trust_level, "system-trusted");
    assert.ok(row.skill_md_path);
  });

  test("auto-derives slug from need when name is omitted", async () => {
    const result = await createSkill(
      { need: "parse CSV files" },
      makeDeps(),
    );
    assert.equal(result.id, "parse-csv-files");
  });

  // ─── Failure cases ────────────────────────────────────────────────────

  test("throws CreateSkillError on research failure", async () => {
    const deps = makeDeps({
      runResearch: async () => { throw new Error("network down"); },
    });
    await assert.rejects(
      () => createSkill({ need: "x" }, deps),
      (err: CreateSkillError) => {
        assert.equal(err.name, "CreateSkillError");
        assert.equal(err.phase, "INVESTIGATE");
        assert.ok(err.message.includes("network down"));
        return true;
      },
    );
  });

  test("throws CreateSkillError on LLM design failure", async () => {
    const deps = makeDeps({
      callHaiku: async () => { throw new Error("llm timeout"); },
    });
    await assert.rejects(
      () => createSkill({ need: "x" }, deps),
      (err: CreateSkillError) => {
        assert.equal(err.phase, "DESIGN");
        return true;
      },
    );
  });

  test("throws CreateSkillError when Haiku returns non-JSON", async () => {
    const deps = makeDeps({
      callHaiku: makeMockCallHaiku(["not json at all"]),
    });
    await assert.rejects(
      () => createSkill({ need: "x" }, deps),
      (err: CreateSkillError) => {
        assert.equal(err.phase, "DESIGN");
        assert.ok(err.message.includes("no JSON"));
        return true;
      },
    );
  });

  test("throws CreateSkillError on vet critical flag", async () => {
    const deps = makeDeps({
      skillVet: async () => ({
        ok: false,
        reasons: ["Found 1 flagged pattern(s): eval("],
      }),
    });
    await assert.rejects(
      () => createSkill({ need: "x" }, deps),
      (err: CreateSkillError) => {
        assert.equal(err.phase, "VET");
        return true;
      },
    );
  });

  // ─── Edge cases ───────────────────────────────────────────────────────

  test("validation run failure does not block result, records failed test", async () => {
    const deps = makeDeps({
      runSkill: makeMockRunSkill(1), // non-zero exit
    });
    const result = await createSkill({ need: "x" }, deps);
    assert.deepEqual(result.test_results, { total: 1, passed: 0, failed: 1 });
    // But it still returns a result — not thrown
    assert.ok(result.id);
  });

  test("python language uses main.py entrypoint", async () => {
    const pySkillMd = JSON.stringify({
      name: "py-skill",
      purpose: "test",
      inputs: "none",
      outputs: "none",
      dependencies: [],
      network_required: false,
      entrypoint: "main.py",
    });
    const pyTest = JSON.stringify({
      filename: "test.py",
      content: "# test",
    });
    const pyImpl = JSON.stringify({
      filename: "main.py",
      content: "# impl",
    });

    const deps = makeDeps({
      callHaiku: makeMockCallHaiku([pySkillMd, pyTest, pyImpl]),
    });

    const result = await createSkill(
      { need: "python skill", name: "py-skill", language: "python" },
      deps,
    );
    assert.ok(existsSync(join(result.path, "main.py")));
    assert.ok(existsSync(join(result.path, "tests", "test.py")));
  });

  test("slug derivation handles special characters", async () => {
    const result = await createSkill(
      { need: "Parse JSON!! & XML files..." },
      makeDeps(),
    );
    assert.match(result.id, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });
});
