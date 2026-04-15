import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runShell,
  ShellDeniedError,
  ShellTimeoutError,
  ShellInvalidInputError,
  SHELL_ALLOWLIST,
} from "../src/tools/shell.js";

describe("runShell — allow-list enforcement", () => {
  test("rejects binary outside the allow-list (untrusted)", async () => {
    await assert.rejects(
      () => runShell("rm", { callerRole: "coder" }),
      (err: unknown) => err instanceof ShellDeniedError,
    );
  });

  test("rejects argv whose [0] is outside the allow-list (untrusted)", async () => {
    await assert.rejects(
      () => runShell(["rm", "-rf", "/"], { callerRole: "coder" }),
      (err: unknown) => err instanceof ShellDeniedError,
    );
  });

  test("bypasses allow-list when callerRole === 'system'", async () => {
    // Use `true` which exists on every POSIX box and is NOT on the allow-list.
    const result = await runShell(["true"], { callerRole: "system" });
    assert.equal(result.exitCode, 0);
  });

  test("allow-list contains the expected read-only binaries", () => {
    assert.ok(SHELL_ALLOWLIST.has("git"));
    assert.ok(SHELL_ALLOWLIST.has("ls"));
    assert.ok(!SHELL_ALLOWLIST.has("rm"));
    assert.ok(!SHELL_ALLOWLIST.has("curl"));
    assert.ok(!SHELL_ALLOWLIST.has("ssh"));
  });
});

describe("runShell — injection hardening", () => {
  test("rejects shell metacharacters in string cmd", async () => {
    await assert.rejects(
      () => runShell("ls; rm -rf /"),
      (err: unknown) => err instanceof ShellInvalidInputError,
    );
  });

  test("rejects pipes / backticks / dollar-subs in string cmd", async () => {
    for (const bad of ["ls | cat", "echo `whoami`", "echo $(whoami)"]) {
      await assert.rejects(
        () => runShell(bad),
        (err: unknown) => err instanceof ShellInvalidInputError,
        `should reject ${bad}`,
      );
    }
  });

  test("argv form with an already-on-allowlist binary never hits the shell", async () => {
    // If we were using shell:true, "echo; ls" would pipe — we should pass
    // the arg literally instead.
    const result = await runShell(["echo", "hello; ls"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello; ls");
  });
});

describe("runShell — timeout + truncation", () => {
  test("rejects with ShellTimeoutError when child exceeds timeoutMs", async () => {
    await assert.rejects(
      () =>
        runShell(["node", "-e", "setTimeout(() => {}, 5000)"], {
          timeoutMs: 100,
        }),
      (err: unknown) => err instanceof ShellTimeoutError,
    );
  });

  test("stdout truncation flag set when output exceeds 256 KB", async () => {
    // Emit ~300 KB — comfortably above the 256 KB cap.
    const script =
      "const buf = 'x'.repeat(1024); for (let i = 0; i < 300; i++) { process.stdout.write(buf); }";
    const result = await runShell(["node", "-e", script], { timeoutMs: 10_000 });
    assert.equal(result.truncated.stdout, true);
    assert.equal(result.stdout.length, 256 * 1024);
  });
});

describe("runShell — normal execution", () => {
  test("returns stdout + exitCode 0 on success", async () => {
    const result = await runShell(["echo", "hello-shell-tool"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello-shell-tool");
    assert.equal(result.stderr, "");
    assert.equal(result.truncated.stdout, false);
  });

  test("reports non-zero exit without throwing", async () => {
    const result = await runShell(["node", "-e", "process.exit(7)"]);
    assert.equal(result.exitCode, 7);
  });

  test("respects cwd option", async () => {
    const result = await runShell(["pwd"], { cwd: "/tmp" });
    assert.equal(result.exitCode, 0);
    // macOS resolves /tmp to /private/tmp
    assert.match(result.stdout.trim(), /^(\/private)?\/tmp$/);
  });
});
