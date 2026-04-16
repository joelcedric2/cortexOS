/**
 * Perception kill-switch — the single funnel through which every "stop
 * watching my screen NOW" signal flows.
 *
 * Sources (ordered by latency + user-trust-cost):
 *   1. `"hotkey"`      — ⌘⇧Esc global shortcut (GlobalHotkey callback)
 *   2. `"voice"`       — spoken "stop" routed via the intent extractor
 *   3. `"programmatic"` — orchestrator / tests firing directly
 *
 * On trigger, the switch performs these effects in order:
 *
 *   1. `capturer.forceOff()`       — stops the capture loop, purges ring
 *                                    buffer + on-disk PNGs (Coder 1 Phase 8)
 *   2. `paneOrnaments?.clearAll()` — wipes agent-pane borders so the user
 *                                    gets a visible signal everything is off
 *   3. `bus.emit({kind: 'error',
 *        payload: {where: 'perception.kill', source}, ts})` —
 *                                    surfaces in the event-stream UI as high-
 *                                    urgency
 *   4. `audit.append({action: 'perception_killed',
 *        detail: 'source=<source>', ts})` —
 *                                    one NDJSON line per firing
 *
 * Invariants:
 *   - Idempotent: firing a second time is a no-op (no duplicate log lines,
 *     no double emits). The switch latches as fired until a fresh instance
 *     is created.
 *   - Never throws. Individual side-effects are best-effort; a failure in
 *     one (e.g. ornaments backend missing) must not block the rest.
 *   - `arm()` wires the hotkey's onPress to trigger("hotkey"). `disarm()`
 *     unregisters it. Both idempotent.
 *
 * This file intentionally touches ONLY the public surface of the injected
 * collaborators — no private fields of ScreenCapturer or PaneOrnamentManager
 * are reached into.
 */

import { GlobalHotkey } from "../voice/hotkey.js";
import type { ScreenCapturer } from "./screen-capture.js";
import type { PaneOrnamentManager } from "../window-manager/pane-ornaments.js";
import type { AuditLog } from "../proactivity/audit.js";
import type { EventBus } from "../ipc/event-bus.js";

/** Where a kill came from — recorded in audit + event payload. */
export type KillSwitchSource = "hotkey" | "voice" | "programmatic";

export interface KillSwitchOptions {
  /**
   * Optional hotkey. If provided, `arm()` installs a press handler that
   * fires `trigger("hotkey")`. When omitted, the kill-switch still works
   * but only via `trigger()` or wired voice intents.
   */
  hotkey?: GlobalHotkey;
  /** The capturer whose `forceOff()` is the first + most important effect. */
  capturer: ScreenCapturer;
  /** Optional. `clearAll()` is called so the user visibly loses all borders. */
  paneOrnaments?: PaneOrnamentManager;
  /** Optional. Event emitted so the UI flashes "perception off". */
  bus?: EventBus;
  /** Optional. One NDJSON line appended per firing. */
  audit?: AuditLog;
  /**
   * Override clock, only used for tests to assert timestamps without drift.
   */
  clock?: () => Date;
  /**
   * Hotkey combo. Default `"cmd+shift+escape"`. When the caller passes a
   * pre-constructed `hotkey`, its combo wins (we don't rebind it).
   */
  combo?: string;
}

const DEFAULT_COMBO = "cmd+shift+escape";

export class PerceptionKillSwitch {
  private readonly capturer: ScreenCapturer;
  private readonly paneOrnaments: PaneOrnamentManager | undefined;
  private readonly bus: EventBus | undefined;
  private readonly audit: AuditLog | undefined;
  private readonly clock: () => Date;
  private readonly ownedHotkey: GlobalHotkey;
  private readonly hotkeyProvidedByCaller: boolean;

  private fired = false;
  private armed = false;

  constructor(opts: KillSwitchOptions) {
    if (!opts.capturer) {
      throw new Error("PerceptionKillSwitch: capturer is required");
    }
    this.capturer = opts.capturer;
    this.paneOrnaments = opts.paneOrnaments;
    this.bus = opts.bus;
    this.audit = opts.audit;
    this.clock = opts.clock ?? (() => new Date());

    if (opts.hotkey) {
      this.ownedHotkey = opts.hotkey;
      this.hotkeyProvidedByCaller = true;
    } else {
      // Construct a fresh hotkey bound to the documented combo. The onPress
      // is set here so `arm()` can register without further wiring.
      this.ownedHotkey = new GlobalHotkey({
        combo: opts.combo ?? DEFAULT_COMBO,
        onPress: () => {
          void this.trigger("hotkey");
        },
      });
      this.hotkeyProvidedByCaller = false;
    }
  }

  /**
   * Register the hotkey listener so presses route to `trigger("hotkey")`.
   *
   * When the caller supplied their own `GlobalHotkey`, we cannot rewrite its
   * `onPress` (the field is private). We still call `register()` so the
   * underlying listener installs. It is the caller's responsibility, in that
   * case, to have already wired the onPress to this switch's `trigger` —
   * typically via `new GlobalHotkey({ onPress: () => ks.trigger("hotkey") })`.
   *
   * Idempotent.
   */
  arm(): void {
    if (this.armed) return;
    this.ownedHotkey.register();
    this.armed = true;
  }

  /** Unregister the hotkey. Idempotent. */
  disarm(): void {
    if (!this.armed) return;
    this.ownedHotkey.unregister();
    this.armed = false;
  }

  /** True after the first `trigger()` call. Useful in tests. */
  hasFired(): boolean {
    return this.fired;
  }

  /**
   * Fire the kill-switch. Idempotent across sources — the second call is a
   * no-op so a user mashing ⌘⇧Esc twice does not double-emit. The first
   * source wins and is the one recorded in audit.
   */
  async trigger(source: KillSwitchSource): Promise<void> {
    if (this.fired) return;
    this.fired = true;

    // 1. Stop the capturer. This is the single most important effect — if
    //    everything else fails, the frames must still be purged.
    try {
      await this.capturer.forceOff();
    } catch (err) {
      this.logBestEffort("capturer.forceOff", err);
    }

    // 2. Clear agent-pane ornaments so the user sees the kill visually.
    if (this.paneOrnaments) {
      try {
        await this.paneOrnaments.clearAll();
      } catch (err) {
        this.logBestEffort("paneOrnaments.clearAll", err);
      }
    }

    const now = this.clock();

    // 3. Emit a high-urgency bus event (shape: error + structured payload).
    if (this.bus) {
      try {
        this.bus.emit({
          kind: "error",
          payload: { where: "perception.kill", source },
          ts: now,
        });
      } catch (err) {
        this.logBestEffort("bus.emit", err);
      }
    }

    // 4. Audit line.
    if (this.audit) {
      try {
        this.audit.append({
          action: "perception_killed",
          detail: `source=${source}`,
          ts: now,
        });
      } catch (err) {
        this.logBestEffort("audit.append", err);
      }
    }
  }

  /** True if the kill-switch controls its own hotkey instance (no-callback-swap case). */
  ownsHotkey(): boolean {
    return !this.hotkeyProvidedByCaller;
  }

  /** Access the underlying hotkey (tests + wiring diagnostics). */
  getHotkey(): GlobalHotkey {
    return this.ownedHotkey;
  }

  private logBestEffort(label: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[perception-kill-switch] ${label} failed: ${msg}`);
  }
}
