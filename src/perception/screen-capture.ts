/**
 * Phase 8 + 8.5 — screen-capture loop with adaptive rate + daily budget.
 *
 * Owns the periodic ScreenCaptureKit sampling, the bounded in-memory ring
 * buffer, on-disk PNG store, private-app allowlist, perceptual-hash dedup,
 * and the 24 h disk-bytes budget gate.
 *
 * Privacy invariants (plan §7): starts disabled; `forceOff()` is the
 * ⌘⇧Esc kill-switch; frames never leave this module; private-app bundles
 * are never sampled. See `docs/phase-8.5/DECISIONS.md` for tuning notes.
 */
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent, EventBus } from "../ipc/event-bus.js";
import type { ScreenMemoriesStore } from "./screen-memories-db.js";
import {
  createNativeBridge,
  type NativeCaptureResult,
  type VisionBridge,
} from "./native-bridge.js";
import {
  computePhash,
  isDuplicate as phashIsDuplicate,
  type PhashDecoder,
} from "./phash.js";

/** Plan §7.0 — every numeric knob is options-tunable. No inline literals below. */
export const CAPTURE_DEFAULTS = {
  START_FPS: 1.0,
  MIN_FPS: 0.25,
  MAX_FPS: 5.0,
  RING_BUFFER_SIZE: 60,
  DEDUP_WINDOW_SEC: 60,
  DEDUP_WINDOW_MIN_SAMPLES: 6,
  DEDUP_RATE_UPSCALE_HI: 0.8, // > this → halve fps
  DEDUP_RATE_DOWNSCALE_LO: 0.4, // < this → double fps
  DEDUP_MAX_HAMMING: 4,
  /** 400 MB (decimal) — matches the Phase 8.5 spec ("400 MB"). */
  CAPTURE_BUDGET_DAILY_BYTES: 400 * 1_000_000,
  BUDGET_WINDOW_MS: 24 * 60 * 60 * 1000,
} as const;

export interface ScreenFrame {
  id: string;
  ts: Date;
  png_path: string;
  active_app: string | null;
  window_title: string | null;
  ocr_text?: string;
  width: number;
  height: number;
  phash?: bigint;
}

export type CaptureOutcome =
  | { ok: true; frame: ScreenFrame }
  | { ok: false; reason: "duplicate"; phash: bigint }
  | { ok: false; reason: "budget-exceeded"; bytesInWindow: number; budget: number };

export interface PendingSurface {
  add(observation: {
    sensorName: string;
    observation: string;
    urgency: number;
    data?: Record<string, unknown>;
  }): void | Promise<void>;
}

export interface ScreenCaptureOptions {
  startFps?: number;
  minFps?: number;
  maxFps?: number;
  ringBufferSize?: number;
  storageDir?: string;
  privateAppAllowlist?: string[];
  dedupWindowSec?: number;
  dedupRateUpscaleHi?: number;
  dedupRateDownscaleLo?: number;
  dedupMaxHamming?: number;
  captureBudgetDailyBytes?: number;
  db?: ScreenMemoriesStore;
  bus?: EventBus;
  pendingSurface?: PendingSurface;
  phashDecoder?: PhashDecoder;
  bridge?: VisionBridge;
  scheduler?: CaptureScheduler;
  now?: () => number;
}

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
          /* tick logs internally */
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

interface DedupSample {
  t: number;
  duplicate: boolean;
}

/** Opt-in periodic screen sampler with adaptive fps + budget gate. */
export class ScreenCapturer {
  private readonly minFps: number;
  private readonly maxFps: number;
  private readonly ringBufferSize: number;
  private readonly storageDir: string;
  private readonly privateApps: Set<string>;
  private readonly bridge: VisionBridge;
  private readonly scheduler: CaptureScheduler;
  private readonly dedupWindowMs: number;
  private readonly dedupRateUpscaleHi: number;
  private readonly dedupRateDownscaleLo: number;
  private readonly dedupMaxHamming: number;
  private readonly captureBudgetDailyBytes: number;
  private readonly budgetWindowMs = CAPTURE_DEFAULTS.BUDGET_WINDOW_MS;
  private readonly db: ScreenMemoriesStore | null;
  private readonly bus: EventBus | null;
  private readonly pendingSurface: PendingSurface | null;
  private readonly phashDecoder: PhashDecoder | undefined;
  private readonly now: () => number;

  private currentFps: number;
  private frames: ScreenFrame[] = [];
  private dedupWindow: DedupSample[] = [];
  private lastPhash: bigint | null = null;
  private running = false;
  private storageReady = false;
  private forced = false;

