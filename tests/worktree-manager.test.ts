import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorktreeManager,
  WorktreeError,
} from "../src/workspace/worktree-manager.js";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "wt-repo-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  // git requires a committer identity even for local-only commits in CI.
  await execFileAsync("git", ["config", "user.email", "t@t.test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "tester"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "hello\n", "utf-8");
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  return repo;
}

describe("WorktreeManager", () => {
  let repo: string;
  let root: string;

  beforeEach(async () => {
    repo = await initRepo();
    root = await mkdtemp(join(tmpdir(), "wt-root-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  test("allocate creates a worktree and branch; release tears both down", async () => {
    const wm = new WorktreeManager({ baseRepo: repo, rootDir: root });
    const info = await wm.allocate("agent-1");

    assert.equal(info.agentId, "agent-1");
    assert.equal(info.branch, "agent/agent-1");
    assert.equal(info.path, join(root, "agent-1"));
    assert.ok(info.createdAt instanceof Date);

    const st = await stat(info.path);
    assert.ok(st.isDirectory(), "worktree path exists as a directory");

    // Branch is visible in the base repo.
    const { stdout: branches } = await execFileAsync(
      "git",
      ["branch", "--list", "agent/agent-1"],
      { cwd: repo },
    );
    assert.match(branches, /agent\/agent-1/);

    await wm.release("agent-1");
    assert.equal(wm.get("agent-1"), null);
    assert.equal(existsSync(info.path), false, "path removed after release");

    const { stdout: afterBranches } = await execFileAsync(
      "git",
      ["branch", "--list", "agent/agent-1"],
      { cwd: repo },
    );
    assert.equal(afterBranches.trim(), "", "branch removed after release");
  });

  test("concurrent allocate() calls for the same agentId return the same info", async () => {
    const wm = new WorktreeManager({ baseRepo: repo, rootDir: root });
    const [a, b, c] = await Promise.all([
      wm.allocate("dup-1"),
      wm.allocate("dup-1"),
      wm.allocate("dup-1"),
    ]);
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
    assert.equal(wm.list().length, 1);
    await wm.release("dup-1");
  });

  test("allocate is idempotent once resolved", async () => {
    const wm = new WorktreeManager({ baseRepo: repo, rootDir: root });
    const first = await wm.allocate("idem-1");
    const second = await wm.allocate("idem-1");
    assert.strictEqual(first, second);
    await wm.release("idem-1");
  });

  test("rejects invalid agentIds (path traversal, shell metachars)", async () => {
    const wm = new WorktreeManager({ baseRepo: repo, rootDir: root });
    const bad = [
      "../escape",
      "a/b",
      "a b",
      "'; rm -rf /",
      "",
      "x".repeat(65),
      "name.with.dots",
      "hash#tag",
    ];
    for (const id of bad) {
      await assert.rejects(
        () => wm.allocate(id),
        (err: unknown) =>
          err instanceof WorktreeError && err.code === "INVALID_AGENT_ID",
        `expected rejection for ${JSON.stringify(id)}`,
      );
    }
  });

  test("list() reflects allocated state and shrinks on release", async () => {
    const wm = new WorktreeManager({ baseRepo: repo, rootDir: root });
    await wm.allocate("a-1");
    await wm.allocate("a-2");
    assert.equal(wm.list().length, 2);
    const ids = wm.list().map((w) => w.agentId).sort();
    assert.deepEqual(ids, ["a-1", "a-2"]);

    await wm.release("a-1");
    assert.equal(wm.list().length, 1);
    assert.equal(wm.list()[0].agentId, "a-2");

    await wm.release("a-2");
    assert.equal(wm.list().length, 0);
  });

  test("release on an unknown agentId is a no-op", async () => {
    const wm = new WorktreeManager({ baseRepo: repo, rootDir: root });
    await wm.release("never-allocated"); // must not throw
    assert.equal(wm.list().length, 0);
  });
});
