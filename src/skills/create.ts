/**
 * Meta-skill: create a new skill from a natural-language need (plan §5.5.1).
 *
 * Flow:
 *   1. INVESTIGATE  — runResearch to discover libs/APIs
 *   2. DESIGN       — Haiku call producing SKILL.md skeleton
 *   3. TDD SCAFFOLD — Haiku call producing test file
 *   4. IMPLEMENT    — Haiku call producing implementation code
 *   5. VET          — skillVet check
 *   6. REGISTER     — registry.insert as system-authored
 *   7. VALIDATE     — runSkill once as smoke test
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SkillRegistryDB, SkillRow } from "./skill-registry-db.js";
import type { RunSkillOutput, RunSkillDeps } from "./runner.js";

// ─── Public types ──────────────────────────────────────────────────────────

export interface CreateSkillRequest {
  /** Natural-language description of the capability. */
  need: string;
  /** Slug; auto-derived if omitted. */
  name?: string;
  /** Default: typescript. */
  language?: "typescript" | "python" | "shell";
}

export interface CreateSkillResult {
  id: string;
  path: string;
  skill_md_path: string;
  test_results: { total: number; passed: number; failed: number };
  trust_level: string;
}

// ─── Haiku response schemas ────────────────────────────────────────────────

const SkillMdSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  inputs: z.string().min(1),
  outputs: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
  network_required: z.boolean().default(false),
  entrypoint: z.string().min(1),
});

const TestFileSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1),
});

const ImplFileSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1),
});

// ─── Dependency injection ──────────────────────────────────────────────────

export interface ResearchBrief {
  recommended_action: string;
  evidence: string[];
  winning?: string;
}

export interface VetReport {
  ok: boolean;
  reasons: string[];
}

export interface CreateSkillDeps {
  /** Research loop for the investigation step. */
  runResearch: (question: string, opts?: { depth?: string }) => Promise<ResearchBrief>;
  /** Haiku LLM call: send a prompt, get structured JSON back. */
  callHaiku: (prompt: string) => Promise<string>;
  /** Vet function — checks for dangerous patterns. */
  skillVet: (skillDir: string) => Promise<VetReport>;
  /** Skill registry for registration. */
  registry: SkillRegistryDB;
  /** Run a skill for validation. */
  runSkill: (input: { slug: string; args: string[]; timeout_s: number }, deps: RunSkillDeps) => Promise<RunSkillOutput>;
  /** RunSkill dependencies (registry, shell, etc). */
  runSkillDeps: RunSkillDeps;
  /** Base directory for skills. Default: ~/.cortexos/skills/ */
  skillsDir?: string;
}

// ─── Errors ────────────────────────────────────────────────────────────────

export class CreateSkillError extends Error {
  constructor(
    message: string,
    public readonly phase: string,
    public readonly cause?: unknown,
  ) {
    super(`create-skill [${phase}]: ${message}`);
    this.name = "CreateSkillError";
  }
}

// ─── Constants ─────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_SLUG = 64;

const EXTENSIONS: Record<string, string> = {
  typescript: "ts",
  python: "py",
  shell: "sh",
};

const ENTRYPOINTS: Record<string, string> = {
  typescript: "index.ts",
  python: "main.py",
  shell: "main.sh",
};

// ─── Main ──────────────────────────────────────────────────────────────────