  constructor(opts: ScreenCaptureOptions = {}) {
    this.minFps = opts.minFps ?? CAPTURE_DEFAULTS.MIN_FPS;
    this.maxFps = opts.maxFps ?? CAPTURE_DEFAULTS.MAX_FPS;
    if (this.minFps <= 0) throw new Error("ScreenCapturer: minFps must be > 0");
    if (this.maxFps < this.minFps) {
      throw new Error("ScreenCapturer: maxFps must be >= minFps");
    }
    this.currentFps = clamp(
      opts.startFps ?? CAPTURE_DEFAULTS.START_FPS,
      this.minFps,
      this.maxFps,
    );

    this.ringBufferSize = opts.ringBufferSize ?? CAPTURE_DEFAULTS.RING_BUFFER_SIZE;
    if (this.ringBufferSize < 1) {
      throw new Error("ScreenCapturer: ringBufferSize must be >= 1");
    }
    this.storageDir = opts.storageDir ?? defaultStorageDir();
    this.privateApps = new Set(opts.privateAppAllowlist ?? DEFAULT_PRIVATE_APPS);
    this.bridge = opts.bridge ?? createNativeBridge();
    this.scheduler = opts.scheduler ?? defaultScheduler();

    this.dedupWindowMs =
      (opts.dedupWindowSec ?? CAPTURE_DEFAULTS.DEDUP_WINDOW_SEC) * 1000;
    this.dedupRateUpscaleHi =
      opts.dedupRateUpscaleHi ?? CAPTURE_DEFAULTS.DEDUP_RATE_UPSCALE_HI;
    this.dedupRateDownscaleLo =
      opts.dedupRateDownscaleLo ?? CAPTURE_DEFAULTS.DEDUP_RATE_DOWNSCALE_LO;
    if (this.dedupRateUpscaleHi <= this.dedupRateDownscaleLo) {
      throw new Error(
        "ScreenCapturer: dedupRateUpscaleHi must be > dedupRateDownscaleLo",
      );
    }
    this.dedupMaxHamming = opts.dedupMaxHamming ?? CAPTURE_DEFAULTS.DEDUP_MAX_HAMMING;
    this.captureBudgetDailyBytes =
      opts.captureBudgetDailyBytes ?? CAPTURE_DEFAULTS.CAPTURE_BUDGET_DAILY_BYTES;

    this.db = opts.db ?? null;
    this.bus = opts.bus ?? null;
    this.pendingSurface = opts.pendingSurface ?? null;
    this.phashDecoder = opts.phashDecoder;
    this.now = opts.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    this.assertLive();
    if (this.running) return;
    await this.ensureStorage();
    this.running = true;
    this.scheduler.start(this.intervalMs(), () => this.tick());
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.scheduler.stop();
  }

  async captureNow(): Promise<CaptureOutcome> {
    this.assertLive();
    await this.ensureStorage();
    return await this.doCapture();
  }

  getRecent(n?: number): ScreenFrame[] {
    const count = n === undefined ? this.frames.length : Math.max(0, n);
    return this.frames.slice(-count).slice().reverse();
  }

  async purge(olderThanSec?: number): Promise<number> {
    let drop: ScreenFrame[];
    let keep: ScreenFrame[];
    if (olderThanSec === undefined) {
      drop = this.frames;
      keep = [];
    } else {
      const cutoff = this.now() - olderThanSec * 1000;
      drop = this.frames.filter((f) => f.ts.getTime() < cutoff);
      keep = this.frames.filter((f) => f.ts.getTime() >= cutoff);
    }
    this.frames = keep;
    for (const f of drop) await tryUnlink(f.png_path);
    return drop.length;
  }

  isRunning(): boolean { return this.running; }
  currentIntervalMs(): number { return this.intervalMs(); }
  getCurrentFps(): number { return this.currentFps; }

  /** Kill-switch: stop + wipe + latch. */
  async forceOff(): Promise<void> {
    this.forced = true;
    await this.stop();
    await this.purge();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private assertLive(): void {
    if (this.forced) {
      throw new Error(
        "ScreenCapturer: kill-switch active. Create a new instance.",
      );
    }
  }

  private intervalMs(): number {
    return Math.max(1, Math.round(1000 / this.currentFps));
  }

  private async ensureStorage(): Promise<void> {
    if (this.storageReady) return;
    await mkdir(this.storageDir, { recursive: true });
    this.storageReady = true;
  }

  private async tick(): Promise<void> {
    if (!this.running || this.forced) return;
    const fpsBefore = this.currentFps;
    try {
      await this.doCapture();
    } catch (err) {
      if (err instanceof PrivateAppSkippedError) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[screen-capture] tick failed: ${msg}`);
    } finally {
      this.maybeAdaptFps(fpsBefore);
    }
  }

  private async doCapture(): Promise<CaptureOutcome> {
    const id = randomUUID();
    const pngPath = join(this.storageDir, `${id}.png`);
    const raw = await this.bridge.capture({ outPath: pngPath });

    if (this.isPrivateBundle(raw.active_bundle)) {
      await tryUnlink(pngPath);
      throw new PrivateAppSkippedError(raw.active_bundle);
    }

    if (this.db) {
      const since = new Date(this.now() - this.budgetWindowMs);
      const used = this.db.bytesInWindow(since);
      if (used >= this.captureBudgetDailyBytes) {
        await tryUnlink(pngPath);
        await this.surfaceBudgetExceeded(used);
        return {
          ok: false,
          reason: "budget-exceeded",
          bytesInWindow: used,
          budget: this.captureBudgetDailyBytes,
        };
      }
    }

    const phash = await this.tryPhash(pngPath);
    if (
      phash !== null &&
      this.lastPhash !== null &&
      phashIsDuplicate(this.lastPhash, phash, this.dedupMaxHamming)
    ) {
      await tryUnlink(pngPath);
      this.recordDedup(true);
      return { ok: false, reason: "duplicate", phash };
    }
    if (phash !== null) this.lastPhash = phash;
    this.recordDedup(false);

    const frame = toFrame(id, pngPath, raw, phash ?? undefined);
    this.frames.push(frame);
    await this.evictOverflow();

    if (this.db && phash !== null) {
      try {
        this.db.insert({
          id: frame.id,
          captured_at: frame.ts,
          webp_path: null,
          phash,
          active_app: frame.active_app,
          window_title: frame.window_title,
          ocr_text_zstd: null,
          label: null,
          embedding: Buffer.alloc(0),
          task_id: null,
          session_id: null,
          bytes: 0,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[screen-capture] db.insert failed: ${msg}`);
      }
    }

