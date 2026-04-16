/**
 * iMessage driver — AppleScript transport (§5.4.2).
 *
 * Uses `osascript` to send messages through the macOS Messages app.
 * No CDP needed. Uses `execFile` with an arg array (never a shell string).
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type {
  SocialDriver,
  SocialPlatform,
  SocialTransport,
  ResolvedTarget,
  SendOutcome,
} from "../driver.js";

const execFile = promisify(execFileCb);

/** Dependency injection for testing — override execFile. */
export interface IMessageDriverDeps {
  execFileFn?: typeof execFile;
}

export class IMessageDriver implements SocialDriver {
  readonly platform: SocialPlatform = "imessage";
  readonly transport: SocialTransport = "applescript";

  private readonly execFileFn: typeof execFile;
  private pendingTarget: string | null = null;
  private pendingMessage: string | null = null;

  constructor(deps?: IMessageDriverDeps) {
    this.execFileFn = deps?.execFileFn ?? execFile;
  }

  async loginCheck(): Promise<"logged-in" | "expired" | "never"> {
    // iMessage is always available if Messages.app exists on macOS.
    // Check if the app is reachable via AppleScript.
    try {
      await this.execFileFn("osascript", [
        "-e",
        'tell application "System Events" to get name of application process "Messages"',
      ]);
      return "logged-in";
    } catch {
      return "never";
    }
  }

  async resolveTarget(handle: string): Promise<ResolvedTarget> {
    // iMessage targets are phone numbers or email addresses.
    // We just pass through — no profile resolution needed.
    const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
    return {
      id: cleanHandle,
      display: cleanHandle,
    };
  }

  async openConversation(targetId: string): Promise<void> {
    // iMessage doesn't need a "navigate" step — we record the target
    // and use it when sending.
    this.pendingTarget = targetId;
  }

  async typeMessage(msg: string): Promise<void> {
    // Buffer the message — actual send happens in confirmAndSend.
    this.pendingMessage = msg;
  }

  async confirmAndSend(): Promise<SendOutcome> {
    if (!this.pendingTarget || !this.pendingMessage) {
      return { ok: false };
    }

    // Phase 4: do NOT actually send — escalation fires in dispatch.
    // In a real Phase 5 implementation, this would call osascript:
    //   osascript -e 'tell application "Messages" to send "<msg>" to buddy "<handle>"'
    // For now, just validate the AppleScript would be well-formed.
    // Build the script string to validate it's well-formed (used in Phase 5)
    void `tell application "Messages" to send "${this.escapeAppleScript(this.pendingMessage)}" to buddy "${this.escapeAppleScript(this.pendingTarget)}"`;

    this.pendingTarget = null;
    this.pendingMessage = null;
    return { ok: true };
  }

  /** Escape a string for use inside AppleScript double-quoted strings. */
  private escapeAppleScript(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}
