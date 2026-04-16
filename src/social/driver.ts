/**
 * Social Operator Layer — driver abstraction (NCHINDA_PLAN §5.4.1).
 *
 * Every social platform implements this interface. The dispatch layer
 * (dispatch.ts) picks the right driver from the registry, runs the
 * universal flow (§5.4.3), and enforces safety rails (§5.4.5).
 */

export type SocialPlatform =
  | "ig"
  | "x"
  | "linkedin"
  | "reddit"
  | "tiktok"
  | "discord"
  | "telegram"
  | "whatsapp"
  | "imessage";

export type SocialTransport = "api" | "cdp" | "native-app" | "applescript";

export interface ResolvedTarget {
  id: string;
  display: string;
  avatar?: string;
}

export interface SendOutcome {
  ok: boolean;
  messageId?: string;
}

export interface SocialDriver {
  readonly platform: SocialPlatform;
  readonly transport: SocialTransport;

  /** Check whether the user is logged in on this platform. */
  loginCheck(): Promise<"logged-in" | "expired" | "never">;

  /** Resolve a handle / display name to a platform-specific target. */
  resolveTarget(handle: string): Promise<ResolvedTarget>;

  /** Open (or navigate to) the DM / conversation with the target. */
  openConversation(targetId: string): Promise<void>;

  /** Type a message into the input field — do NOT submit. */
  typeMessage(msg: string): Promise<void>;

  /**
   * Confirm and send the message.
   *
   * In Phase 4 this always fires an escalation event on the bus
   * and returns `{ok: true}` with `confirmationRequired: true` in
   * the dispatch result. Actual click-to-send is Phase 5.
   */
  confirmAndSend(): Promise<SendOutcome>;
}

/**
 * Error thrown by stub drivers that are not yet implemented.
 * Phase 5 or the skill-loader will provide the real driver.
 */
export class DriverNotImplemented extends Error {
  constructor(platform: SocialPlatform) {
    super(`Social driver for "${platform}" is not yet implemented`);
    this.name = "DriverNotImplemented";
  }
}
