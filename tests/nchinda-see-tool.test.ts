import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nchindaSee } from "../src/mcp/nchinda-see.js";
import { NCHINDA_SEE_SCHEMA, NCHINDA_TOOL_SCHEMAS } from "../src/mcp/tool-schema.js";
import { buildBrief } from "../src/perception/vision-brief.js";
import type { ScreenCapturer, ScreenFrame } from "../src/perception/_c1-stub.js";

function makeFrame(overrides: Partial<ScreenFrame> = {}): ScreenFrame {
  return {
    id: "see-frame-1",
    ts: new Date("2026-04-15T10:00:00Z"),
    png_path: "/tmp/see.png",
    active_app: "Safari",
    window_title: "Claude — claude.ai",
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

class FakeCapturer implements ScreenCapturer {
  public captures: number = 0;
  public queued: ScreenFrame[] = [];
  constructor(frames: ScreenFrame[] = []) {
    this.queued = [...frames];
  }
  async captureNow(): Promise<ScreenFrame> {
    this.captures++;
    const f = this.queued.shift();
    if (!f) throw new Error("FakeCapturer: no frames queued");
    return f;
  }
  getRecent(): ScreenFrame[] {
    return [];
  }
}

describe("nchinda_see — MCP tool", () => {
  test("defaults to local-only mode and round-trips a brief", async () => {
    const cap = new FakeCapturer([
      makeFrame({ ocr_text: "hello world" }),
    ]);
    let fetchCalled = false;
    const spy: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

    const brief = await nchindaSee(
      {},
      { capturer: cap, brief: buildBrief, fetchImpl: spy, apiKey: "should-not-be-used" },
    );

    assert.equal(cap.captures, 1);
    assert.equal(fetchCalled, false, "local-only must not reach fetch");
    assert.equal(brief.active_app, "Safari");
    assert.equal(brief.window_title, "Claude — claude.ai");
    assert.equal(brief.visible_text, "hello world");
    assert.equal(brief.source_frame_id, "see-frame-1");
  });

  test("explicit mode=llm path invokes the brief with llm mode", async () => {
    const cap = new FakeCapturer([makeFrame({ ocr_text: "foo" })]);
    let receivedMode: string | undefined;
    const fakeBrief: typeof buildBrief = async (frame, _deps, opts) => {
      receivedMode = opts?.mode;
      return {
        active_app: frame.active_app,
        window_title: frame.window_title,
        summary: "stubbed",
        visible_text: frame.ocr_text ?? "",
        ts: frame.ts.toISOString(),
        source_frame_id: frame.id,
      };
    };
    await nchindaSee(
      { mode: "llm" },
      { capturer: cap, brief: fakeBrief, apiKey: "test-key" },
    );
    assert.equal(receivedMode, "llm");
  });

  test("rejects bogus mode via zod", async () => {
    const cap = new FakeCapturer([makeFrame()]);
    await assert.rejects(
      () =>
        nchindaSee(
          { mode: "telepathy" },
          { capturer: cap, brief: buildBrief },
        ),
      /mode/i,
    );
    assert.equal(cap.captures, 0, "capture should not run for bad input");
  });

  test("accepts null/undefined input by defaulting to local-only", async () => {
    const cap = new FakeCapturer([makeFrame()]);
    const brief = await nchindaSee(undefined, { capturer: cap, brief: buildBrief });
    assert.equal(cap.captures, 1);
    assert.ok(brief.summary.length > 0);
  });

  test("private-app frame still returns a brief but never reaches the LLM", async () => {
    const cap = new FakeCapturer([
      makeFrame({ active_app: "1Password", window_title: "All Items" }),
    ]);
    let fetchCalled = false;
    const spy: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };
    const brief = await nchindaSee(
      { mode: "llm" },
      { capturer: cap, brief: buildBrief, apiKey: "x", fetchImpl: spy },
    );
    assert.equal(fetchCalled, false);
    assert.equal(brief.active_app, "1Password");
  });

  test("capture failure propagates as an error (no silent catch)", async () => {
    const cap: ScreenCapturer = {
      async captureNow() {
        throw new Error("permission-denied");
      },
      getRecent() {
        return [];
      },
    };
    await assert.rejects(
      () => nchindaSee({}, { capturer: cap, brief: buildBrief }),
      /permission-denied/,
    );
  });
});

describe("nchinda_see — schema registration", () => {
  test("NCHINDA_SEE_SCHEMA is part of NCHINDA_TOOL_SCHEMAS", () => {
    const names = NCHINDA_TOOL_SCHEMAS.map((s) => s.name);
    assert.ok(
      names.includes("nchinda_see"),
      "nchinda_see should be registered in NCHINDA_TOOL_SCHEMAS",
    );
  });

  test("NCHINDA_SEE_SCHEMA describes the expected input surface", () => {
    assert.equal(NCHINDA_SEE_SCHEMA.name, "nchinda_see");
    assert.equal(NCHINDA_SEE_SCHEMA.inputSchema.type, "object");
    assert.equal(NCHINDA_SEE_SCHEMA.inputSchema.additionalProperties, false);
    const mode = (
      NCHINDA_SEE_SCHEMA.inputSchema.properties as Record<string, { enum?: string[] }>
    ).mode;
    assert.deepEqual(mode?.enum, ["local-only", "llm"]);
  });
});
