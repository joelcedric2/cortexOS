/**
 * Phase 8 — screen-capture loop + ring buffer.
 *
 * Owns the periodic ScreenCaptureKit sampling, the bounded in-memory ring
 * buffer of recent frames, the on-disk PNG store (purged on eviction), and
 * the private-app allowlist that skips capture for sensitive windows.
 *
 * Privacy invariants (plan §7):
 *   1. Starts disabled. Caller must explicitly `start()`.
 *   2. `forceOff()` is the ⌘⇧Esc kill-switch — stops the loop and wipes disk.
 *   3. Frames never leave this module. No fetch / https anywhere.
 *   4. Private-app allowlist skips the tick entirely (no capture, no OCR).
 *
 * Test seam: a `VisionBridge` is injected via constructor. Tests pass a fake
 * bridge; production code calls `createNativeBridge()` in `native-bridge.ts`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNativeBridge,
  type NativeCaptureResult,
  type VisionBridge,
} from "./native-bridge.js";
import type { AuditLog } from "../proactivity/audit.js";

/** A single captured screen frame held in the ring buffer. */
export interface ScreenFrame {
  /** Stable UUID — used as cross-ref key by the vision-brief / sensor. */
  id: string;
  ts: Date;
  /** Absolute path to the on-disk PNG. Deleted when the frame is evicted. */
  png_path: string;
  active_app: string | null;
  window_title: string | null;
  /** Populated lazily by the brief pipeline (Coder 2's lane). */
  ocr_text?: string;
  width: number;
  height: number;
}

export interface ScreenCaptureOptions {
  /** Sampling interval in seconds. Default 10 (≈0.1 Hz). */
  intervalSec?: number;
  /** Max frames kept in memory + on disk. Default 60 (~10 min). */
  ringBufferSize?: number;
  /** PNG storage directory. Default ~/.cortexos/screens/. */
  storageDir?: string;
  /** Bundle ids to NEVER capture. Defaults to the standard sensitive set. */
  privateAppAllowlist?: string[];
  /**
   * Injected native bridge. Tests pass a fake. Production omits this and
   * `createNativeBridge()` is used.
   */
  bridge?: VisionBridge;
  /** Override the timer for deterministic tests. */
  scheduler?: CaptureScheduler;
  /**
   * Optional audit log. When provided, every successful capture AND every
   * private-app / error skip appends one NDJSON line via
   * `audit.append({action: 'capture', detail, ts})`. Phase 8.5 wiring.
   */
  audit?: AuditLog;
}

/** Minimal scheduler contract — tests swap this for a manual driver. */
export interface CaptureScheduler {
  start(intervalMs: number, tick: () => Promise<void> | void): void;
  stop(): void;
}

/** Default private-app allowlist — never sampled (plan §7.7). */
export const DEFAULT_PRIVATE_APPS: readonly string[] = Object.freeze([
  "com.agilebits.onepassword7",
  "com.apple.Safari.bank",
  "com.1password.1password",
  "com.apple.Keychain",
]);

function defaultScheduler(): CaptureScheduler {
  let handle: NodeJS.Timeout | null = null;
  return {
    start(intervalMs, tick) {
      handle = setInterval(() => {
        void Promise.resolve(tick()).catch(() => {
          /* swallow — tick logs internally */
        });
      }, intervalMs);
      if (typeof handle.unref === "function") handle.unref();
    },
    stop() {
      if (handle) clearInterval(handle);
      handle = null;
    },
  };
}

function defaultStorageDir(): string {
  return join(homedir(), ".cortexos", "screens");
}

/**
 * ScreenCapturer — opt-in periodic screen sampler with ring-buffer GC.
 *
 * The class owns no mutable global state. Multiple instances are safe.
 */
export class ScreenCapturer {
  private readonly intervalSec: number;
  private readonly ringBufferSize: number;
  private readonly storageDir: string;
  private readonly privateApps: Set<string>;
  private readonly bridge: VisionBridge;
  private readonly scheduler: CaptureScheduler;
  private readonly audit: AuditLog | undefined;

  private frames: ScreenFrame[] = [];
  private running = false;
  private storageReady = false;
  private forced = false;

  constructor(opts: ScreenCaptureOptions = {}) {
    this.intervalSec = opts.intervalSec ?? 10;
    if (this.intervalSec <= 0) {
      throw new Error("ScreenCapturer: intervalSec must be positive");
    }
    this.ringBufferSize = opts.ringBufferSize ?? 60;
    if (this.ringBufferSize < 1) {
      throw new Error("ScreenCapturer: ringBufferSize must be >= 1");
    }
    this.storageDir = opts.storageDir ?? defaultStorageDir();
    this.privateApps = new Set(opts.privateAppAllowlist ?? DEFAULT_PRIVATE_APPS);
    this.bridge = opts.bridge ?? createNativeBridge();
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.audit = opts.audit;
  }

  /** Begin the capture loop. Idempotent — a second call is a no-op. */
  async start(): Promise<void> {
    if (this.forced) {
      throw new Error("ScreenCapturer: kill-switch active. Create a new instance.");
    }
    if (this.running) return;
    await this.ensureStorage();
    this.running = true;
    this.scheduler.start(this.intervalSec * 1000, () => this.tick());
  }

