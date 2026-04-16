/**
 * Phase 9 — nchinda_look MCP tool tests.
 *
 * Uses fake capture + OCR + fetch so the real camera / network are never
 * touched. Covers the happy Sonnet path, the local-only fallback, zod
 * rejection on malformed input, and the MCP schema registration.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  nchindaLook,
  NchindaLookInputSchema,
} from "../src/mcp/nchinda-look.js";
import {
  NCHINDA_LOOK_SCHEMA,
  NCHINDA_TOOL_SCHEMAS,
} from "../src/mcp/tool-schema.js";
import type { CameraFrame } from "../src/perception/camera-capture.js";

function makeFrame(overrides: Partial<CameraFrame> = {}): CameraFrame {
  return {
    id: "look-frame-1",
    ts: new Date("2026-04-15T12:00:00Z"),
    jpeg_path: "/tmp/fake.jpg",
    width: 1280,
    height: 720,
    device: "front",
    ...overrides,
  };
}

function fakeCapture(frame: CameraFrame) {
  let calls = 0;
  const fn = (async (opts?: { device?: "front" | "back" | "continuity" }) => {
    calls++;
    return {
      ...frame,
      device: opts?.device ?? frame.device,
    };
  }) as any;
  fn.calls = () => calls;
  return fn;
}

function jpegOnDisk(dir: string, body: string = "fake-jpeg-bytes"): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(p, body);
  return p;
}

function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ─── Happy path ───────────────────────────────────────────────────────────

describe("nchinda_look — happy path", () => {
  it("captures a frame, runs OCR, and returns a Sonnet description", async () => {
    await withTempDir("p9-look-happy", async (dir) => {
      const jpeg = jpegOnDisk(dir);
      const frame = makeFrame({ jpeg_path: jpeg });
      const capture = fakeCapture(frame);

      let ocrPath: string | undefined;
      const ocr = async (p: string) => {
        ocrPath = p;
        return { text: "MENU\nBurger  $9" };
      };

      let sonnetBody: any;
      const haikuFetch: typeof fetch = async (_url, init) => {
        sonnetBody = JSON.parse((init?.body ?? "{}") as string);
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: "A diner menu. A burger listed at nine dollars is the first visible item.",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const result = await nchindaLook(
        { question: "what am I looking at", device: "continuity", mode: "still" },
        { capture, ocr, haikuFetch, apiKey: "test-key" },
      );

      assert.equal(capture.calls(), 1);
      assert.equal(ocrPath, jpeg);
      assert.match(result.description, /diner menu|burger/i);
      assert.equal(result.ocr_text, "MENU\nBurger  $9");
      assert.equal(result.frame.id, "look-frame-1");
      assert.equal(result.frame.path, jpeg);
      assert.ok(result.frame.ts.startsWith("2026-04-15"));

      // Sonnet request shape — image block + text block, Sonnet model.
      assert.equal(sonnetBody.model, "claude-sonnet-4-6");
      assert.ok(Array.isArray(sonnetBody.messages[0].content));
      const types = sonnetBody.messages[0].content.map((b: any) => b.type);
      assert.ok(types.includes("image"));
      assert.ok(types.includes("text"));
    });
  });

  it("forwards the device selection to the capture call", async () => {
    await withTempDir("p9-look-device", async (dir) => {
      const jpeg = jpegOnDisk(dir);
      let sawDevice: string | undefined;
      const capture = (async (opts?: { device?: string }) => {
        sawDevice = opts?.device;
        return makeFrame({ jpeg_path: jpeg, device: opts?.device ?? "front" });
      }) as any;

      const ocr = async () => ({ text: "" });
      const haikuFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "A kitchen scene." }] }),
          { status: 200 },
        );

      await nchindaLook(
        { device: "back", mode: "still" },
        { capture, ocr, haikuFetch, apiKey: "k" },
      );
      assert.equal(sawDevice, "back");
    });
  });
});

// ─── Fallback path ────────────────────────────────────────────────────────

describe("nchinda_look — LLM fallback", () => {
  it("returns local-only reply when no API key is supplied", async () => {
    await withTempDir("p9-look-no-key", async (dir) => {
      const jpeg = jpegOnDisk(dir);
      const capture = fakeCapture(makeFrame({ jpeg_path: jpeg }));
      const ocr = async () => ({ text: "Boarding Pass LAX → JFK" });
      let fetchCalled = false;
      const haikuFetch: typeof fetch = async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      };

      // Clear env for deterministic fallback behaviour.
      const prev = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const result = await nchindaLook(
          { question: "where am I flying", mode: "still" },
          { capture, ocr, haikuFetch },
        );
        assert.equal(fetchCalled, false, "no fetch when no api key");
        assert.match(result.description, /no-api-key/);
        assert.match(result.description, /Boarding Pass/);
        assert.equal(result.ocr_text, "Boarding Pass LAX → JFK");
      } finally {
        if (prev) process.env.ANTHROPIC_API_KEY = prev;
      }
    });
  });

  it("falls back locally when Sonnet returns HTTP 500", async () => {
    await withTempDir("p9-look-500", async (dir) => {
      const jpeg = jpegOnDisk(dir);
      const capture = fakeCapture(makeFrame({ jpeg_path: jpeg }));
      const ocr = async () => ({ text: "hello" });
      const haikuFetch: typeof fetch = async () =>
        new Response("boom", { status: 500 });

      const result = await nchindaLook(
        { question: "hi", mode: "still" },
        { capture, ocr, haikuFetch, apiKey: "key" },
      );
      assert.match(result.description, /Local-only reply/);
      assert.match(result.description, /http-500/);
    });
  });

  it("falls back locally when the fetch throws (network error)", async () => {
    await withTempDir("p9-look-net", async (dir) => {
      const jpeg = jpegOnDisk(dir);
      const capture = fakeCapture(makeFrame({ jpeg_path: jpeg }));
      const ocr = async () => ({ text: "" });
      const haikuFetch: typeof fetch = async () => {
        throw new Error("ECONNRESET");
      };

      const result = await nchindaLook(
        { mode: "still" },
        { capture, ocr, haikuFetch, apiKey: "key" },
      );
      assert.match(result.description, /Local-only reply/);
      assert.match(result.description, /network/);
      assert.equal(result.ocr_text, undefined);
    });
  });

  it("falls back when JPEG cannot be read from disk", async () => {
    const capture = fakeCapture(
      makeFrame({ jpeg_path: "/tmp/does-not-exist-9871263.jpg" }),
    );
    const ocr = async () => ({ text: "" });
    const haikuFetch: typeof fetch = async () => new Response("{}", { status: 200 });

    const result = await nchindaLook(
      { mode: "still" },
      { capture, ocr, haikuFetch, apiKey: "key" },
    );
    assert.match(result.description, /Local-only reply/);
    assert.match(result.description, /read-failed/);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────

describe("nchinda_look — input validation", () => {
  it("accepts an empty input object and defaults the device", async () => {
    // zod parses {} as valid — the handler uses captured defaults downstream.
    const parsed = NchindaLookInputSchema.parse({});
    assert.equal(parsed.question, undefined);
    assert.equal(parsed.device, undefined);
  });

  it("rejects an invalid device value", async () => {
    await assert.rejects(
      () =>
        nchindaLook(
          { device: "selfie" },
          { capture: (async () => makeFrame()) as any },
        ),
      (err) => {
        assert.ok(err instanceof Error);
        return /device/i.test(err.message) || /enum/i.test(err.message);
      },
    );
  });

  it("rejects a non-string question", async () => {
    await assert.rejects(
      () =>
        nchindaLook(
          { question: 42 },
          { capture: (async () => makeFrame()) as any },
        ),
    );
  });

  it("rejects an empty-string question", async () => {
    await assert.rejects(
      () =>
        nchindaLook(
          { question: "" },
          { capture: (async () => makeFrame()) as any },
        ),
    );
  });
});

// ─── MCP schema registration ──────────────────────────────────────────────

describe("nchinda_look — MCP schema", () => {
  it("is listed in NCHINDA_TOOL_SCHEMAS", () => {
    const names = NCHINDA_TOOL_SCHEMAS.map((s) => s.name);
    assert.ok(names.includes("nchinda_look"));
  });

  it("exposes question + device + mode as optional properties", () => {
    assert.equal(NCHINDA_LOOK_SCHEMA.name, "nchinda_look");
    const props = NCHINDA_LOOK_SCHEMA.inputSchema.properties;
    assert.ok(props.question);
    assert.ok(props.device);
    assert.ok(props.mode);
    assert.equal(NCHINDA_LOOK_SCHEMA.inputSchema.required, undefined);
  });
});
