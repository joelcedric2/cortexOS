/**
 * Phase 13 — Real-time Writing Coach: draft watcher.
 *
 * Spawns the Swift `cortexos-vision ax-watch --app <bundle>` helper as a
 * long-running child process, parses its NDJSON stdout, and delivers
 * {@link DraftSample} events to subscribers.
 *
 * Contract guarantees:
 *   - **No network**. This module only reads from the Swift child process.
 *   - **Safe default**: when `appsAllowList` is empty, `start()` is a no-op
 *     and the watcher stays `isRunning() === false`.
 *   - **Crash resilience**: if the Swift helper exits non-zero (or is killed
 *     by SIGSEGV etc.) while still running, we re-spawn with exponential
 *     backoff 1s → 2s → 4s → … → 30s (capped).
 *   - **Throttle**: the Swift helper enforces per-element 3s + content
 *     dedup already; we add an additional safety throttle here keyed on
 *     (app, label, value) so tests can inject stale bridges.
 *
 * Injection: tests pass a `NativeBridge` stub that implements `spawn()` —
 * see the interface below. Production uses {@link createDraftWatcherBridge}
 * which shells out to the real binary.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// ────────────────────────── Types ──────────────────────────────────────────

export interface DraftSample {
  app: string;
  role: string;
  label: string;
  value: string;
  ts: string;
}

/**
 * Minimal handle over a running Swift child. Production impl wraps
 * {@link ChildProcess}; tests inject a scripted emitter.
 */
export interface NativeBridgeHandle {
  /** Stop the child (SIGTERM). Idempotent. */
  kill(): void;
  /**
   * Attach listeners. `onLine` receives one NDJSON line at a time (no
   * trailing newline); `onExit` is invoked exactly once with the exit code.
   */
  onLine(fn: (line: string) => void): void;
  onExit(fn: (code: number | null) => void): void;
}

export interface NativeBridge {
  /** Spawn a `ax-watch --app <bundleId>` child. Throws on binary-missing. */
  spawn(bundleId: string): NativeBridgeHandle;
}

export interface DraftWatcherOptions {
  /**
   * Bundle IDs the watcher is allowed to subscribe to. Empty array (the
   * default) keeps the watcher disabled — matching the privacy spec.
   */
  appsAllowList?: string[];
  /** Safety-net throttle in ms (dedup key = app+label+value). Default 3000. */
  throttleMs?: number;
  /** Injection seam for tests. Defaults to the production Swift bridge. */
  bridge?: NativeBridge;
  /** Logger override. Defaults to a no-op (avoid leaking draft content). */
  logger?: (msg: string) => void;
  /** Override backoff schedule for tests. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

// ────────────────────────── Production bridge ──────────────────────────────

const DEFAULT_BINARY = join(homedir(), ".cortexos", "bin", "cortexos-vision");

export function createDraftWatcherBridge(binaryPath?: string): NativeBridge {
  const binary = binaryPath ?? DEFAULT_BINARY;
  return {
    spawn(bundleId: string): NativeBridgeHandle {
      const child: ChildProcess = spawn(
        binary,
        ["ax-watch", "--app", bundleId, "--text-role"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      return wrapChild(child);
    },
  };
}

function wrapChild(child: ChildProcess): NativeBridgeHandle {
  let lineHandler: ((line: string) => void) | null = null;
  let exitHandler: ((code: number | null) => void) | null = null;

  let stdoutBuffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let idx: number;
    while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (line.length > 0 && lineHandler) lineHandler(line);
    }
  });
  child.on("exit", (code) => {
    if (exitHandler) exitHandler(code);
  });
  // Drain stderr so the child doesn't block. We deliberately don't surface
  // it — Swift tags like "permission-denied" are reflected in the exit code.
  child.stderr?.on("data", () => {});

  return {
    kill() {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    },
    onLine(fn) { lineHandler = fn; },
    onExit(fn) { exitHandler = fn; },
  };
}

// ────────────────────────── DraftWatcher ──────────────────────────────────

const DEFAULT_THROTTLE_MS = 3_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

interface PerAppState {
  handle: NativeBridgeHandle;
  backoffMs: number;
  /** True once the caller asked us to stop; suppresses reconnect. */
  stopped: boolean;
  reconnectTimer?: NodeJS.Timeout;
}