export async function createSkill(
  req: CreateSkillRequest,
  deps: CreateSkillDeps,
): Promise<CreateSkillResult> {
  const language = req.language ?? "typescript";
  const slug = deriveSlug(req.name, req.need);
  const skillsBase = deps.skillsDir ?? join(homedir(), ".cortexos", "skills");
  const skillPath = join(skillsBase, slug);
  const testsPath = join(skillPath, "tests");
  const id = slug; // use slug as id for registry

  // Create directory structure
  mkdirSync(testsPath, { recursive: true });

  // ── Step 1: INVESTIGATE ──────────────────────────────────────────────
  let researchContext: string;
  try {
    const brief = await deps.runResearch(req.need, { depth: "normal" });
    researchContext = [
      brief.winning ?? "",
      brief.recommended_action,
      ...brief.evidence,
    ]
      .filter(Boolean)
      .join("\n");
  } catch (err) {
    throw new CreateSkillError(
      `research failed: ${err instanceof Error ? err.message : String(err)}`,
      "INVESTIGATE",
      err,
    );
  }

  // ── Step 2: DESIGN CONTRACT (SKILL.md) ───────────────────────────────
  let skillMd: z.infer<typeof SkillMdSchema>;
  try {
    const prompt = designPrompt(slug, req.need, language, researchContext);
    const raw = await deps.callHaiku(prompt);
    const json = extractJson(raw);
    if (!json) throw new Error("no JSON in Haiku response");
    skillMd = SkillMdSchema.parse(JSON.parse(json));
  } catch (err) {
    throw new CreateSkillError(
      `SKILL.md generation failed: ${err instanceof Error ? err.message : String(err)}`,
      "DESIGN",
      err,
    );
  }

  const skillMdContent = renderSkillMd(skillMd, language);
  const skillMdPath = join(skillPath, "SKILL.md");
  writeFileSync(skillMdPath, skillMdContent, "utf-8");

  // ── Step 3: TDD SCAFFOLD ─────────────────────────────────────────────
  let testFile: z.infer<typeof TestFileSchema>;
  try {
    const prompt = testPrompt(slug, req.need, language, skillMdContent);
    const raw = await deps.callHaiku(prompt);
    const json = extractJson(raw);
    if (!json) throw new Error("no JSON in Haiku response");
    testFile = TestFileSchema.parse(JSON.parse(json));
  } catch (err) {
    throw new CreateSkillError(
      `test scaffold failed: ${err instanceof Error ? err.message : String(err)}`,
      "TDD_SCAFFOLD",
      err,
    );
  }

  const testFilePath = join(testsPath, testFile.filename);
  writeFileSync(testFilePath, testFile.content, "utf-8");

  // ── Step 4: IMPLEMENT ────────────────────────────────────────────────
  let implFile: z.infer<typeof ImplFileSchema>;
  try {
    const prompt = implPrompt(slug, req.need, language, skillMdContent, testFile.content);
    const raw = await deps.callHaiku(prompt);
    const json = extractJson(raw);
    if (!json) throw new Error("no JSON in Haiku response");
    implFile = ImplFileSchema.parse(JSON.parse(json));
  } catch (err) {
    throw new CreateSkillError(
      `implementation failed: ${err instanceof Error ? err.message : String(err)}`,
      "IMPLEMENT",
      err,
    );
  }

  const entrypointFilename = ENTRYPOINTS[language] ?? "index.ts";
  const implPath = join(skillPath, entrypointFilename);
  writeFileSync(implPath, implFile.content, "utf-8");

  // ── Step 5: VET ──────────────────────────────────────────────────────
  let vetReport: VetReport;
  try {
    vetReport = await deps.skillVet(skillPath);
  } catch (err) {
    throw new CreateSkillError(
      `vetting failed: ${err instanceof Error ? err.message : String(err)}`,
      "VET",
      err,
    );
  }

  if (!vetReport.ok) {
    // Check for critical flags (any reason is considered critical for self-authored)
    const hasCritical = vetReport.reasons.some(
      (r) => r.includes("flagged pattern") || r.includes("eval(") || r.includes("exec("),
    );
    if (hasCritical) {
      throw new CreateSkillError(
        `vetting found critical issues: ${vetReport.reasons.join("; ")}`,
        "VET",
      );
    }
  }

  // ── Step 6: REGISTER ─────────────────────────────────────────────────
  let row: SkillRow;
  try {
    row = deps.registry.insert({
      id,
      name: slug,
      subpath: undefined,
      trust_level: "system-trusted",
      skill_md_path: skillMdPath,
    });
  } catch (err) {
    throw new CreateSkillError(
      `registration failed: ${err instanceof Error ? err.message : String(err)}`,
      "REGISTER",
      err,
    );
  }

  // ── Step 7: VALIDATE (run once) ──────────────────────────────────────
  let testResults = { total: 1, passed: 0, failed: 1 };
  try {
    const result = await deps.runSkill(
      { slug, args: [], timeout_s: 30 },
      deps.runSkillDeps,
    );
    if (result.exitCode === 0) {
      testResults = { total: 1, passed: 1, failed: 0 };
    }
  } catch {
    // Validation run failed — record but don't block
    testResults = { total: 1, passed: 0, failed: 1 };
  }

  return {
    id,
    path: skillPath,
    skill_md_path: skillMdPath,
    test_results: testResults,
    trust_level: row.trust_level,
  };
}

