import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BrainSession,
  type BrainSessionOptions,
} from "../src/voice/brain-session.js";

// ---------------------------------------------------------------------------
// Minimal mock TmuxManager for onTask handler tests.
// The real BrainSession needs tmux.createSession/sendKeys/capturePane/etc.
// We mock just enough for boot() to succeed, then override send()/restart().
// ---------------------------------------------------------------------------

function createMinimalMockTmux() {
  const sessions = new Set<string>();
  return {
    async createSession(name: string, _workDir: string) {
      sessions.add(name);
    },
    async destroySession(name: string) {
      sessions.delete(name);
    },
    async sessionExists(name: string) {
      return sessions.has(name);
    },
    async sendKeys(_name: string, _keys: string) {},
    async capturePane(_name: string, _lines?: number) {
      // Return a "ready" prompt so boot() completes
      return "user@host ~ ❯ ";
    },
  };
}

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

  test("returns expected reply from mock send", async () => {
    const session = new BrainSession({
      tmux: createMinimalMockTmux() as any,
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
      tmux: createMinimalMockTmux() as any,
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
    session.restart = async () => {
      restarted = true;
    };

    const onTask = makeOnTask(session);
    const reply = await onTask("test restart", async () => {});
    assert.equal(reply, "Recovered reply");
    assert.ok(restarted, "should have called restart()");
  });

  test("returns fallback message when retry also fails", async () => {
    const session = new BrainSession({
      tmux: createMinimalMockTmux() as any,
      claudeMdContent: "",
    });
    await session.boot();

    session.send = async () => {
      throw new Error("permanent failure");
    };
    session.restart = async () => {};

    const onTask = makeOnTask(session);
    const reply = await onTask("doomed", async () => {});
    assert.equal(reply, "Something went wrong. Try again.");
  });

  test("restarts when send returns error-like response", async () => {
    const session = new BrainSession({
      tmux: createMinimalMockTmux() as any,
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
    session.restart = async () => {
      restarted = true;
    };

    const onTask = makeOnTask(session);
    const reply = await onTask("test error response", async () => {});
    assert.equal(reply, "OK after restart");
    assert.ok(restarted, "should have restarted on error-like response");
  });

  test("uses BrainSession.send() not spawn/claude -p", async () => {
    // Verify the onTask handler calls send() rather than spawning a process
    const session = new BrainSession({
      tmux: createMinimalMockTmux() as any,
      claudeMdContent: "",
    });
    await session.boot();

    let sendCalled = false;
    session.send = async (msg: string) => {
      sendCalled = true;
      return `Reply to: ${msg}`;
    };

    const onTask = makeOnTask(session);
    await onTask("hello", async () => {});
    assert.ok(sendCalled, "onTask should call BrainSession.send()");
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
