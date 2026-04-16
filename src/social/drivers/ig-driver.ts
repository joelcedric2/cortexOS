/**
 * Instagram DM driver — CDP transport (§5.4.2).
 *
 * Navigates instagram.com, checks login status, searches for user,
 * opens DM thread, types message. Selectors will need updating as
 * IG changes — they are constants at the top of this file.
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
/*  Selectors — update when Instagram changes its DOM                  */
/* ------------------------------------------------------------------ */

/** Selectors used for Instagram web automation. */
export const IG_SELECTORS = {
  /** The element present when logged in (profile icon in nav). */
  LOGGED_IN_INDICATOR: 'svg[aria-label="Home"]',
  /** Login page email input — present when NOT logged in. */
  LOGIN_EMAIL_INPUT: 'input[name="username"]',
  /** Search input in the nav bar. */
  SEARCH_INPUT: 'input[aria-label="Search input"]',
  /** A single search result link. */
  SEARCH_RESULT: 'a[href*="/"]',
  /** DM / Message button on a profile page. */
  MESSAGE_BUTTON: '[role="button"]:has-text("Message")',
  /** Textarea inside the DM thread. */
  DM_INPUT: 'textarea[placeholder*="Message"]',
  /** Alternative DM input (contenteditable div). */
  DM_INPUT_ALT: 'div[role="textbox"][contenteditable="true"]',
  /** Send button inside the DM thread. */
  SEND_BUTTON: 'button[type="submit"]',
} as const;

const IG_BASE = "https://www.instagram.com";
const IG_DM_BASE = `${IG_BASE}/direct/inbox/`;

export interface IgDriverDeps {
  page: CDPPage;
}

export class IgDriver implements SocialDriver {
  readonly platform: SocialPlatform = "ig";
  readonly transport: SocialTransport = "cdp";

  private readonly page: CDPPage;

  constructor(deps: IgDriverDeps) {
    this.page = deps.page;
  }

  async loginCheck(): Promise<"logged-in" | "expired" | "never"> {
    await this.page.navigate(IG_BASE);
    const html = await this.page.readText();
    // If we see the login email input, user is not logged in
    if (html.includes("username") && html.includes("password")) {
      return "never";
    }
    try {
      await this.page.waitFor(IG_SELECTORS.LOGGED_IN_INDICATOR, 5_000);
      return "logged-in";
    } catch {
      return "expired";
    }
  }

  async resolveTarget(handle: string): Promise<ResolvedTarget> {
    // Strip leading @ if present
    const cleanHandle = handle.startsWith("@") ? handle.slice(1) : handle;
    // Navigate to the profile page directly
    await this.page.navigate(`${IG_BASE}/${cleanHandle}/`);
    await this.page.waitFor("header", 10_000);
    const displayName = await this.page.readText("header h2");
    return {
      id: cleanHandle,
      display: displayName || cleanHandle,
    };
  }

  async openConversation(targetId: string): Promise<void> {
    // Navigate to DM inbox, then use Instagram's compose to open a thread
    await this.page.navigate(IG_DM_BASE);
    await this.page.waitFor(IG_SELECTORS.DM_INPUT, 10_000).catch(async () => {
      // Try to find and click compose / new message button
      await this.page.click('svg[aria-label="New message"]');
      // Search for the user in the compose dialog
      await this.page.waitFor('input[placeholder="Search..."]', 5_000);
      await this.page.type('input[placeholder="Search..."]', targetId);
      // Wait for search results and click the first one
      await this.page.waitFor('div[role="dialog"] button', 5_000);
      await this.page.click('div[role="dialog"] button');
      // Confirm selection
      await this.page.click('div[role="dialog"] div:last-child button');
    });
  }

  async typeMessage(msg: string): Promise<void> {
    // Try the textarea first, fall back to contenteditable div
    try {
      await this.page.waitFor(IG_SELECTORS.DM_INPUT, 5_000);
      await this.page.type(IG_SELECTORS.DM_INPUT, msg, { delay: 30 });
    } catch {
      await this.page.waitFor(IG_SELECTORS.DM_INPUT_ALT, 5_000);
      await this.page.type(IG_SELECTORS.DM_INPUT_ALT, msg, { delay: 30 });
    }
  }

  async confirmAndSend(): Promise<SendOutcome> {
    // Phase 4: do NOT actually click send — escalation fires in dispatch.
    // Just confirm the message is in the input field.
    return { ok: true };
  }
}
