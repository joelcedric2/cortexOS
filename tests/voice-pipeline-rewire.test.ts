import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  BrainSession,
  buildBrainClaudeMd,
  type BrainSessionOptions,
} from "../src/voice/_gap-stubs.js";

// ---------------------------------------------------------------------------
// Unit tests for the gap-stubs (BrainSession + buildBrainClaudeMd).
// These verify the interface contract that cortex.ts depends on.
// When Agent 1 & 3 land real implementations, these tests should still pass.
// ---------------------------------------------------------------------------

describe("BrainSession", () => {
  let session: BrainSession;
  const opts: BrainSessionOptions = {
    tmux: {} as BrainSessionOptions["tmux"],
    claudeMdContent: "# test brain CLAUDE.md",
  };

  beforeEach(() => {
    session = new BrainSession(opts);
  });

  test("boot() makes the session alive", async () => {
    await session.boot();
    assert.equal(await session.isAlive(), true);
  });

  test("send() returns a reply after boot", async () => {
    await session.boot();
    const reply = await session.send("What time is it?");
    assert.ok(reply.length > 0, "reply should not be empty");
  });

  test("send() throws when session is not booted", async () => {
    await assert.rejects(
      () => session.send("hello"),
      /BrainSession is not running/,
    );
  });

  test("shutdown() makes the session not alive", async () => {
    await session.boot();
    await session.shutdown();
    assert.equal(await session.isAlive(), false);
  });

  test("restart() recovers a shutdown session", async () => {
    await session.boot();
    await session.shutdown();
    assert.equal(await session.isAlive(), false);
    await session.restart();
    assert.equal(await session.isAlive(), true);
    const reply = await session.send("test after restart");
    assert.ok(reply.length > 0);
  });
});

describe("buildBrainClaudeMd", () => {
  test("returns a non-empty string", async () => {
    const md = await buildBrainClaudeMd({
      vectorStore: {} as any,
      embedder: {} as any,
      userName: "Cedric",
    });
    assert.ok(md.length > 0);
    assert.ok(md.includes("Cedric"), "should include the user name");
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests for the onTask handler logic extracted from
// cortex.ts. We replicate the handler's retry/restart pattern here to
// verify it without spinning up the full CortexController.
// ---------------------------------------------------------------------------

describe("onTask handler (BrainSession-backed)", () => {
  /**
   * Builds the same onTask closure that cortex.ts creates, but with a
   * provided BrainSession so we can mock it.
   */
  function makeOnTask(brainSession: BrainSession) {
    return async (transcript: string, _narrate: (u: string) => Promise<void>): Promise<string> => {
      try {
        let reply = await brainSession.send(transcript);

        if (!reply || reply.startsWith("[error]")) {
          await brainSession.restart();
          reply = await brainSession.send(transcript);
        }

        return reply;
      } catch {
        try {
          await brainSession.restart();
          return await brainSession.send(transcript);
        } catch {
          return "Something went wrong. Try again.";
        }
      }
    };
  }

  test("calls brainSession.send() with the transcript", async () => {
    const session = new BrainSession({
      tmux: {} as any,
      claudeMdContent: "",
    });
    await session.boot();

    const onTask = makeOnTask(session);
    const narrate = async () => {};

    const reply = await onTask("What time is it?", narrate);
    assert.ok(reply.includes("What time is it?"), "reply should echo transcript (stub)");
  });

  test("returns expected reply from mock send", async () => {
    const session = new BrainSession({
      tmux: {} as any,
      claudeMdContent: "",
    });
    await session.boot();

    // Override send to return a fixed response
    session.send = async (_msg: string) => "The time is 8:30 PM";

    const onTask = makeOnTask(session);
    const reply = await onTask("What time is it?", async () => {});
    assert.equal(reply, "The time is 8:30 PM");
  });

  test("auto-restarts on send failure and retries", async () => {
    const session = new BrainSession({
      tmux: {} as any,
      claudeMdContent: "",
    });
    await session.boot();

    let callCount = 0;
    session.send = async (_msg: string) => {
      callCount++;
      if (callCount === 1) throw new Error("connection lost");
      return "Recovered reply";
    };

    let restarted = false;
    const origRestart = session.restart.bind(session);
    session.restart = async () => {
      restarted = true;
      await origRestart();
    };

    const onTask = makeOnTask(session);
    const reply = await onTask("test restart", async () => {});
    assert.equal(reply, "Recovered reply");
    assert.ok(restarted, "should have called restart()");
  });

  test("returns fallback message when retry also fails", async () => {
    const session = new BrainSession({
      tmux: {} as any,
      claudeMdContent: "",
    });
    await session.boot();

    session.send = async () => {
      throw new Error("permanent failure");
    };

    const onTask = makeOnTask(session);
    const reply = await onTask("doomed", async () => {});
    assert.equal(reply, "Something went wrong. Try again.");
  });

  test("restarts when send returns error-like response", async () => {
    const session = new BrainSession({
      tmux: {} as any,
      claudeMdContent: "",
    });
    await session.boot();

    let callCount = 0;
    session.send = async () => {
      callCount++;
      if (callCount === 1) return "[error] session dead";
      return "OK after restart";
    };

    let restarted = false;
    const origRestart = session.restart.bind(session);
    session.restart = async () => {
      restarted = true;
      await origRestart();
    };

    const onTask = makeOnTask(session);
    const reply = await onTask("test error response", async () => {});
    assert.equal(reply, "OK after restart");
    assert.ok(restarted, "should have restarted on error-like response");
  });
});

// ---------------------------------------------------------------------------
// Verify cortex.ts import/structure (compile-time check)
// ---------------------------------------------------------------------------

describe("cortex.ts structure", () => {
  test("cortex module exports CortexController", async () => {
    // This import will fail at compile time if the module is broken
    const mod = await import("../src/controller/cortex.js");
    assert.ok(mod.CortexController, "CortexController should be exported");
  });
});