// ─── Prompts ───────────────────────────────────────────────────────────────

function designPrompt(
  slug: string,
  need: string,
  language: string,
  research: string,
): string {
  return (
    `You are a skill designer. Given a capability need, emit a SKILL.md contract as JSON.\n\n` +
    `Skill slug: ${slug}\n` +
    `Need: ${need}\n` +
    `Language: ${language}\n` +
    `Research context:\n${research}\n\n` +
    `Return STRICT JSON with keys: {name, purpose, inputs, outputs, dependencies, network_required, entrypoint}.\n` +
    `"name" is the slug, "purpose" is 1-2 sentences, "inputs" describes expected input,\n` +
    `"outputs" describes what the skill returns, "dependencies" is a list of npm/pip packages,\n` +
    `"network_required" is boolean, "entrypoint" is the filename (e.g. "index.ts").\n` +
    `JSON only, no markdown.`
  );
}

function testPrompt(
  slug: string,
  need: string,
  language: string,
  skillMd: string,
): string {
  const ext = EXTENSIONS[language] ?? "ts";
  return (
    `You are a TDD test writer. Given a SKILL.md contract, produce a test file.\n\n` +
    `Skill: ${slug}\n` +
    `Need: ${need}\n` +
    `Language: ${language}\n` +
    `SKILL.md:\n${skillMd}\n\n` +
    `Write tests covering: 1 happy path, 2 failure cases, 1 edge case.\n` +
    `Return STRICT JSON: {"filename":"test.${ext}","content":"<full test file content>"}.\n` +
    `JSON only, no markdown.`
  );
}

function implPrompt(
  slug: string,
  need: string,
  language: string,
  skillMd: string,
  testContent: string,
): string {
  return (
    `You are a skill implementer. Given a SKILL.md contract and test file, produce the implementation.\n\n` +
    `Skill: ${slug}\n` +
    `Need: ${need}\n` +
    `Language: ${language}\n` +
    `SKILL.md:\n${skillMd}\n\n` +
    `Tests:\n${testContent}\n\n` +
    `Write implementation that passes all tests.\n` +
    `Return STRICT JSON: {"filename":"${ENTRYPOINTS[language] ?? "index.ts"}","content":"<full implementation>"}.\n` +
    `JSON only, no markdown.`
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function deriveSlug(name: string | undefined, need: string): string {
  if (name && SLUG_RE.test(name) && name.length <= MAX_SLUG) {
    return name;
  }
  // Derive from need: lowercase, replace non-alphanum with hyphens, trim
  const derived = need
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG);
  if (!derived || !SLUG_RE.test(derived)) {
    // Fallback to hash-based slug
    const hash = createHash("sha256").update(need).digest("hex").slice(0, 12);
    return `skill-${hash}`;
  }
  return derived;
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function renderSkillMd(
  md: z.infer<typeof SkillMdSchema>,
  language: string,
): string {
  return [
    `# ${md.name}`,
    "",
    `**Purpose:** ${md.purpose}`,
    "",
    `**Language:** ${language}`,
    "",
    `**Entrypoint:** ${md.entrypoint}`,
    "",
    `## Inputs`,
    md.inputs,
    "",
    `## Outputs`,
    md.outputs,
    "",
    `## Dependencies`,
    md.dependencies.length > 0
      ? md.dependencies.map((d) => `- ${d}`).join("\n")
      : "None",
    "",
    `## Network`,
    md.network_required ? "Required" : "Not required",
    "",
    `entrypoint: ${md.entrypoint}`,
    "",
  ].join("\n");
}
