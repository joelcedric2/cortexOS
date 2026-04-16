/**
 * Stub CDP interfaces for Agent B (Social Operator Layer).
 *
 * Agent A ships the real `src/browser/cdp.ts`; until that lands, social
 * drivers type-check against these identical interfaces.  Delete this
 * file once Agent A's cdp.ts is merged.
 */

export interface CDPPage {
  navigate(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string, opts?: { delay?: number }): Promise<void>;
  readText(selector?: string): Promise<string>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
  waitFor(selector: string, timeoutMs?: number): Promise<void>;
  evaluate<T>(fn: string): Promise<T>;
  close(): Promise<void>;
}

export interface CDPBrowser {
  launch(): Promise<void>;
  newPage(): Promise<CDPPage>;
  close(): Promise<void>;
}