    return { ok: true, frame };
  }

  private async tryPhash(pngPath: string): Promise<bigint | null> {
    try {
      return await computePhash(pngPath, { decoder: this.phashDecoder });
    } catch {
      return null;
    }
  }

  private recordDedup(duplicate: boolean): void {
    const t = this.now();
    this.dedupWindow.push({ t, duplicate });
    const cutoff = t - this.dedupWindowMs;
    while (this.dedupWindow.length > 0 && this.dedupWindow[0]!.t < cutoff) {
      this.dedupWindow.shift();
    }
  }

  private dedupRate(): { rate: number; samples: number } {
    const samples = this.dedupWindow.length;
    if (samples === 0) return { rate: 0, samples: 0 };
    let dups = 0;
    for (const s of this.dedupWindow) if (s.duplicate) dups += 1;
    return { rate: dups / samples, samples };
  }

  private maybeAdaptFps(fpsBefore: number): void {
    const { rate, samples } = this.dedupRate();
    if (samples < CAPTURE_DEFAULTS.DEDUP_WINDOW_MIN_SAMPLES) return;

    let next = this.currentFps;
    if (rate > this.dedupRateUpscaleHi) {
      next = Math.max(this.minFps, this.currentFps / 2);
    } else if (rate < this.dedupRateDownscaleLo) {
      next = Math.min(this.maxFps, this.currentFps * 2);
    }

    if (next !== fpsBefore) {
      this.currentFps = next;
      if (this.running) {
        this.scheduler.stop();
        this.scheduler.start(this.intervalMs(), () => this.tick());
      }
    }
  }

  private async surfaceBudgetExceeded(used: number): Promise<void> {
    const data = { bytes_in_window: used, budget: this.captureBudgetDailyBytes };
    const ev: AgentEvent = {
      kind: "error",
      payload: { where: "capture.budget", ...data },
      ts: new Date(this.now()),
    };
    try { this.bus?.emit(ev); } catch (err) { warnOp("bus.emit", err); }
    if (!this.pendingSurface) return;
    try {
      await this.pendingSurface.add({
        sensorName: "screen-capture",
        observation:
          "Nchinda hit its screen-capture budget for today. Raise the limit or clear old frames?",
        urgency: 0.6,
        data,
      });
    } catch (err) { warnOp("pendingSurface.add", err); }
  }

  private isPrivateBundle(bundle: string | null | undefined): boolean {
    return bundle ? this.privateApps.has(bundle) : false;
  }

  private async evictOverflow(): Promise<void> {
    while (this.frames.length > this.ringBufferSize) {
      const removed = this.frames.shift();
      if (removed) await tryUnlink(removed.png_path);
    }
  }
}

function warnOp(op: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[screen-capture] ${op} failed: ${msg}`);
}

export class PrivateAppSkippedError extends Error {
  constructor(public readonly bundleId: string) {
    super(`capture skipped: ${bundleId} is on the private-app allowlist`);
    this.name = "PrivateAppSkippedError";
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toFrame(
  id: string,
  pngPath: string,
  raw: NativeCaptureResult,
  phash?: bigint,
): ScreenFrame {
  return {
    id,
    ts: new Date(raw.ts || Date.now()),
    png_path: pngPath,
    active_app: raw.active_app || null,
    window_title: raw.window_title || null,
    width: raw.width,
    height: raw.height,
    phash,
  };
}

async function tryUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[screen-capture] unlink ${p} failed: ${msg}`);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function ephemeralStorageDir(): string {
  return join(tmpdir(), `cortexos-screens-${randomUUID()}`);
}