export class DraftWatcher {
  private readonly allowList: string[];
  private readonly throttleMs: number;
  private readonly bridge: NativeBridge;
  private readonly logger: (msg: string) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private running = false;
  private readonly states: Map<string, PerAppState> = new Map();
  private readonly listeners: Array<(s: DraftSample) => void> = [];
  /** dedup key -> last emission ts. */
  private readonly lastEmit: Map<string, number> = new Map();

  constructor(opts: DraftWatcherOptions = {}) {
    this.allowList = Array.from(opts.appsAllowList ?? []);
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.bridge = opts.bridge ?? createDraftWatcherBridge();
    this.logger = opts.logger ?? (() => {});
    this.initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  onSample(fn: (s: DraftSample) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Default-off: empty allow-list means watcher is disabled.
    if (this.allowList.length === 0) {
      this.logger("draft-watcher: allow-list empty — staying idle");
      return;
    }
    for (const bundle of this.allowList) {
      this.spawnFor(bundle);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const [, state] of this.states) {
      state.stopped = true;
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = undefined;
      }
      state.handle.kill();
    }
    this.states.clear();
  }

  isRunning(): boolean {
    return this.running && this.states.size > 0;
  }

  // ────────────────── Internals ──────────────────

  private spawnFor(bundleId: string): void {
    // If caller restarted, make sure no stale state lingers.
    const prev = this.states.get(bundleId);
    if (prev) {
      prev.stopped = true;
      if (prev.reconnectTimer) clearTimeout(prev.reconnectTimer);
      prev.handle.kill();
    }

    let handle: NativeBridgeHandle;
    try {
      handle = this.bridge.spawn(bundleId);
    } catch (err) {
      // Binary missing or similar; schedule a retry, same backoff logic.
      this.logger(`draft-watcher: spawn failed for ${bundleId} (${errMsg(err)})`);
      this.scheduleReconnect(bundleId, this.initialBackoffMs);
      return;
    }

    const state: PerAppState = {
      handle,
      backoffMs: this.initialBackoffMs,
      stopped: false,
    };
    this.states.set(bundleId, state);

    handle.onLine((line) => this.ingestLine(bundleId, line));
    handle.onExit((code) => this.handleExit(bundleId, code));
  }

  private ingestLine(bundleId: string, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.logger(`draft-watcher: bad NDJSON from ${bundleId}`);
      return;
    }
    const sample = coerceSample(parsed);
    if (!sample) return;

    // Safety-net throttle (Swift already throttles at 3s; this catches
    // repeated identical values coming from distinct AX elements with the
    // same label, e.g. multi-compose-window apps).
    const key = `${sample.app}::${sample.label}::${sample.value}`;
    const now = Date.now();
    const last = this.lastEmit.get(key);
    if (last !== undefined && now - last < this.throttleMs) return;
    this.lastEmit.set(key, now);

    for (const fn of this.listeners) {
      try { fn(sample); } catch (err) {
        this.logger(`draft-watcher: listener threw (${errMsg(err)})`);
      }
    }
  }

  private handleExit(bundleId: string, code: number | null): void {
    const state = this.states.get(bundleId);
    if (!state) return;
    if (state.stopped || !this.running) return;

    this.logger(`draft-watcher: child for ${bundleId} exited (code=${code}); reconnecting`);
    // Exponential backoff, capped at maxBackoffMs.
    this.scheduleReconnect(bundleId, state.backoffMs);
    state.backoffMs = Math.min(state.backoffMs * 2, this.maxBackoffMs);
  }

  private scheduleReconnect(bundleId: string, delayMs: number): void {
    const existing = this.states.get(bundleId);
    if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer);
    const timer = setTimeout(() => {
      if (!this.running) return;
      this.spawnFor(bundleId);
    }, delayMs);
    // Allow Node process to exit if nothing else holds it.
    (timer as unknown as { unref?: () => void }).unref?.();
    if (existing) {
      existing.reconnectTimer = timer;
    } else {
      // No prior state yet (spawn throw path) — stash a lightweight stub.
      this.states.set(bundleId, {
        handle: { kill() {}, onLine() {}, onExit() {} },
        backoffMs: Math.min(delayMs * 2, this.maxBackoffMs),
        stopped: false,
        reconnectTimer: timer,
      });
    }
  }
}

// ────────────────────────── Helpers ────────────────────────────────────────

function coerceSample(raw: unknown): DraftSample | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.app !== "string" ||
    typeof r.role !== "string" ||
    typeof r.label !== "string" ||
    typeof r.value !== "string" ||
    typeof r.ts !== "string"
  ) {
    return null;
  }
  return { app: r.app, role: r.role, label: r.label, value: r.value, ts: r.ts };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
