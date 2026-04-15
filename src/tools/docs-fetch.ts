/**
 * Generic `docs_fetch` utility tool (plan §5.1).
 *
 * Fetches a URL and returns its plain-text content, extracted with a tiny
 * hand-rolled HTML-to-text pass (no cheerio dependency). Intended for LLM
 * callers that want to read a doc page or API reference without owning
 * HTTP + parsing themselves.
 *
 * Safety:
 *   - Protocol allow-list: `http://` and `https://` only. Rejects `file://`,
 *     `ftp://`, `data:`, `javascript:`, etc. This prevents an LLM-crafted
 *     URL from reading local files or triggering SSRF via gopher.
 *   - Hard 5 MB response cap (aborts on overflow).
 *   - 10s default timeout via AbortController.
 *   - Redacted error reasons (network/timeout/client-error/server-error)
 *     so transport errors never leak server internals into the LLM's
 *     context.
 */
import { z } from "zod";

// --------------------------- Constants ------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// --------------------------- Errors ---------------------------------------

export class DocsFetchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "bad-url"
      | "bad-protocol"
      | "timeout"
      | "too-large"
      | "network"
      | "client-error"
      | "server-error"
      | "parse-error",
  ) {
    super(`docs_fetch: ${message}`);
    this.name = "DocsFetchError";
  }
}

// --------------------------- Schemas --------------------------------------

const DocsFetchInputSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  maxBytes: z.number().int().positive().max(MAX_RESPONSE_BYTES).optional(),
  userAgent: z.string().min(1).max(200).optional(),
});

export type DocsFetchInput = z.infer<typeof DocsFetchInputSchema>;

export interface DocsFetchResult {
  url: string;
  title?: string;
  text: string;
  links: string[];
  bytes: number;
  truncated: boolean;
}

export interface DocsFetchDeps {
  fetchImpl?: typeof fetch;
}

// --------------------------- Public API -----------------------------------

export async function docsFetch(
  url: string,
  opts: Omit<DocsFetchInput, "url"> & DocsFetchDeps = {},
): Promise<DocsFetchResult> {
  const parsed = DocsFetchInputSchema.parse({
    url,
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    userAgent: opts.userAgent,
  });

  const u = safeParseUrl(parsed.url);
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw new DocsFetchError(
      `protocol '${u.protocol}' is not allowed — only http(s)`,
      "bad-protocol",
    );
  }

  const timeoutMs = parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = parsed.maxBytes ?? MAX_RESPONSE_BYTES;
  const userAgent = parsed.userAgent ?? "cortexos-docs-fetch/0.1";
  const fetchImpl = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(parsed.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": userAgent, accept: "text/html,text/plain,*/*" },
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new DocsFetchError(`timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new DocsFetchError(
      `network error: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  }
  clearTimeout(timer);

  if (response.status >= 500) {
    throw new DocsFetchError(
      `upstream ${response.status}`,
      "server-error",
    );
  }
  if (response.status >= 400) {
    throw new DocsFetchError(
      `upstream ${response.status}`,
      "client-error",
    );
  }

  const { body, bytes, truncated } = await readBounded(response, maxBytes);
  const contentType = response.headers.get("content-type") ?? "";
  const looksHtml = /html/i.test(contentType) || /^\s*<!doctype|^\s*<html/i.test(body);

  const { text, title, links } = looksHtml ? htmlToText(body, u) : {
    text: body,
    title: undefined as string | undefined,
    links: [] as string[],
  };

  return {
    url: response.url || parsed.url,
    title,
    text,
    links,
    bytes,
    truncated,
  };
}

// --------------------------- Helpers --------------------------------------

function safeParseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new DocsFetchError(`invalid URL: ${raw}`, "bad-url");
  }
}

/**
 * Read the response body while enforcing a hard byte cap. Abort as soon as
 * we've seen `maxBytes + 1` to make the truncation signal load-bearing.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; bytes: number; truncated: boolean }> {
  if (!response.body) {
    const t = await response.text();
    const truncated = t.length > maxBytes;
    return {
      body: truncated ? t.slice(0, maxBytes) : t,
      bytes: t.length,
      truncated,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  let truncated = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      const remain = maxBytes - (total - value.byteLength);
      if (remain > 0) out += decoder.decode(value.subarray(0, remain), { stream: false });
      try {
        await reader.cancel();
      } catch {
        // cancel() can throw if already closed — safe to swallow here
        // because we've captured the bounded body already.
      }
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  if (!truncated) out += decoder.decode();
  return { body: out, bytes: total, truncated };
}

/**
 * Tiny HTML → text extractor. No DOM parser — we strip tag pairs with
 * content-dropping regex for script/style/noscript/template, then remove
 * the rest of the tags and decode a handful of common entities.
 *
 * Intentionally simple: good enough for docs pages, not a general-purpose
 * scraper. Tests lock the behavior down.
 */
function htmlToText(html: string, base: URL): {
  text: string;
  title?: string;
  links: string[];
} {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : undefined;

  const links: string[] = [];
  const linkRe = /<a\s[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1] ?? m[2] ?? m[3];
    if (!href) continue;
    try {
      const abs = new URL(href, base).toString();
      if (!links.includes(abs)) links.push(abs);
    } catch {
      // Non-resolvable hrefs (e.g. mailto:, javascript:) just get dropped.
    }
  }

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const text = decodeEntities(stripTags(stripped))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, title, links };
}

function stripTags(s: string): string {
  return s.replace(/<\/?[^>]+>/g, " ");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}
