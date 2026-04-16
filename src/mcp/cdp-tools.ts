/**
 * MCP tool handlers for Chrome DevTools Protocol browser automation.
 *
 * 6 tools per plan section 5.1:
 *   cdp_navigate   — navigate + wait for load
 *   cdp_click      — click element by CSS selector
 *   cdp_type       — type text into an input
 *   cdp_read_text  — extract visible text (default: document.body)
 *   cdp_screenshot — returns base64-encoded PNG
 *   cdp_wait_for   — wait until element exists
 *
 * Each tool validates inputs with zod. The CDPBrowser dependency is
 * injected so tests can provide a mock. A singleton CDPPage is lazily
 * created (auto-launched browser + first page) to avoid forcing the
 * caller to manage page lifecycle.
 */

import { z } from "zod";
import type { CDPBrowser, CDPPage } from "../browser/cdp.js";

// ────────────────────────── Input schemas ──────────────────────────────

const NavigateInput = z.object({
  url: z.string().url(),
});

const ClickInput = z.object({
  selector: z.string().min(1),
});

const TypeInput = z.object({
  selector: z.string().min(1),
  text: z.string(),
  delay: z.number().int().min(0).max(1000).optional(),
});

const ReadTextInput = z.object({
  selector: z.string().min(1).optional(),
});

const ScreenshotInput = z.object({
  fullPage: z.boolean().optional(),
});

const WaitForInput = z.object({
  selector: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

// ────────────────────────── Dependencies ───────────────────────────────

export interface CDPToolsDeps {
  browser: CDPBrowser;
}

// ────────────────────────── Handler class ──────────────────────────────

export class CDPTools {
  private page: CDPPage | null = null;

  constructor(private readonly deps: CDPToolsDeps) {}

  /** Lazy page accessor — launches browser and creates page on first call. */
  private async getPage(): Promise<CDPPage> {
    if (this.page) return this.page;
    const { browser } = this.deps;
    if (!browser.isConnected()) {
      await browser.launch();
    }
    this.page = await browser.newPage();
    return this.page;
  }

  async navigate(raw: unknown): Promise<{ ok: true; url: string }> {
    const { url } = NavigateInput.parse(raw);
    const page = await this.getPage();
    await page.navigate(url);
    return { ok: true, url };
  }

  async click(raw: unknown): Promise<{ ok: true; selector: string }> {
    const { selector } = ClickInput.parse(raw);
    const page = await this.getPage();
    await page.click(selector);
    return { ok: true, selector };
  }

  async type(raw: unknown): Promise<{ ok: true; selector: string; length: number }> {
    const { selector, text, delay } = TypeInput.parse(raw);
    const page = await this.getPage();
    await page.type(selector, text, delay !== undefined ? { delay } : undefined);
    return { ok: true, selector, length: text.length };
  }

  async readText(raw: unknown): Promise<{ ok: true; text: string }> {
    const { selector } = ReadTextInput.parse(raw);
    const page = await this.getPage();
    const text = await page.readText(selector);
    return { ok: true, text };
  }

  async screenshot(raw: unknown): Promise<{ ok: true; base64: string; format: "png" }> {
    const input = ScreenshotInput.parse(raw);
    const page = await this.getPage();
    const buf = await page.screenshot(input.fullPage ? { fullPage: true } : undefined);
    return { ok: true, base64: buf.toString("base64"), format: "png" };
  }

  async waitFor(raw: unknown): Promise<{ ok: true; selector: string }> {
    const { selector, timeoutMs } = WaitForInput.parse(raw);
    const page = await this.getPage();
    await page.waitFor(selector, timeoutMs);
    return { ok: true, selector };
  }
}

export function createCDPTools(deps: CDPToolsDeps): CDPTools {
  return new CDPTools(deps);
}
