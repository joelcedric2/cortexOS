/**
 * Generic `shell` utility tool (plan §5.1).
 *
 * Executes a single binary with a list of arguments via `execFile` — never
 * a shell-interpolated string, so argv cannot be injected through `cmd`.
 *
 * Two execution modes:
 *
 *   - **untrusted** (default): callable from any agent. Binary must be on
 *     `SHELL_ALLOWLIST`. This is the safe default for LLM-driven calls.
 *   - **trusted**: caller sets `callerRole: 'system'`. Allow-list is
 *     bypassed so internal orchestrator code (e.g. git-worktree management)
 *     can invoke `git worktree add` with arbitrary paths. Still `execFile`-
 *     based, so injection via args is still impossible.
 *
 * All output is truncated — stdout at 256 KB, stderr at 64 KB — to keep a
 * misbehaving command from eating the event loop's buffers.
 */
import { execFile, type ExecFileOptions } from "node:child_process";
import { z } from "zod";

// --------------------------- Constants ------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const STDOUT_CAP_BYTES = 256 * 1024; // 256 KB
const STDERR_CAP_BYTES = 64 * 1024; // 64 KB

/**
 * Binaries callable from an untrusted context. Anything outside this list
 * throws `ShellDeniedError` before any child process is spawned.
 *
 * The list is intentionally narrow: read-only inspection tools + the
 * JS/TS toolchain. No `rm`, no `mv`, no `chmod`, no `curl`, no `ssh`.
 */
export const SHELL_ALLOWLIST: ReadonlySet<string> = new Set([
  "git",
  "ls",
  "cat",
  "grep",
  "rg",
  "find",
  "wc",
  "head",
  "tail",
  "awk",
  "sed",
  "date",
  "echo",
  "pwd",
  "which",
  "npm",
  "npx",
  "node",
]);

// --------------------------- Errors ---------------------------------------

export class ShellDeniedError extends Error {
  constructor(public readonly binary: string) {
    super(`shell: binary '${binary}' is not on the allow-list`);
    this.name = "ShellDeniedError";
  }
}

export class ShellTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`shell: command timed out after ${timeoutMs}ms`);
    this.name = "ShellTimeoutError";
  }
}

export class ShellInvalidInputError extends Error {
  constructor(message: string) {
    super(`shell: ${message}`);
    this.name = "ShellInvalidInputError";
  }
}

// --------------------------- Schemas --------------------------------------

/**
 * `cmd` must be an argv array — `[binary, ...args]` — OR a single-token
 * string that resolves to the binary with no arguments. String commands
 * containing whitespace are rejected so nobody can smuggle in shell syntax
 * (`&&`, `;`, `$(…)`, pipes). Trusted callers can still pass a multi-token
 * argv by using the array form.
 */
const ShellInputSchema = z.object({
  cmd: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().max(10 * 60 * 1000).optional(),
  callerRole: z.string().optional(),
});

export type ShellInput = z.infer<typeof ShellInputSchema>;

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: { stdout: boolean; stderr: boolean };
}

// --------------------------- Public API -----------------------------------

/**
 * Execute `cmd` with `args` via `execFile` — never through a shell.
 *
 * @throws ShellInvalidInputError when the input isn't a valid argv
 * @throws ShellDeniedError when the binary isn't on the allow-list and the
 *         caller is not trusted
 * @throws ShellTimeoutError when the child doesn't exit within `timeoutMs`
 */
export async function runShell(
  cmd: string | string[],
  opts: Omit<ShellInput, "cmd"> = {},
): Promise<ShellResult> {
  const parsed = ShellInputSchema.parse({ cmd, ...opts });
  const argv = normalizeArgv(parsed.cmd);
  const [binary, ...args] = argv;

  const isTrusted = parsed.callerRole === "system";
  if (!isTrusted && !SHELL_ALLOWLIST.has(binary)) {
    throw new ShellDeniedError(binary);
  }

  const timeoutMs = parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execOptions: ExecFileOptions = {
    cwd: parsed.cwd ?? process.cwd(),
    timeout: timeoutMs,
    maxBuffer: STDOUT_CAP_BYTES + STDERR_CAP_BYTES + 4_096,
    windowsHide: true,
    // `shell: false` is already the default for execFile; we set it
    // explicitly so a future refactor can't silently flip it on.
    shell: false,
  };
  if (parsed.env) {
    execOptions.env = parsed.env;
  }

  return new Promise<ShellResult>((resolve, reject) => {
    const child = execFile(binary, args, execOptions, (err, stdout, stderr) => {
      const stdoutStr = typeof stdout === "string" ? stdout : stdout.toString("utf8");
      const stderrStr = typeof stderr === "string" ? stderr : stderr.toString("utf8");
      const truncatedOut = stdoutStr.length > STDOUT_CAP_BYTES;
      const truncatedErr = stderrStr.length > STDERR_CAP_BYTES;
      const result: ShellResult = {
        stdout: truncatedOut ? stdoutStr.slice(0, STDOUT_CAP_BYTES) : stdoutStr,
        stderr: truncatedErr ? stderrStr.slice(0, STDERR_CAP_BYTES) : stderrStr,
        exitCode: (child.exitCode ?? 0) as number,
        truncated: { stdout: truncatedOut, stderr: truncatedErr },
      };

      if (err) {
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        const signal = (err as NodeJS.ErrnoException & { signal?: string }).signal;
        if (killed && (signal === "SIGTERM" || signal === "SIGKILL")) {
          return reject(new ShellTimeoutError(timeoutMs));
        }
        // Non-zero exit is a normal outcome for a shell tool; surface it.
        const code = typeof (err as NodeJS.ErrnoException).code === "number"
          ? ((err as unknown as { code: number }).code)
          : child.exitCode ?? 1;
        resolve({ ...result, exitCode: code });
        return;
      }
      resolve(result);
    });
  });
}

// --------------------------- Helpers --------------------------------------

/**
 * Coerce `cmd` into an argv array. Strings are rejected if they contain
 * anything that looks like shell metacharacters — we want callers to pass
 * structured argv, not "compose a command line."
 */
function normalizeArgv(cmd: string | string[]): [string, ...string[]] {
  if (Array.isArray(cmd)) {
    if (cmd.length === 0) {
      throw new ShellInvalidInputError("argv array must be non-empty");
    }
    return [cmd[0], ...cmd.slice(1)] as [string, ...string[]];
  }
  if (/[\s;&|`$><]/.test(cmd)) {
    throw new ShellInvalidInputError(
      "string cmd must be a single token — pass an argv array for multi-arg commands",
    );
  }
  return [cmd];
}
