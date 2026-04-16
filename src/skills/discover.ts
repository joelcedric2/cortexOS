import { z } from "zod";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SkillCandidate {
  name: string;
  full_name: string;
  repo_url: string;
  description: string | null;
  stars: number;
  license: string | null;
  pushed_at: string;
  relevance_score: number;
}

export interface DiscoverOpts {
  per_page?: number;
  min_stars?: number;
  pushed_since?: string;
  token?: string;
  timeout_ms?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ACCEPTED_LICENSES = new Set([
  "mit",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "mpl-2.0",
]);

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "out",
  "about", "and", "but", "or", "nor", "not", "so", "yet", "both",
  "each", "few", "more", "most", "other", "some", "such", "no",
  "only", "own", "same", "than", "too", "very", "just", "because",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
  "they", "them", "this", "that", "these", "those", "what", "which",
  "who", "whom", "how", "all", "any", "if", "then", "else",
]);

// ─── GitHub response schema (zod) ──────────────────────────────────────────

const GhLicenseSchema = z
  .object({ spdx_id: z.string().nullable() })
  .nullable();

const GhRepoSchema = z.object({
  name: z.string(),
  full_name: z.string(),
  html_url: z.string(),
  description: z.string().nullable(),
  stargazers_count: z.number(),
  license: GhLicenseSchema,
  pushed_at: z.string(),
});

const GhSearchResponseSchema = z.object({
  items: z.array(GhRepoSchema),
});

// ─── Main function ──────────────────────────────────────────────────────────

export async function skillDiscover(
  need: string,
  opts?: DiscoverOpts,
): Promise<SkillCandidate[]> {
  const token = opts?.token ?? process.env.GITHUB_TOKEN;
  const perPage = opts?.per_page ?? 5;
  const minStars = opts?.min_stars ?? 100;
  const pushedSince = opts?.pushed_since ?? "2024-01-01";
  const timeoutMs = opts?.timeout_ms ?? 10_000;

  const keywords = extractKeywords(need);
  if (keywords.length === 0) {
    return [];
  }

  const q = `${keywords.join("+")}+stars:>=${minStars}+pushed:>=${pushedSince}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cortexOS-skill-discover",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Unknown fetch error";
    console.warn(`[skill-discover] GitHub API error: ${redact(msg)}`);
    return [];
  }

  if (!response.ok) {
    console.warn(
      `[skill-discover] GitHub API ${response.status}: ${redact(response.statusText)}`,
    );
    return [];
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    console.warn("[skill-discover] Failed to parse GitHub response JSON");
    return [];
  }

  const parsed = GhSearchResponseSchema.safeParse(data);
  if (!parsed.success) {
    console.warn(
      `[skill-discover] Response validation failed: ${parsed.error.message}`,
    );
    return [];
  }

  const now = Date.now();

  return parsed.data.items
    .filter((repo) => {
      const spdx = repo.license?.spdx_id?.toLowerCase();
      return spdx != null && ACCEPTED_LICENSES.has(spdx);
    })
    .map((repo) => {
      const recency = recencyFactor(repo.pushed_at, now);
      const license = licenseFactor(repo.license?.spdx_id ?? null);
      const score = (repo.stargazers_count / 1000) * recency * license;

      return {
        name: repo.name,
        full_name: repo.full_name,
        repo_url: repo.html_url,
        description: repo.description,
        stars: repo.stargazers_count,
        license: repo.license?.spdx_id ?? null,
        pushed_at: repo.pushed_at,
        relevance_score: Math.round(score * 1000) / 1000,
      };
    })
    .sort((a, b) => b.relevance_score - a.relevance_score);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ""))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .slice(0, 5);
}

function recencyFactor(pushedAt: string, now: number): number {
  const pushed = new Date(pushedAt).getTime();
  const ageMs = now - pushed;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // 1.0 if pushed today, 0.5 if 365 days ago, min 0.2
  return Math.max(0.2, 1 - ageDays / 730);
}

function licenseFactor(spdxId: string | null): number {
  if (!spdxId) return 0;
  const lower = spdxId.toLowerCase();
  if (lower === "mit" || lower === "isc") return 1.0;
  if (lower === "apache-2.0") return 0.95;
  if (lower.startsWith("bsd")) return 0.9;
  if (lower === "mpl-2.0") return 0.8;
  return 0;
}

function redact(msg: string): string {
  // Redact anything that looks like a token
  return msg.replace(/ghp_[A-Za-z0-9_]+/g, "ghp_***REDACTED***");
}
