import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  echoExecutor,
  webSearchStub,
  shellStub,
  runProbe,
  DEFAULT_EXECUTORS,
  type ProbeExecutor,
} from "../src/research/probe-executors.js";

describe("echoExecutor", () => {
  test("matches any probe", () => {
    assert.equal(echoExecutor.canRun("anything"), true);
    assert.equal(echoExecutor.canRun(""), true);
  });

  test("returns the probe text as result", async () => {
    const r = await echoExecutor.run("check the db is up");
    assert.match(r, /check the db is up/);
    assert.match(r, /^echo:/);
  });
});

describe("webSearchStub", () => {
  test("matches web_search-shaped probes", () => {
    assert.ok(webSearchStub.canRun("web_search axios retry"));
    assert.ok(webSearchStub.canRun("google the error message"));
    assert.ok(webSearchStub.canRun("search the web for 401 recovery"));
  });

  test("does not match arbitrary text", () => {
    assert.equal(webSearchStub.canRun("list pods"), false);
    assert.equal(webSearchStub.canRun("does the server respond?"), false);
  });

  test("result is tagged TODO-phase-3", async () => {
    const r = await webSearchStub.run("web_search axios retry");
    assert.match(r, /TODO-phase-3/);
    assert.match(r, /axios retry/);
  });
});

describe("shellStub", () => {
  test("matches shell-shaped probes", () => {
    assert.ok(shellStub.canRun("shell: grep 401 ~/logs"));
    assert.ok(shellStub.canRun("$ ls -la"));
    assert.ok(shellStub.canRun("bash -c 'echo hi'"));
    assert.ok(shellStub.canRun("grep token src/"));
  });

  test("does not match prose", () => {
    assert.equal(shellStub.canRun("consult the design doc"), false);
  });

  test("result is tagged TODO-phase-3", async () => {
    const r = await shellStub.run("shell: grep 401");
    assert.match(r, /TODO-phase-3/);
  });
});

describe("runProbe dispatch", () => {
  test("picks first matching executor in order", async () => {
    const seen: string[] = [];
    const a: ProbeExecutor = {
      name: "a",
      canRun: (p) => p.startsWith("A"),
      run: async (p) => {
        seen.push("a");
        return `A-${p}`;
      },
    };
    const b: ProbeExecutor = {
      name: "b",
      canRun: (p) => p.startsWith("A"),
      run: async (p) => {
        seen.push("b");
        return `B-${p}`;
      },
    };
    const out = await runProbe("A1", [a, b]);
    assert.equal(out.executor, "a");
    assert.equal(out.result, "A-A1");
    assert.deepEqual(seen, ["a"]);
  });

  test("falls back to echo when nothing matches", async () => {
    const none: ProbeExecutor = {
      name: "none",
      canRun: () => false,
      run: async () => "should not run",
    };
    const out = await runProbe("random", [none]);
    assert.equal(out.executor, "echo");
    assert.match(out.result, /^echo: random/);
  });

  test("DEFAULT_EXECUTORS routes web probes to web-search-stub", async () => {
    const out = await runProbe("web_search jwt refresh pattern", DEFAULT_EXECUTORS);
    assert.equal(out.executor, "web-search-stub");
  });

  test("DEFAULT_EXECUTORS routes shell probes to shell-stub", async () => {
    const out = await runProbe("grep 401 logs/", DEFAULT_EXECUTORS);
    assert.equal(out.executor, "shell-stub");
  });

  test("DEFAULT_EXECUTORS falls through to echo for prose", async () => {
    const out = await runProbe(
      "Check whether the cache TTL matches the token lifetime",
      DEFAULT_EXECUTORS,
    );
    assert.equal(out.executor, "echo");
  });
});