  /** Stop the capture loop. Idempotent. Does not delete on-disk frames. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.scheduler.stop();
  }

  /**
   * Capture a single frame right now. Works even when the loop is disabled,
   * as required by the spec (used by the `nchinda_see` MCP tool).
   *
   * Respects the private-app allowlist — if the active app is sensitive the
   * method throws `PrivateAppSkippedError` so callers can decide what to do.
   */
  async captureNow(): Promise<ScreenFrame> {
    if (this.forced) {
      throw new Error("ScreenCapturer: kill-switch active. Create a new instance.");
    }
    await this.ensureStorage();
    return await this.doCapture();
  }

  /** Most-recent frame first. */
  getRecent(n?: number): ScreenFrame[] {
    const count = n === undefined ? this.frames.length : Math.max(0, n);
    const slice = this.frames.slice(-count);
    return slice.slice().reverse();
  }

  /**
   * Delete frames older than `olderThanSec`. Returns the number removed.
   * When called with no arg, purges ALL frames (used by the kill-switch).
   */
  async purge(olderThanSec?: number): Promise<number> {
    let keep: ScreenFrame[];
    let drop: ScreenFrame[];
    if (olderThanSec === undefined) {
      drop = this.frames;
      keep = [];
    } else {
      const cutoff = Date.now() - olderThanSec * 1000;
      drop = this.frames.filter((f) => f.ts.getTime() < cutoff);
      keep = this.frames.filter((f) => f.ts.getTime() >= cutoff);
    }
    this.frames = keep;
    for (const f of drop) await tryUnlink(f.png_path);
    return drop.length;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Global kill-switch. Stops the loop, purges all in-memory + on-disk frames,
   * and latches the instance so further start()/captureNow() calls throw.
   */
  async forceOff(): Promise<void> {
    this.forced = true;
    await this.stop();
    await this.purge();
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async ensureStorage(): Promise<void> {
    if (this.storageReady) return;
    await mkdir(this.storageDir, { recursive: true });
    this.storageReady = true;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.forced) return;
    try {
      await this.doCapture();
    } catch (err) {
      // Private-app skips are expected — count them without noise.
      if (err instanceof PrivateAppSkippedError) {
        this.recordAudit(`skip=private_app bundle=${err.bundleId}`);
        return;
      }
      // Anything else: log once. The loop keeps running; next tick may succeed.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[screen-capture] tick failed: ${msg}`);
      this.recordAudit(`error=${redactErr(msg)}`);
    }
  }

  private async doCapture(): Promise<ScreenFrame> {
    const id = randomUUID();
    const pngPath = join(this.storageDir, `${id}.png`);
    const raw = await this.bridge.capture({ outPath: pngPath });

    if (this.isPrivateBundle(raw.active_bundle)) {
      // Skip — remove anything the helper may have written.
      await tryUnlink(pngPath);
      throw new PrivateAppSkippedError(raw.active_bundle);
    }

    const frame = toFrame(id, pngPath, raw);
    this.frames.push(frame);
    await this.evictOverflow();
    this.recordAudit(`app=${frame.active_app ?? "unknown"}`);
    return frame;
  }

  /**
   * Append an audit line for a capture-related side-effect. No-op when no
   * AuditLog was injected. Never throws — audit is best-effort; a broken
   * sink must not bring down the capture loop.
   */
  private recordAudit(detail: string): void {
    if (!this.audit) return;
    try {
      this.audit.append({
        action: "capture",
        detail,
        ts: new Date(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[screen-capture] audit append failed: ${msg}`);
    }
  }

  private isPrivateBundle(bundle: string | null | undefined): boolean {
    if (!bundle) return false;
    return this.privateApps.has(bundle);
  }

  private async evictOverflow(): Promise<void> {
    while (this.frames.length > this.ringBufferSize) {
      const removed = this.frames.shift();
      if (removed) await tryUnlink(removed.png_path);
    }
  }
}

/** Raised when the active app is on the private allowlist. */
export class PrivateAppSkippedError extends Error {
  constructor(public readonly bundleId: string) {
    super(`capture skipped: ${bundleId} is on the private-app allowlist`);
    this.name = "PrivateAppSkippedError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function toFrame(id: string, pngPath: string, raw: NativeCaptureResult): ScreenFrame {
  return {
    id,
    ts: new Date(raw.ts || Date.now()),
    png_path: pngPath,
    active_app: raw.active_app || null,
    window_title: raw.window_title || null,
    width: raw.width,
    height: raw.height,
  };
}

async function tryUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // Surface non-ENOENT failures so a leaky disk shows up in logs.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[screen-capture] unlink ${p} failed: ${msg}`);
  }
}

/** Convenience: a default storage dir under tmp for throwaway instances. */
export function ephemeralStorageDir(): string {
  return join(tmpdir(), `cortexos-screens-${randomUUID()}`);
}

/**
 * Reduce a raw error message to a short, stable label before it enters the
 * audit log. The audit file is readable by the user, so we avoid leaking
 * full stack traces / URLs / API keys. Pattern mirrors vision-brief's
 * redactReason() so audits stay consistent.
 */
function redactErr(msg: string): string {
  if (/timeout|abort|deadline/i.test(msg)) return "timeout";
  if (/permission/i.test(msg)) return "permission-denied";
  if (/enoent|not found/i.test(msg)) return "not-found";
  if (/network|econn|enotfound|fetch/i.test(msg)) return "network";
  return "unknown";
}
