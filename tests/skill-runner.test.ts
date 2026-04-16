import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runSkill, SkillRunError } from "../src/skills/runner.js";
import type { RunSkillDeps } from "../src/skills/runner.js";
import { InMemorySkillRegistry } from "./helpers/in-memory-skill-registry.js";
import type { ShellResult } from "../src/tools/shell.js";

// ----------------------------- Helpers --------------------------------------

function shellOk(stdout = "", stderr = ""): ShellResult {
  return { stdout, stderr, exitCode: 0, truncated: { stdout: false, stderr: false } };
}

function seedRegistry(): InMemorySkillRegistry {
  const reg = new InMemorySkillRegistry();
  reg.insert({
    id: "hello-tool",
    name: "hello-tool",
    repo_url: "https://github.com/owner/hello-tool",
    subpath: "",
    commit_sha: "abc123",
    trust_level: "user-trusted",
  });
  return reg;
}

function makeDeps(overrides: Partial<RunSkillDeps> = {}): RunSkillDeps {
  const fs = new Map<string, string>();
  fs.set("./skills/hello-tool/package.json", JSON.stringify({ main: "index.js" }));

  return {
    registry: seedRegistry(),
    runShell: async () => shellOk("hello world\n"),
    readFile: async (path) => fs.get(path) ?? "",
    fileExists: async (path) => fs.has(path),
    skillsDir: "./skills",
    platform: "darwin",
    now: () => 1000,
    ...overrides,
  };
}

// ----------------------------- Happy path -----------------------------------

describe("runSkill — happy path", () => {
  test("runs a skill and returns output", async () => {
    const shells: Array<{ cmd: string[] }> = [];
    const deps = makeDeps({
      runShell: async (cmd) => {
        shells.push({ cmd });
        return shellOk("result output\n");
      },
      now: (() => {
        let t = 1000;
        return () => (t += 50);
      })(),
    });

    const result = await runSkill({ slug: "hello-tool" }, deps);

    assert.equal(result.slug, "hello-tool");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "result output\n");
    assert.equal(result.sandboxed, true);
    assert.ok(result.durationMs > 0);

    // Verify sandbox-exec is used on darwin
    const lastCmd = shells[0].cmd;
    assert.equal(lastCmd[0], "sandbox-exec");
    assert.equal(lastCmd[1], "-p");
  });

  test("falls back to unsandboxed on non-darwin with warning", async () => {
    const shells: Array<{ cmd: string[] }> = [];
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warns.push(msg);

    try {
      const deps = makeDeps({
        platform: "linux",
        runShell: async (cmd) => {
          shells.push({ cmd });
          return shellOk("linux output\n");
        },
      });

      const result = await runSkill({ slug: "hello-tool" }, deps);

      assert.equal(result.sandboxed, false);
      assert.equal(result.stdout, "linux output\n");
      assert.ok(warns.some((w) => w.includes("sandbox-exec unavailable")));

      // Should NOT use sandbox-exec
      assert.notEqual(shells[0].cmd[0], "sandbox-exec");
    } finally {
      console.warn = origWarn;
    }
  });

  test("resolves python3 entrypoint for main.py", async () => {
    const fs = new Map<string, string>();
    fs.set("./skills/hello-tool/main.py", "print('hi')");
    const shells: Array<{ cmd: string[] }> = [];

    const deps = makeDeps({
      fileExists: async (path) => fs.has(path),
      readFile: async (path) => fs.get(path) ?? "",
      runShell: async (cmd) => {
        shells.push({ cmd });
        return shellOk("hi\n");
      },
    });

    await runSkill({ slug: "hello-tool" }, deps);
    // Find python3 in the command
    const mainCmd = shells[0].cmd;
    assert.ok(mainCmd.includes("python3"));
  });

  test("passes user args to the command", async () => {
    const shells: Array<{ cmd: string[] }> = [];

    const deps = makeDeps({
      runShell: async (cmd) => {
        shells.push({ cmd });
        return shellOk();
      },
    });

    await runSkill({
      slug: "hello-tool",
      args: ["--flag", "value"],
    }, deps);

    const mainCmd = shells[0].cmd;
    assert.ok(mainCmd.includes("--flag"));
    assert.ok(mainCmd.includes("value"));
  });

  test("records successful run outcome", async () => {
    const registry = seedRegistry();
    const deps = makeDeps({ registry });

    await runSkill({ slug: "hello-tool" }, deps);

    const skill = registry.get("hello-tool");
    assert.ok(skill);
    assert.equal(skill.success_count, 1);
    assert.equal(skill.fail_count, 0);
  });

  test("records failed run outcome", async () => {
    const registry = seedRegistry();
    const deps = makeDeps({
      registry,
      runShell: async () => ({
        stdout: "",
        stderr: "error occurred",
        exitCode: 1,
        truncated: { stdout: false, stderr: false },
      }),
    });

    const result = await runSkill({ slug: "hello-tool" }, deps);

    assert.equal(result.exitCode, 1);
    const skill = registry.get("hello-tool");
    assert.ok(skill);
    assert.equal(skill.success_count, 0);
    assert.equal(skill.fail_count, 1);
  });
});

