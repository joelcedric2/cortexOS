/**
 * Generic `web_search` utility tool (plan §5.1).
 *
 * Two adapters, auto-selected:
 *   - **Tavily**: POST https://api.tavily.com/search with a JSON body. Used
 *     when a Tavily API key is available (opts.apiKey or TAVILY_API_KEY env).
 *     Returns clean, LLM-friendly results.
 *   - **DuckDuckGo HTML**: dev-only fallback. Scrapes the public HTML
 *     endpoint with a small, deliberately non-clever regex pass — just
 *     enough to extract title/url/snippet triples without pulling cheerio.
 *     Emits a one-shot `console.warn` the first time it runs per process so
 *     we remember this isn't a production surface.
 *
 * Safety:
 *   - `webSearch()` NEVER throws from a network or parse failure — it
 *     resolves to `[]` and logs a redacted warning. This keeps LLM callers
 *     from needing to own error handling.
 *   - Results are bounded: max 10 entries, snippets truncated to 500 chars.
 *   - HTML is never executed. DuckDuckGo's body is processed as opaque
 *     string data; the regex only *extracts* text between tags, and every
 *     extracted field is entity-decoded and length-capped before it
 *     reaches the caller.
 */
import { z } from "zod";

// --------------------------- Constants ------------------------------------

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 10;
const MAX_SNIPPET_CHARS = 500;

const TAVILY_URL = "https://api.tavily.com/search";
const DDG_URL = "https://html.duckduckgo.com/html/";

// --------------------------- Types ----------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  relevance?: number;
}

export interface WebSearchAdapter {
  name: string;
  search(query: string, limit?: number): Promise<SearchResult[]>;
}

export interface WebSearchOptions {
  apiKey?: string;
  adapter?: WebSearchAdapter;
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// --------------------------- Redaction ------------------------------------

const SAFE_REASON_PATTERNS: ReadonlyArray<{ match: RegExp; label: string }> = [
  { match: /abort|timeout|deadline/i, label: "timeout" },
  { match: /429|rate.?limit/i, label: "rate-limited" },
  { match: /\b(5\d\d)\b/, label: "server-error" },
  { match: /\b(4\d\d)\b/, label: "client-error" },
  { match: /invalid.*json|unexpected token|parse/i, label: "parse-error" },
  { match: /schema|zod|invalid response/i, label: "schema-mismatch" },
  { match: /econn|enotfound|network|fetch/i, label: "network" },
];

function redactReason(reason: string): string {
  for (const { match, label } of SAFE_REASON_PATTERNS) {
    if (match.test(reason)) return label;
  }
  return "unknown";
}

// --------------------------- Schemas --------------------------------------

const TavilyResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string().optional(),
  snippet: z.string().optional(),
  score: z.number().optional(),
});

const TavilyResponseSchema = z.object({
  results: z.array(TavilyResultSchema),
});

// --------------------------- Helpers --------------------------------------

