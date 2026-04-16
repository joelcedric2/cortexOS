/**
 * `watch_draft` MCP tool (Phase 13 — writing coach).
 *
 * Enables or disables the draft watcher for a specific app (by bundle id)
 * or globally (no `app` argument → all apps in the configured default
 * allow-list). Default stored state is OFF — the user must explicitly
 * enable before any AX subscriptions are made.
 *
 * This handler does NOT embed the full DraftWatcher lifecycle; instead, it
 * mutates a small in-memory "coach config" object that the orchestrator is
 * expected to observe (via start/stop on {@link WatchDraftController}).
 * Tests inject a stub controller.
 */
import { z } from "zod";

// ────────────────────────── Schema ─────────────────────────────────────────

const WatchDraftInputSchema = z.object({
  enable: z.boolean(),
  app: z.string().min(1).max(256).optional(),
});
export type WatchDraftInput = z.infer<typeof WatchDraftInputSchema>;

// ────────────────────────── Controller contract ────────────────────────────

/** Minimal contract the orchestrator exposes to us. */
export interface WatchDraftController {
  /** Currently enabled app bundles. */
  enabledApps(): string[];
  /** Enable the coach for one bundle (or globally when `undefined`). */
  enable(app?: string): void;
  /** Disable the coach for one bundle (or globally). */
  disable(app?: string): void;
}

export interface WatchDraftResult {
  ok: true;
  enabled: string[];
}

export interface WatchDraftDeps {
  controller: WatchDraftController;
}

export async function watchDraft(
  raw: unknown,
  deps: WatchDraftDeps,
): Promise<WatchDraftResult> {
  const input = WatchDraftInputSchema.parse(raw ?? {});
  if (input.enable) {
    deps.controller.enable(input.app);
  } else {
    deps.controller.disable(input.app);
  }
  return { ok: true, enabled: deps.controller.enabledApps() };
}

// ────────────────────────── In-memory default controller ──────────────────

/**
 * Default controller backed by an in-memory Set. Production wires a real
 * orchestrator-aware controller that also start/stops the DraftWatcher.
 *
 * Default allow-list is EMPTY so the coach stays off until the user opts in.
 */
export class InMemoryWatchDraftController implements WatchDraftController {
  private readonly apps: Set<string> = new Set();
  /** Flag for the "global" enable (no app arg). */
  private global = false;
  private readonly defaultApps: readonly string[];

  constructor(defaultApps: readonly string[] = []) {
    this.defaultApps = defaultApps;
  }

  enabledApps(): string[] {
    if (this.global) {
      const merged = new Set<string>(this.defaultApps);
      for (const a of this.apps) merged.add(a);
      return Array.from(merged);
    }
    return Array.from(this.apps);
  }

  enable(app?: string): void {
    if (app) this.apps.add(app);
    else this.global = true;
  }

  disable(app?: string): void {
    if (app) this.apps.delete(app);
    else {
      this.global = false;
      this.apps.clear();
    }
  }
}
