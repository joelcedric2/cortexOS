/**
 * X (Twitter) DM driver — CDP transport (§5.4.2).
 *
 * Navigates x.com, checks login status, resolves user profile, opens
 * DM thread, types message. Selectors at top of file for easy updating.
 */

import type { CDPPage } from "../../browser/_cdp-stub.js";
import type {
  SocialDriver,
  SocialPlatform,
  SocialTransport,
  ResolvedTarget,
  SendOutcome,
} from "../driver.js";

/* ------------------------------------------------------------------ */
/*  Selectors — update when X/Twitter changes its DOM                  */
/* ------------------------------------------------------------------ */

export const X_SELECTORS = {
  /** Element present when logged in (nav link to Home). */
  LOGGED_IN_INDICATOR: 'a[data-testid="AppTabBar_Home_Link"]',
  /** Login page input. */
  LOGIN_INPUT: 'input[autocomplete="username"]',
  /** User profile name heading. */
  PROFILE_NAME: 'div[data-testid="UserName"]',
  /** DM compose text input area. */
  DM_INPUT: 'div[data-testid="dmComposerTextInput"]',
  /** Alternative DM input. */
  DM_INPUT_ALT: 'div[role="textbox"][data-testid="tweetTextarea_0"]',
  /** Send DM button. */
  SEND_BUTTON: 'button[data-testid="dmComposerSendButton"]',
  /** Message button on profile page. */
  MESSAGE_BUTTON: 'div[data-testid="sendDMFromProfile"]',
} as const;

const X_BASE = "https://x.com";

export interface XDriverDeps {
  page: CDPPage;
}

export class XDriver implements SocialDriver {
  readonly platform: SocialPlatform = "x";
  readonly transport: SocialTransport = "cdp";

  private readonly page: CDPPage;

  constructor(deps: XDriverDeps) {
    this.page = deps.page;
  }

  async loginCheck(): Promise<"logged-in" | "expired" | "never"> {
    await this.page.navigate(X_BASE);
    const html = await this.page.readText();
    if (html.includes("Sign in") && html.includes("Create account")) {
      return "never";
    }
    try {
      await this.page.waitFor(X_SELECTORS.LOGGED_IN_INDICATOR, 5_000);
      return "logged-in";
    } catch {
      return "expired";
    }
  }

  async resolveTarget(handle: string): Promise<ResolvedTarget> {
    const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
    await this.page.navigate(`${X_BASE}/${cleanHandle}`);
    await this.page.waitFor(X_SELECTORS.PROFILE_NAME, 10_000);
    const displayName = await this.page.readText(X_SELECTORS.PROFILE_NAME);
    return {
      id: cleanHandle,
      display: displayName || cleanHandle,
    };
  }

  async openConversation(_targetId: string): Promise<void> {
    // Click the Message button on the profile page
    try {
      await this.page.waitFor(X_SELECTORS.MESSAGE_BUTTON, 5_000);
      await this.page.click(X_SELECTORS.MESSAGE_BUTTON);
    } catch {
      // Fallback: navigate to DM directly
      await this.page.navigate(`${X_BASE}/messages/compose`);
    }
    await this.page.waitFor(X_SELECTORS.DM_INPUT, 10_000);
  }

  async typeMessage(msg: string): Promise<void> {
    try {
      await this.page.waitFor(X_SELECTORS.DM_INPUT, 5_000);
      await this.page.type(X_SELECTORS.DM_INPUT, msg, { delay: 25 });
    } catch {
      await this.page.waitFor(X_SELECTORS.DM_INPUT_ALT, 5_000);
      await this.page.type(X_SELECTORS.DM_INPUT_ALT, msg, { delay: 25 });
    }
  }

  async confirmAndSend(): Promise<SendOutcome> {
    // Phase 4: do NOT actually click send — escalation fires in dispatch.
    return { ok: true };
  }
}
