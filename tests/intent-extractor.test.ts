import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractIntent,
  type VoiceIntent,
  type VoiceIntentKind,
} from "../src/voice/intent-extractor.js";

interface Row {
  input: string;
  kind: VoiceIntentKind;
  confidence: number;
}

describe("extractIntent — classification table", () => {
  const rows: Row[] = [
    // kill — exact + punctuation + whitespace + caps
    { input: "stop", kind: "kill", confidence: 1 },
    { input: "Stop.", kind: "kill", confidence: 1 },
    { input: "  STOP!  ", kind: "kill", confidence: 1 },
    { input: "kill", kind: "kill", confidence: 1 },
    { input: "cancel", kind: "kill", confidence: 1 },
    { input: "abort", kind: "kill", confidence: 1 },
    { input: "shut up", kind: "kill", confidence: 1 },
    { input: "quiet", kind: "kill", confidence: 1 },
    { input: "halt", kind: "kill", confidence: 1 },
    { input: "enough", kind: "kill", confidence: 1 },

    // kill — soft natural variants
    { input: "please stop", kind: "kill", confidence: 1 },
    { input: "stop please", kind: "kill", confidence: 1 },
    { input: "stop now", kind: "kill", confidence: 1 },
    { input: "stop it", kind: "kill", confidence: 1 },

    // pause
    { input: "pause", kind: "pause", confidence: 1 },
    { input: "hold", kind: "pause", confidence: 1 },
    { input: "hold on", kind: "pause", confidence: 1 },
    { input: "wait", kind: "pause", confidence: 1 },

    // resume
    { input: "continue", kind: "resume", confidence: 1 },
    { input: "resume", kind: "resume", confidence: 1 },
    { input: "go on", kind: "resume", confidence: 1 },
    { input: "carry on", kind: "resume", confidence: 1 },

    // config
    { input: "nchinda, set voice to samantha", kind: "config", confidence: 1 },
    { input: "Nchinda change the wake word", kind: "config", confidence: 1 },
    { input: "nchinda configure capture interval", kind: "config", confidence: 1 },

    // task fallback
    { input: "summarize my inbox", kind: "task", confidence: 0.5 },
    { input: "what's on my calendar today", kind: "task", confidence: 0.5 },
    {
      input: "please refactor the payments module",
      kind: "task",
      confidence: 0.5,
    },
    // Typo that should NOT trigger kill — falls through to task.
    { input: "stp", kind: "task", confidence: 0.5 },
    // Embedded "stop" inside a sentence is NOT a kill command.
    { input: "don't stop the service", kind: "task", confidence: 0.5 },
  ];

  for (const row of rows) {
    it(`maps ${JSON.stringify(row.input)} → ${row.kind}`, () => {
      const result = extractIntent(row.input);
      assert.equal(result.kind, row.kind);
      assert.equal(result.confidence, row.confidence);
    });
  }
});

describe("extractIntent — edge cases", () => {
  it("returns task with confidence 0 for empty string", () => {
    const r = extractIntent("");
    assert.equal(r.kind, "task");
    assert.equal(r.confidence, 0);
    assert.equal(r.payload?.transcript, "");
  });

  it("returns task with confidence 0 for whitespace-only input", () => {
    const r = extractIntent("   \t \n  ");
    assert.equal(r.kind, "task");
    assert.equal(r.confidence, 0);
  });

  it("includes normalized transcript in payload for task fallback", () => {
    const r = extractIntent("  read my email  ");
    assert.equal(r.kind, "task");
    assert.equal(r.payload?.transcript, "read my email");
  });

  it("includes normalized transcript for kill matches", () => {
    const r = extractIntent("  Stop!  ");
    assert.equal(r.kind, "kill");
    assert.equal(r.payload?.transcript, "Stop");
  });

  it("throws TypeError on non-string input", () => {
    // @ts-expect-error intentional bad input
    assert.throws(() => extractIntent(null), TypeError);
    // @ts-expect-error intentional bad input
    assert.throws(() => extractIntent(undefined), TypeError);
    // @ts-expect-error intentional bad input
    assert.throws(() => extractIntent(42), TypeError);
  });

  it("is deterministic — same input returns equivalent output", () => {
    const a: VoiceIntent = extractIntent("stop");
    const b: VoiceIntent = extractIntent("stop");
    assert.deepEqual(a, b);
  });
});