// ----------------------------- Rejection cases ------------------------------

describe("runSkill — rejection cases", () => {
  test("throws NOT_FOUND for unknown skill", async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => runSkill({ slug: "nonexistent" }, deps),
      (err: unknown) => err instanceof SkillRunError && err.code === "NOT_FOUND",
    );
  });

  test("throws QUARANTINED for quarantined skill", async () => {
    const registry = seedRegistry();
    registry.setTrustLevel("hello-tool", "quarantined");
    const deps = makeDeps({ registry });

    await assert.rejects(
      () => runSkill({ slug: "hello-tool" }, deps),
      (err: unknown) => err instanceof SkillRunError && err.code === "QUARANTINED",
    );
  });

  test("throws NO_ENTRYPOINT when no file matches", async () => {
    const deps = makeDeps({
      fileExists: async () => false,
      readFile: async () => "",
    });

    await assert.rejects(
      () => runSkill({ slug: "hello-tool" }, deps),
      (err: unknown) => err instanceof SkillRunError && err.code === "NO_ENTRYPOINT",
    );
  });
});

// ----------------------------- Truncation -----------------------------------

describe("runSkill — output truncation", () => {
  test("truncates stdout at 256KB", async () => {
    const bigOutput = "x".repeat(300 * 1024);
    const deps = makeDeps({
      runShell: async () => shellOk(bigOutput),
    });

    const result = await runSkill({ slug: "hello-tool" }, deps);

    assert.equal(result.stdout.length, 256 * 1024);
    assert.equal(result.truncated.stdout, true);
    assert.equal(result.truncated.stderr, false);
  });

  test("truncates stderr at 64KB", async () => {
    const bigErr = "e".repeat(100 * 1024);
    const deps = makeDeps({
      runShell: async () => ({
        stdout: "",
        stderr: bigErr,
        exitCode: 1,
        truncated: { stdout: false, stderr: false },
      }),
    });

    const result = await runSkill({ slug: "hello-tool" }, deps);

    assert.equal(result.stderr.length, 64 * 1024);
    assert.equal(result.truncated.stderr, true);
  });
});

// ----------------------------- Timeout enforcement --------------------------

describe("runSkill — timeout", () => {
  test("passes timeout to runShell in ms", async () => {
    let receivedTimeoutMs: number | undefined;

    const deps = makeDeps({
      runShell: async (_cmd, opts) => {
        receivedTimeoutMs = opts?.timeoutMs;
        return shellOk();
      },
    });

    await runSkill({ slug: "hello-tool", timeout_s: 60 }, deps);

    assert.equal(receivedTimeoutMs, 60_000);
  });

  test("rejects timeout above 300s", async () => {
    const deps = makeDeps();
    await assert.rejects(
      () => runSkill({ slug: "hello-tool", timeout_s: 301 }, deps),
    );
  });

  test("defaults to 30s timeout", async () => {
    let receivedTimeoutMs: number | undefined;

    const deps = makeDeps({
      runShell: async (_cmd, opts) => {
        receivedTimeoutMs = opts?.timeoutMs;
        return shellOk();
      },
    });

    await runSkill({ slug: "hello-tool" }, deps);

    assert.equal(receivedTimeoutMs, 30_000);
  });
});
