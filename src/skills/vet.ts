import { statSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VetReport {
  ok: boolean;
  reasons: string[];
  size_kb: number;
  has_readme: boolean;
  has_skill_md: boolean;
  license: string | null;
  flagged_patterns: FlaggedPattern[];
}

export interface FlaggedPattern {
  pattern: string;
  file: string;
  line: number;
}

export interface VetOpts {
  max_size_kb?: number;
  skip_patterns?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SIZE_KB = 20 * 1024; // 20 MB

const ACCEPTED_LICENSES = new Set([
  "mit",
  "apache-2.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "mpl-2.0",
]);

/**
 * Patterns that indicate potentially dangerous code.
 * Each entry: [regex, human label].
 */
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/\beval\s*\(/, "eval("],
  [/\bnew\s+Function\s*\(/, "new Function("],
  [/\bchild_process\s*\.\s*exec\s*\(/, "child_process.exec("],
  [/\bwget\b/, "wget"],
  [/\bcurl\s+-e\b/, "curl -e"],
  [/\bbase64\s+-d\b/, "base64 -d"],
  [/\bchmod\s+\+x\b/, "chmod +x"],
];

const LICENSE_FILE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md"];

const LICENSE_IDENTIFIERS: Array<[RegExp, string]> = [
  [/\bMIT\s+License\b/i, "MIT"],
  [/\bApache\s+License,?\s+Version\s+2\.0\b/i, "Apache-2.0"],
  [/\bBSD\s+3-Clause\b/i, "BSD-3-Clause"],
  [/\bBSD\s+2-Clause\b/i, "BSD-2-Clause"],
  [/\bISC\s+License\b/i, "ISC"],
  [/\bMozilla\s+Public\s+License,?\s+(?:Version\s+)?2\.0\b/i, "MPL-2.0"],
];

// ─── Main function ──────────────────────────────────────────────────────────

export async function skillVet(
  repoRootPath: string,
  opts?: VetOpts,
): Promise<VetReport> {
  const maxSizeKb = opts?.max_size_kb ?? MAX_SIZE_KB;
  const reasons: string[] = [];
  const flaggedPatterns: FlaggedPattern[] = [];

  // 1. Size check
  const sizeKb = calcDirSizeKb(repoRootPath);
  const sizeOk = sizeKb <= maxSizeKb;
  if (!sizeOk) {
    reasons.push(`Repository size ${sizeKb}KB exceeds limit ${maxSizeKb}KB`);
  }

  // 2. README check
  const hasReadme = hasFileCI(repoRootPath, [
    "README.md",
    "README",
    "README.txt",
    "readme.md",
  ]);
  if (!hasReadme) {
    reasons.push("Missing README");
  }

  // 3. SKILL.md check
  const hasSkillMd = hasFileCI(repoRootPath, ["SKILL.md", "skill.md"]);
  if (!hasSkillMd) {
    reasons.push("Missing SKILL.md");
  }

  // 4. License detection
  const license = detectLicense(repoRootPath);
  if (!license) {
    reasons.push("No recognized OSS license found");
  } else if (!ACCEPTED_LICENSES.has(license.toLowerCase())) {
    reasons.push(`License ${license} is not in the accepted list`);
  }

  // 5. Static pattern scan
  if (!opts?.skip_patterns) {
    scanDirectory(repoRootPath, repoRootPath, flaggedPatterns);
    if (flaggedPatterns.length > 0) {
      reasons.push(
        `Found ${flaggedPatterns.length} flagged pattern(s): ${[...new Set(flaggedPatterns.map((p) => p.pattern))].join(", ")}`,
      );
    }
  }

  const licenseValue =
    license && ACCEPTED_LICENSES.has(license.toLowerCase())
      ? license
      : license ?? null;

  return {
    ok: reasons.length === 0,
    reasons,
    size_kb: sizeKb,
    has_readme: hasReadme,
    has_skill_md: hasSkillMd,
    license: licenseValue,
    flagged_patterns: flaggedPatterns,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function calcDirSizeKb(dirPath: string): number {
  let totalBytes = 0;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    if (entry.name === ".git") continue;
    if (entry.isDirectory()) {
      totalBytes += calcDirSizeKb(full) * 1024; // recursive returns KB
    } else if (entry.isFile()) {
      totalBytes += statSync(full).size;
    }
  }
  return Math.ceil(totalBytes / 1024);
}

function hasFileCI(dir: string, names: string[]): boolean {
  const entries = readdirSync(dir);
  const lower = new Set(entries.map((e) => e.toLowerCase()));
  return names.some((n) => lower.has(n.toLowerCase()));
}

function detectLicense(repoRoot: string): string | null {
  for (const name of LICENSE_FILE_NAMES) {
    const p = join(repoRoot, name);
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      for (const [regex, id] of LICENSE_IDENTIFIERS) {
        if (regex.test(content)) return id;
      }
    }
  }
  // Also check package.json
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        license?: string;
      };
      if (pkg.license) return pkg.license;
    } catch {
      // Ignore parse errors
    }
  }
  return null;
}

const SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".sh", ".bash", ".zsh",
  ".yaml", ".yml", ".json", ".toml",
]);

function scanDirectory(
  baseDir: string,
  currentDir: string,
  results: FlaggedPattern[],
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(baseDir, full, results);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (!SCANNABLE_EXTENSIONS.has(ext)) continue;
      scanFile(baseDir, full, results);
    }
  }
}

function scanFile(
  baseDir: string,
  filePath: string,
  results: FlaggedPattern[],
): void {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return; // Skip unreadable files
  }

  const relPath = relative(baseDir, filePath);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [regex, label] of DANGEROUS_PATTERNS) {
      if (regex.test(line)) {
        results.push({ pattern: label, file: relPath, line: i + 1 });
      }
    }
  }
}

function extname(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot);
}
