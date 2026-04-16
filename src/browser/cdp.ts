/**
 * Chrome DevTools Protocol wrapper for cortexOS.
 *
 * Launches a dedicated Chrome instance via --remote-debugging-port and
 * communicates over the CDP WebSocket. Uses raw WebSocket (node `ws` is
 * not needed — Node 22+ has native WebSocket, but we target Node 20 so
 * we use `http.get` for the JSON endpoint and a minimal CDP client via
 * the built-in `fetch` + dynamic import of the ws URL).
 *
 * Design decision: we avoid a Playwright devDependency and instead talk
 * CDP directly. This keeps the dependency footprint at zero (Chrome is
 * the only external requirement) and gives us full control over the
 * protocol surface we expose.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// ────────────────────────── Public interfaces ──────────────────────────

export interface CDPBrowserOptions {
  debugPort?: number;
  chromePath?: string;
  headless?: boolean;
  userDataDir?: string;
  launchTimeout?: number;
}

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
  pages(): Promise<CDPPage[]>;
  close(): Promise<void>;
  isConnected(): boolean;
}

// ────────────────────────── Internal types ──────────────────────────────

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Minimal CDP protocol message shapes. */
interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Low-level CDP WebSocket session. Sends commands and resolves responses
 * by matching `id` fields. Uses Node 20's global WebSocket when available,
 * otherwise falls back to a dynamic import attempt.
 */
class CDPSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }>();
  private _closed = false;

  async connect(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => {
        this.ws = ws;
        resolve();
      });
      ws.addEventListener("error", (ev) => {
        if (!this.ws) reject(new Error(`CDP WebSocket error: ${String(ev)}`));
      });
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data)) as CDPResponse;
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) {
              p.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              p.resolve(msg.result ?? {});
            }
          }
        }
      });
      ws.addEventListener("close", () => {
        this._closed = true;
        for (const [, p] of this.pending) {
          p.reject(new Error("CDP WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }

  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ws || this._closed) {
      throw new Error("CDP session not connected");
    }
    const id = this.nextId++;
    const msg: CDPRequest = { id, method };
    if (params) msg.params = params;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(msg));
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  disconnect(): void {
    this._closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error("CDP session disconnected"));
    }
    this.pending.clear();
  }
}

// ────────────────────────── CDPPageImpl ─────────────────────────────────

class CDPPageImpl implements CDPPage {
  constructor(
    private readonly session: CDPSession,
    private readonly targetId: string,
  ) {}

  async navigate(url: string): Promise<void> {
    await this.session.send("Page.navigate", { url });
    await this.session.send("Page.enable");
    // Wait for load event
    await this.session.send("Runtime.evaluate", {
      expression: "new Promise(r => { if (document.readyState === 'complete') r(); else window.addEventListener('load', r); })",
      awaitPromise: true,
    });
  }

