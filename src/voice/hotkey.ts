/**
 * Global hotkey abstraction for voice activation fallback.
 *
 * The primary voice trigger is the wake-word detector (Agent A). This module
 * provides a keyboard shortcut fallback (default: Cmd+Shift+Space) so users
 * can activate voice input without speaking a wake phrase.
 *
 * Current implementation: programmatic stub that exposes the correct interface
 * so Phase 6 UI and tests can wire it. A native macOS CGEvent-tap or
 * node-global-key-listener backend can be swapped in later without changing
 * consumers.
 *
 * TODO: Native macOS CGEvent tap for background hotkey capture.
 */

export interface HotkeyOptions {
  /** Key combination string. Default "cmd+shift+space". */
  combo?: string;
  /** Called when the hotkey is pressed. */
  onPress: () => void;
  /** Called when the hotkey is released (optional). */
  onRelease?: () => void;
}

export class GlobalHotkey {
  private readonly combo: string;
  private readonly onPress: () => void;
  private readonly onRelease: (() => void) | undefined;
  private registered = false;

  constructor(opts: HotkeyOptions) {
    this.combo = opts.combo ?? "cmd+shift+space";
    this.onPress = opts.onPress;
    this.onRelease = opts.onRelease;
  }

  /**
   * Register the global hotkey listener.
   *
   * In the stub implementation this is a no-op that marks the hotkey as
   * registered. When a native backend is wired, this would install the
   * CGEvent tap / low-level keyboard hook.
   */
  register(): void {
    if (this.registered) return;
    this.registered = true;
    console.log(
      `[GlobalHotkey] Registered hotkey "${this.combo}" (stub — use simulatePress() for testing)`,
    );
  }

  unregister(): void {
    if (!this.registered) return;
    this.registered = false;
    console.log(`[GlobalHotkey] Unregistered hotkey "${this.combo}"`);
  }

  isRegistered(): boolean {
    return this.registered;
  }

  getCombo(): string {
    return this.combo;
  }

  /**
   * Programmatically trigger the hotkey press event.
   * Used by tests and the Phase 6 UI to fire the callback without a real
   * keyboard event.
   */
  simulatePress(): void {
    this.onPress();
  }

  /**
   * Programmatically trigger the hotkey release event.
   */
  simulateRelease(): void {
    this.onRelease?.();
  }
}