function clampLimit(n: number | undefined): number {
  if (!n || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
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

function stripTags(s: string): string {
  return s.replace(/<\/?[^>]+>/g, "");
}

function cleanText(raw: string): string {
  return decodeEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
}

// --------------------------- Tavily adapter -------------------------------

export class TavilyAdapter implements WebSearchAdapter {
  readonly name = "tavily";
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: string, limit?: number): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(TAVILY_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          max_results: clampLimit(limit),
        }),
      });
      if (!res.ok) {
        throw new Error(`tavily http ${res.status}`);
      }
      const body = (await res.json()) as unknown;
      const parsed = TavilyResponseSchema.parse(body);
      return parsed.results.slice(0, clampLimit(limit)).map((r) => {
        const snippet = truncate(r.snippet ?? r.content ?? "", MAX_SNIPPET_CHARS);
        const result: SearchResult = {
          title: r.title,
          url: r.url,
          snippet,
        };
        if (typeof r.score === "number") result.relevance = r.score;
        return result;
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// --------------------------- DuckDuckGo adapter ---------------------------

let ddgWarned = false;

export class DuckDuckGoHtmlAdapter implements WebSearchAdapter {
  readonly name = "duckduckgo-html";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: string, limit?: number): Promise<SearchResult[]> {
    if (!ddgWarned) {
      ddgWarned = true;
      console.warn(
        "[web_search] using DuckDuckGo HTML fallback — dev-only, " +
          "prefer TAVILY_API_KEY in production.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = DDG_URL + "?q=" + encodeURIComponent(query);
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "cortexos-web-search/0.1",
          accept: "text/html",
        },
      });
      if (!res.ok) {
        throw new Error(`duckduckgo http ${res.status}`);
      }
      const html = await res.text();
      return parseDdgHtml(html, clampLimit(limit));
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract {title, url, snippet} triples from DuckDuckGo's HTML response.
 *
 * The markup is stable enough for a regex pass: each result lives inside a
 * `<a class="result__a" href="...">title</a>` with a sibling
 * `<a class="result__snippet">snippet</a>`. We walk the document in order
 * and pair them 1:1 up to `limit`.
 *
 * Security: both fields are stripped of tags and entity-decoded *before*
 * returning, so an attacker who owns ddg cannot ship `<script>` payloads
 * into our caller's context (we return opaque strings, not HTML).
 */
function parseDdgHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // `result__a` holds the title + href; `result__snippet` holds the snippet.
  // Use two parallel iterators and zip by index.
  const titleRe =
    /<a[^>]*class\s*=\s*"[^"]*\bresult__a\b[^"]*"[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<a[^>]*class\s*=\s*"[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const titles: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) {
    const url = decodeRedirect(decodeEntities(m[1]));
    if (!url) continue;
    titles.push({ url, title: cleanText(m[2]) });
    if (titles.length >= limit) break;
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(cleanText(m[1]));
    if (snippets.length >= limit) break;
  }

  for (let i = 0; i < titles.length; i++) {
    const t = titles[i];
    results.push({
      title: t.title,
      url: t.url,
      snippet: truncate(snippets[i] ?? "", MAX_SNIPPET_CHARS),
    });
  }
  return results;
}

/**
 * DuckDuckGo HTML wraps outbound hrefs in a `/l/?uddg=...` redirect. Unwrap
 * to the real destination when we can; otherwise just return the href as-is
 * (still safe — it's an opaque string to us).
 */
function decodeRedirect(href: string): string {
  if (!href) return "";
  try {
    const u = new URL(href, "https://duckduckgo.com/");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    return "";
  } catch {
    return "";
  }
}

// --------------------------- Public API -----------------------------------

/**
 * Run a web search. Picks an adapter by this precedence:
 *   1. `opts.adapter` (explicit injection wins — tests + custom providers)
 *   2. Tavily, if `opts.apiKey` or `TAVILY_API_KEY` is set
 *   3. DuckDuckGo HTML fallback
 *
 * On any failure (network, schema, timeout, HTTP error) this resolves to
 * `[]` and logs a redacted `console.warn`. It never throws.
 */
export async function webSearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<SearchResult[]> {
  if (!query || !query.trim()) return [];
  const limit = clampLimit(opts.limit);
  const adapter = pickAdapter(opts);
  try {
    const results = await adapter.search(query, limit);
    return results.slice(0, limit).map((r) => ({
      ...r,
      snippet: truncate(r.snippet ?? "", MAX_SNIPPET_CHARS),
    }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[web_search] adapter=${adapter.name} failed: ${redactReason(reason)}`,
    );
    return [];
  }
}

function pickAdapter(opts: WebSearchOptions): WebSearchAdapter {
  if (opts.adapter) return opts.adapter;
  const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
  if (apiKey) {
    return new TavilyAdapter({
      apiKey,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
  }
  return new DuckDuckGoHtmlAdapter({
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/** Reset the `ddgWarned` latch. Used only by tests to assert the warn fires. */
export function __resetDdgWarnedForTests(): void {
  ddgWarned = false;
}
