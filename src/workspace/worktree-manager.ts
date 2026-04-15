import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

/** Metadata recorded for every allocated worktree. */
export interface WorktreeInfo {
  agentId: string;
  path: string;
  branch: string;
  createdAt: Date;
}

export interface WorktreeOptions {
  /**
   * Path to the source repo whose `git worktree add` command will be invoked.
   * Defaults to the current working directory (the process's repo).
   */
  baseRepo?: string;
  /**
   * Parent directory where per-agent worktrees are materialized. Defaults to
   * `~/.cortexos/workspaces`. Intentionally OUTSIDE the repo tree so stale
   * worktrees don't pollute the main checkout.
   */
  rootDir?: string;
}

/**
 * Regex guarding against path-traversal and shell-metacharacter injection in
 * agent-ids. We only allow the characters we actually emit (`A-Z`, `a-z`,
 * digits, `_`, `-`), bounded to 64 chars. Any other input is rejected before
 * it can reach `execFile`.
 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class WorktreeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly gitArgs?: string[],
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

/**
 * Allocates (and releases) a dedicated git worktree per agent.
 *
 * Nchinda plan §6 Phase 3 DoD: "Git worktree per agent (mandatory)." Each
 * agent gets its own branch `agent/<agentId>` checked out at
 * `<rootDir>/<agentId>`. Two Claude Code agents can never clobber each
 * other's edits because they literally live in different directories on
 * different branches.
 *
 * Concurrency: `allocate` dedups in-flight calls for the same agentId via an
 * in-memory Map<agentId, Promise>. Idempotent: repeat calls after completion
 * return the cached `WorktreeInfo` without re-shelling out.
 *
 * Security: agentId is validated against {@link AGENT_ID_RE} to prevent
 * path-traversal (`../`) and shell-metachar injection. All git commands are
 * invoked via `execFile` with an argument array — never a shell string.
 */
export class WorktreeManager {
  private readonly baseRepo: string;
  private readonly rootDir: string;
  private readonly cache = new Map<string, WorktreeInfo>();
  private readonly inFlight = new Map<string, Promise<WorktreeInfo>>();

  constructor(opts: WorktreeOptions = {}) {
    this.baseRepo = opts.baseRepo ?? process.cwd();
    this.rootDir = opts.rootDir ?? join(homedir(), ".cortexos", "workspaces");
  }

  /**
   * Ensure a worktree exists for `agentId` and return its metadata.
   *
   * - Returns cached info if one was already allocated.
   * - If a previous `allocate` for the same agentId is still running, awaits
   *   that promise instead of racing a second `git worktree add`.
   * - Otherwise shells out to `git worktree add <path> -b agent/<agentId>`.
   */
  async allocate(agentId: string): Promise<WorktreeInfo> {
    this.assertValidAgentId(agentId);

    const cached = this.cache.get(agentId);
    if (cached) return cached;

    const pending = this.inFlight.get(agentId);
    if (pending) return pending;

    const promise = this.doAllocate(agentId).finally(() => {
      this.inFlight.delete(agentId);
    });
    this.inFlight.set(agentId, promise);
    return promise;
  }

  /**
   * Tear down the worktree + branch for `agentId`. Best-effort: logs and
   * continues on git failures so orchestrator teardown never hangs on a
   * stale lock file.
   */
  async release(agentId: string): Promise<void> {
    this.assertValidAgentId(agentId);

    const info = this.cache.get(agentId);
    if (!info) return;

    const branch = info.branch;
    const path = info.path;

    try {
      await this.git(["worktree", "remove", "--force", path]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WorktreeManager] worktree remove failed for ${agentId}: ${message}`,
      );
      // Fall back to a filesystem rm so a stale worktree directory doesn't
      // block a future `allocate` for the same agentId.
      if (existsSync(path)) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch (rmErr) {
          const rmMessage =
            rmErr instanceof Error ? rmErr.message : String(rmErr);
          console.warn(
            `[WorktreeManager] fs rm fallback failed for ${path}: ${rmMessage}`,
          );
        }
      }
    }

    try {
      await this.git(["branch", "-D", branch]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WorktreeManager] branch -D failed for ${branch}: ${message}`,
      );
    }

    this.cache.delete(agentId);
  }

  /** Current cached metadata for `agentId`, or null if none allocated. */
  get(agentId: string): WorktreeInfo | null {
    return this.cache.get(agentId) ?? null;
  }

  /** All currently-allocated worktrees (from the in-memory cache). */
  list(): WorktreeInfo[] {
    return Array.from(this.cache.values());
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private async doAllocate(agentId: string): Promise<WorktreeInfo> {
    const path = join(this.rootDir, agentId);
    const branch = `agent/${agentId}`;

    // Root dir may not exist yet on first allocate. `git worktree add` errors
    // cleanly if the TARGET path already exists, so we only ensure the parent.
    await mkdir(this.rootDir, { recursive: true });

    await this.git(["worktree", "add", path, "-b", branch]);

    const info: WorktreeInfo = {
      agentId,
      path,
      branch,
      createdAt: new Date(),
    };
    this.cache.set(agentId, info);
    return info;
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.baseRepo,
      });
      return stdout.trimEnd();
    } catch (err: unknown) {
      const error = err as Error & { stderr?: string };
      const message =
        error.stderr?.trim() || error.message || "git command failed";
      throw new WorktreeError(message, "GIT_EXEC_FAILED", args);
    }
  }

  private assertValidAgentId(agentId: string): void {
    if (!AGENT_ID_RE.test(agentId)) {
      throw new WorktreeError(
        `Invalid agentId '${agentId}' — must match ${AGENT_ID_RE}`,
        "INVALID_AGENT_ID",
      );
    }
  }
}