  async click(selector: string): Promise<void> {
    // Resolve selector to node, get box model, dispatch click
    const doc = await this.session.send("DOM.getDocument");
    const root = doc["root"] as Record<string, unknown>;
    const nodeId = root["nodeId"] as number;
    const search = await this.session.send("DOM.querySelector", {
      nodeId,
      selector,
    });
    const foundNodeId = search["nodeId"] as number;
    if (!foundNodeId) throw new Error(`Selector not found: ${selector}`);

    const box = await this.session.send("DOM.getBoxModel", { nodeId: foundNodeId });
    const model = box["model"] as Record<string, unknown>;
    const content = model["content"] as number[];
    // content is [x1,y1, x2,y2, x3,y3, x4,y4] — center of the quad
    const cx = (content[0] + content[2] + content[4] + content[6]) / 4;
    const cy = (content[1] + content[3] + content[5] + content[7]) / 4;

    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
    });
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
    });
  }

  async type(selector: string, text: string, opts?: { delay?: number }): Promise<void> {
    // Focus the element first
    await this.click(selector);
    const delay = opts?.delay ?? 0;
    for (const ch of text) {
      await this.session.send("Input.dispatchKeyEvent", {
        type: "keyDown", text: ch,
      });
      await this.session.send("Input.dispatchKeyEvent", {
        type: "keyUp", text: ch,
      });
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  async readText(selector?: string): Promise<string> {
    const expr = selector
      ? `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`
      : `document.body.innerText`;
    const result = await this.session.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    const res = result["result"] as Record<string, unknown>;
    return (res["value"] as string) ?? "";
  }

  async screenshot(opts?: { fullPage?: boolean }): Promise<Buffer> {
    const params: Record<string, unknown> = { format: "png" };
    if (opts?.fullPage) {
      params["captureBeyondViewport"] = true;
    }
    const result = await this.session.send("Page.captureScreenshot", params);
    const data = result["data"] as string;
    return Buffer.from(data, "base64");
  }

  async waitFor(selector: string, timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? 5000;
    const start = Date.now();
    const poll = `
      new Promise((resolve, reject) => {
        const deadline = ${timeout};
        const start = Date.now();
        const check = () => {
          if (document.querySelector(${JSON.stringify(selector)})) return resolve(true);
          if (Date.now() - start > deadline) return reject(new Error('waitFor timeout: ${selector}'));
          requestAnimationFrame(check);
        };
        check();
      })
    `;
    const elapsed = Date.now() - start;
    const remaining = Math.max(100, timeout - elapsed);
    await this.session.send("Runtime.evaluate", {
      expression: poll,
      awaitPromise: true,
      timeout: remaining,
    });
  }

  async evaluate<T>(fn: string): Promise<T> {
    const result = await this.session.send("Runtime.evaluate", {
      expression: fn,
      returnByValue: true,
      awaitPromise: true,
    });
    const res = result["result"] as Record<string, unknown>;
    return res["value"] as T;
  }

  async close(): Promise<void> {
    await this.session.send("Target.closeTarget", { targetId: this.targetId });
    this.session.disconnect();
  }
}

// ────────────────────────── CDPBrowserImpl ──────────────────────────────

const DEFAULT_PORT = 9222;
const DEFAULT_LAUNCH_TIMEOUT = 15_000;
const DEFAULT_USER_DATA_DIR = join(homedir(), ".cortexos", "chrome-profile");
const MACOS_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Injectable seams for testing — not part of the public API. */
export interface CDPBrowserInternals {
  spawnChrome?: (
    path: string,
    args: string[],
  ) => ChildProcess;
  fetchTargets?: (port: number) => Promise<CDPTarget[]>;
  createNewTarget?: (port: number) => Promise<CDPTarget>;
  createSession?: () => CDPSession;
}

class CDPBrowserImpl implements CDPBrowser {
  private readonly port: number;
  private readonly chromePath: string;
  private readonly headless: boolean;
  private readonly userDataDir: string;
  private readonly launchTimeout: number;
  private chromeProcess: ChildProcess | null = null;
  private connected = false;
  private readonly activeSessions: CDPSession[] = [];
  private readonly internals: CDPBrowserInternals;

  constructor(opts?: CDPBrowserOptions, internals?: CDPBrowserInternals) {
    this.port = opts?.debugPort ?? DEFAULT_PORT;
    this.chromePath = opts?.chromePath ?? MACOS_CHROME_PATH;
    this.headless = opts?.headless ?? false;
    this.userDataDir = opts?.userDataDir ?? DEFAULT_USER_DATA_DIR;
    this.launchTimeout = opts?.launchTimeout ?? DEFAULT_LAUNCH_TIMEOUT;
    this.internals = internals ?? {};
  }

  async launch(): Promise<void> {
    // Idempotent: if already connected, skip
    if (this.connected && this.chromeProcess) return;

    // Ensure profile dir exists
    if (!existsSync(this.userDataDir)) {
      mkdirSync(this.userDataDir, { recursive: true });
    }

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ];
    if (this.headless) {
      args.push("--headless=new");
    }

    const spawn = this.internals.spawnChrome ?? defaultSpawnChrome;
    this.chromeProcess = spawn(this.chromePath, args);

    // Listen for unexpected exit
    this.chromeProcess.on("exit", () => {
      this.connected = false;
      this.chromeProcess = null;
    });

    // Wait for the debug port to become reachable
    await this.waitForDebugPort();
    this.connected = true;
  }

  async newPage(): Promise<CDPPage> {
    this.assertConnected();

    // Use PUT /json/new to create a blank tab
    const createFn = this.internals.createNewTarget ?? createNewTarget;
    const newTarget = await createFn(this.port);
    const session = this.internals.createSession?.() ?? new CDPSession();
    await session.connect(newTarget.webSocketDebuggerUrl);
    this.activeSessions.push(session);
    await session.send("Page.enable");
    await session.send("DOM.enable");
    await session.send("Runtime.enable");
    return new CDPPageImpl(session, newTarget.id);
  }

  async pages(): Promise<CDPPage[]> {
    this.assertConnected();
    const fetchFn = this.internals.fetchTargets ?? fetchTargets;
    const targets = await fetchFn(this.port);
    const pageTargets = targets.filter((t) => t.type === "page");
    const result: CDPPage[] = [];
    for (const t of pageTargets) {
      const session = this.internals.createSession?.() ?? new CDPSession();
      await session.connect(t.webSocketDebuggerUrl);
      this.activeSessions.push(session);
      result.push(new CDPPageImpl(session, t.id));
    }
    return result;
  }

  async close(): Promise<void> {
    for (const s of this.activeSessions) {
      s.disconnect();
    }
    this.activeSessions.length = 0;
    if (this.chromeProcess) {
      this.chromeProcess.kill("SIGTERM");
      this.chromeProcess = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.chromeProcess !== null;
  }

  private assertConnected(): void {
    if (!this.isConnected()) {
      throw new Error("CDP browser not connected — call launch() first");
    }
  }

  private async waitForDebugPort(): Promise<void> {
    const deadline = Date.now() + this.launchTimeout;
    const fetchFn = this.internals.fetchTargets ?? fetchTargets;
    while (Date.now() < deadline) {
      try {
        await fetchFn(this.port);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(
      `Chrome debug port ${this.port} did not respond within ${this.launchTimeout}ms`,
    );
  }
}

// ────────────────────────── Helpers ─────────────────────────────────────

function defaultSpawnChrome(path: string, args: string[]): ChildProcess {
  const child = execFile(path, args, { windowsHide: true });
  // Unref so the Node process can exit even if Chrome is still running
  child.unref();
  return child;
}

/** GET http://127.0.0.1:<port>/json — returns CDP target list. */
function fetchTargets(port: number): Promise<CDPTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as CDPTarget[]);
        } catch (e) {
          reject(new Error(`Failed to parse CDP targets: ${String(e)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error("CDP target fetch timeout"));
    });
  });
}

/** PUT http://127.0.0.1:<port>/json/new — creates a new blank tab. */
function createNewTarget(port: number): Promise<CDPTarget> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/json/new",
        method: "PUT",
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as CDPTarget);
          } catch (e) {
            reject(new Error(`Failed to parse new target: ${String(e)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("CDP new target timeout"));
    });
    req.end();
  });
}

// ────────────────────────── Factory ────────────────────────────────────

export function createCDPBrowser(
  opts?: CDPBrowserOptions,
  internals?: CDPBrowserInternals,
): CDPBrowser {
  return new CDPBrowserImpl(opts, internals);
}
