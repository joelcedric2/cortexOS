/**
 * Tests for src/mcp/cdp-tools.ts — MCP round-trip with a fake CDPBrowser.
 *
 * Validates that each MCP tool correctly parses input via zod, delegates
 * to the CDPPage mock, and returns the expected response shape.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CDPTools } from "../src/mcp/cdp-tools.js";
import type { CDPBrowser, CDPPage } from "../src/browser/cdp.js";

// ────────────────────────── Fake CDPPage ───────────────────────────────

class FakeCDPPage implements CDPPage {
  public navigatedUrls: string[] = [];
  public clickedSelectors: string[] = [];
  public typedEntries: Array<{ selector: string; text: string; opts?: { delay?: number } }> = [];
  public readTextSelector: string | undefined;
  public readTextResult = "Hello from fake page";
  public screenshotOpts: Array<{ fullPage?: boolean } | undefined> = [];
  public waitedSelectors: Array<{ selector: string; timeoutMs?: number }> = [];
  public evaluatedExprs: string[] = [];
  public closed = false;

  async navigate(url: string): Promise<void> {
    this.navigatedUrls.push(url);
  }

  async click(selector: string): Promise<void> {
    this.clickedSelectors.push(selector);
  }

  async type(selector: string, text: string, opts?: { delay?: number }): Promise<void> {
    this.typedEntries.push({ selector, text, opts });
  }

  async readText(selector?: string): Promise<string> {
    this.readTextSelector = selector;
    return this.readTextResult;
  }

  async screenshot(opts?: { fullPage?: boolean }): Promise<Buffer> {
    this.screenshotOpts.push(opts);
    return Buffer.from("fake-screenshot-png");
  }

  async waitFor(selector: string, timeoutMs?: number): Promise<void> {
    this.waitedSelectors.push({ selector, timeoutMs });
  }

  async evaluate<T>(fn: string): Promise<T> {
    this.evaluatedExprs.push(fn);
    return "eval-result" as T;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ────────────────────────── Fake CDPBrowser ────────────────────────────

class FakeCDPBrowser implements CDPBrowser {
  public launched = false;
  public _connected = false;
  public fakePage: FakeCDPPage;

  constructor(page?: FakeCDPPage) {
    this.fakePage = page ?? new FakeCDPPage();
  }

  async launch(): Promise<void> {
    this.launched = true;
    this._connected = true;
  }

  async newPage(): Promise<CDPPage> {
    return this.fakePage;
  }

  async pages(): Promise<CDPPage[]> {
    return [this.fakePage];
  }

  async close(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }
}

// ────────────────────────── Tests ──────────────────────────────────────

describe("cdp_navigate", () => {
  test("navigates to URL and returns success", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    const result = await tools.navigate({ url: "https://example.com" });

    assert.deepEqual(result, { ok: true, url: "https://example.com" });
    assert.deepEqual(page.navigatedUrls, ["https://example.com"]);
  });

  test("auto-launches browser if not connected", async () => {
    const browser = new FakeCDPBrowser();
    const tools = new CDPTools({ browser });

    await tools.navigate({ url: "https://example.com" });

    assert.equal(browser.launched, true);
  });

  test("rejects invalid URL", async () => {
    const browser = new FakeCDPBrowser();
    const tools = new CDPTools({ browser });

    await assert.rejects(() => tools.navigate({ url: "not-a-url" }));
  });

  test("rejects missing URL", async () => {
    const browser = new FakeCDPBrowser();
    const tools = new CDPTools({ browser });

    await assert.rejects(() => tools.navigate({}));
  });
});

describe("cdp_click", () => {
  test("clicks element by selector", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    const result = await tools.click({ selector: "#btn" });

    assert.deepEqual(result, { ok: true, selector: "#btn" });
    assert.deepEqual(page.clickedSelectors, ["#btn"]);
  });

  test("rejects empty selector", async () => {
    const browser = new FakeCDPBrowser();
    const tools = new CDPTools({ browser });

    await assert.rejects(() => tools.click({ selector: "" }));
  });
});

describe("cdp_type", () => {
  test("types text into element", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    const result = await tools.type({ selector: "#input", text: "hello" });

    assert.deepEqual(result, { ok: true, selector: "#input", length: 5 });
    assert.equal(page.typedEntries.length, 1);
    assert.equal(page.typedEntries[0].selector, "#input");
    assert.equal(page.typedEntries[0].text, "hello");
  });

  test("passes delay option", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    await tools.type({ selector: "#input", text: "hi", delay: 50 });

    assert.deepEqual(page.typedEntries[0].opts, { delay: 50 });
  });

  test("rejects delay > 1000", async () => {
    const browser = new FakeCDPBrowser();
    const tools = new CDPTools({ browser });

    await assert.rejects(() =>
      tools.type({ selector: "#input", text: "hi", delay: 2000 }),
    );
  });
});

describe("cdp_read_text", () => {
  test("returns page text (no selector)", async () => {
    const page = new FakeCDPPage();
    page.readTextResult = "Welcome to example.com";
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    const result = await tools.readText({});

    assert.deepEqual(result, { ok: true, text: "Welcome to example.com" });
    assert.equal(page.readTextSelector, undefined);
  });

  test("passes selector when provided", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    await tools.readText({ selector: ".content" });

    assert.equal(page.readTextSelector, ".content");
  });
});

describe("cdp_screenshot", () => {
  test("returns base64-encoded PNG", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    const result = await tools.screenshot({});

    assert.equal(result.ok, true);
    assert.equal(result.format, "png");
    assert.equal(
      result.base64,
      Buffer.from("fake-screenshot-png").toString("base64"),
    );
  });

  test("passes fullPage option", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    await tools.screenshot({ fullPage: true });

    assert.deepEqual(page.screenshotOpts[0], { fullPage: true });
  });

  test("does not pass fullPage when not specified", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    await tools.screenshot({});

    assert.equal(page.screenshotOpts[0], undefined);
  });
});

describe("cdp_wait_for", () => {
  test("waits for selector", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    const result = await tools.waitFor({ selector: ".loaded" });

    assert.deepEqual(result, { ok: true, selector: ".loaded" });
    assert.equal(page.waitedSelectors[0].selector, ".loaded");
  });

  test("passes custom timeout", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    await tools.waitFor({ selector: ".done", timeoutMs: 10000 });

    assert.equal(page.waitedSelectors[0].timeoutMs, 10000);
  });

  test("rejects timeout < 100", async () => {
    const browser = new FakeCDPBrowser();
    const tools = new CDPTools({ browser });

    await assert.rejects(() =>
      tools.waitFor({ selector: ".x", timeoutMs: 50 }),
    );
  });

  test("rejects missing selector", async () => {
    const browser = new FakeCDPBrowser();
    const tools = new CDPTools({ browser });

    await assert.rejects(() => tools.waitFor({}));
  });
});

describe("CDPTools lazy page lifecycle", () => {
  test("reuses the same page across multiple calls", async () => {
    const page = new FakeCDPPage();
    const browser = new FakeCDPBrowser(page);
    const tools = new CDPTools({ browser });

    await tools.navigate({ url: "https://a.com" });
    await tools.navigate({ url: "https://b.com" });

    // Same page instance should have both URLs
    assert.deepEqual(page.navigatedUrls, ["https://a.com", "https://b.com"]);
  });
});
