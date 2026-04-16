/**
 * Phase 9 — `captureCameraFrame` unit tests.
 *
 * Uses an injected fake bridge so the real AVFoundation helper is never
 * touched; asserts the plumbing (device routing, frame shape, audit
 * append, typed errors) works as specified.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  captureCameraFrame,
  CameraCaptureError,
  type NativeBridge,
  type NativeCameraResult,
} from "../src/perception/camera-capture.js";
import { AuditLog } from "../src/proactivity/audit.js";

function makeBridge(
  impl: (opts: {
    outPath: string;
    device?: "front" | "back" | "continuity";
  }) => Promise<NativeCameraResult>,
): NativeBridge {
  return { cameraCapture: impl };
}

function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("captureCameraFrame — happy path", () => {
  it("plumbs device=continuity through to the bridge", async () => {
    await withTempDir("p9-cam-cont", async (dir) => {
      let seen: { outPath: string; device?: string } | null = null;
      const bridge = makeBridge(async ({ outPath, device }) => {
        seen = { outPath, device };
        return {
          width: 1920,
          height: 1080,
          device: "continuity",
          jpeg_path: outPath,
          bytes: 12345,
          ts: 1712000000000,
        };
      });

      const frame = await captureCameraFrame({
        device: "continuity",
        bridge,
        outputDir: dir,
      });

      assert.equal(seen?.device, "continuity");
      assert.equal(frame.device, "continuity");
      assert.equal(frame.width, 1920);
      assert.equal(frame.height, 1080);
      assert.equal(frame.jpeg_path, seen?.outPath);
      assert.ok(frame.id.length > 0);
      assert.ok(frame.ts instanceof Date);
    });
  });

  it("defaults to front camera when device is omitted", async () => {
    await withTempDir("p9-cam-front", async (dir) => {
      let sawDevice: string | undefined;
      const bridge = makeBridge(async ({ outPath, device }) => {
        sawDevice = device;
        return {
          width: 640,
          height: 480,
          device: "front",
          jpeg_path: outPath,
          bytes: 4200,
          ts: Date.now(),
        };
      });

      const frame = await captureCameraFrame({ bridge, outputDir: dir });
      assert.equal(sawDevice, "front");
      assert.equal(frame.device, "front");
    });
  });

  it("appends an audit entry with action=camera_capture when wired", async () => {
    await withTempDir("p9-cam-audit", async (dir) => {
      const auditFile = join(dir, "audit.ndjson");
      const audit = new AuditLog(auditFile);
      const bridge = makeBridge(async ({ outPath }) => ({
        width: 100,
        height: 100,
        device: "front",
        jpeg_path: outPath,
        bytes: 777,
        ts: Date.now(),
      }));

      await captureCameraFrame({
        bridge,
        outputDir: dir,
        audit,
      });

      assert.ok(existsSync(auditFile));
      const content = readFileSync(auditFile, "utf-8").trim();
      const lines = content.split("\n").filter((l) => l.length > 0);
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]!);
      assert.equal(record.action, "camera_capture");
      assert.ok(/device=front/.test(record.detail));
      assert.ok(/bytes=777/.test(record.detail));
    });
  });

  it("does not require an audit log", async () => {
    await withTempDir("p9-cam-no-audit", async (dir) => {
      const bridge = makeBridge(async ({ outPath }) => ({
        width: 1,
        height: 1,
        device: "back",
        jpeg_path: outPath,
        bytes: 1,
        ts: Date.now(),
      }));

      const frame = await captureCameraFrame({
        device: "back",
        bridge,
        outputDir: dir,
      });
      assert.equal(frame.device, "back");
    });
  });
});

describe("captureCameraFrame — error surfacing", () => {
  it("rethrows permission-denied as typed CameraCaptureError", async () => {
    await withTempDir("p9-cam-perm", async (dir) => {
      const bridge = makeBridge(async () => {
        throw new CameraCaptureError(
          "permission-denied",
          "Camera permission denied.",
        );
      });

      await assert.rejects(
        () => captureCameraFrame({ bridge, outputDir: dir }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.equal(err.code, "permission-denied");
          return true;
        },
      );
    });
  });

  it("wraps unknown errors into capture-failed", async () => {
    await withTempDir("p9-cam-unknown", async (dir) => {
      const bridge = makeBridge(async () => {
        throw new Error("kernel panic");
      });

      await assert.rejects(
        () => captureCameraFrame({ bridge, outputDir: dir }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.equal(err.code, "capture-failed");
          assert.match(err.message, /kernel panic/);
          return true;
        },
      );
    });
  });

  it("rejects invalid-output when helper returns empty payload", async () => {
    await withTempDir("p9-cam-empty", async (dir) => {
      const bridge = makeBridge(async () => ({
        width: 0,
        height: 0,
        device: "",
        jpeg_path: "",
        bytes: 0,
        ts: 0,
      }));

      await assert.rejects(
        () => captureCameraFrame({ bridge, outputDir: dir }),
        (err) => {
          assert.ok(err instanceof CameraCaptureError);
          assert.equal(err.code, "invalid-output");
          return true;
        },
      );
    });
  });

  it("does not append an audit line on failure", async () => {
    await withTempDir("p9-cam-fail-audit", async (dir) => {
      const auditFile = join(dir, "audit.ndjson");
      const audit = new AuditLog(auditFile);
      const bridge = makeBridge(async () => {
        throw new CameraCaptureError(
          "device-unavailable",
          "no camera matched",
        );
      });

      await assert.rejects(() =>
        captureCameraFrame({ bridge, outputDir: dir, audit }),
      );
      assert.equal(
        existsSync(auditFile),
        false,
        "no audit file should be created for a failed capture",
      );
    });
  });
});
