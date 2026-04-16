import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { AgentRole } from "../agents/roles.js";
import { getRoleDefinition } from "../agents/roles.js";

/**
 * tmux pane-border color for a given role. Matches the Plan schema colors
 * (§5.3) plus `white` as a safe default for roles we don't know yet.
 *
 * Coder → blue, Tester → yellow, Pentester → red, Operator → magenta,
 * Architect/Researcher → cyan, everything else → white.
 *
 * Accepts any string (not just AgentRole) because Plan JSON from the
 * Designer is open-ended and may introduce new roles (e.g. "ui-ux").
 */
export type RoleColor =
  | "green"
  | "blue"
  | "yellow"
  | "magenta"
  | "cyan"
  | "red"
  | "white";

export function colorForRole(role: string): RoleColor {
  const normalized = role.toLowerCase().trim();

  // Architect / researcher family → cyan
  if (
    normalized === "architect" ||
    normalized === "system-designer" ||
    normalized === "researcher" ||
    normalized === "ai-ml-researcher"
  ) {
    return "cyan";
  }

  // Coder family → blue
  if (
    normalized === "coder" ||
    normalized === "backend" ||
    normalized === "frontend" ||
    normalized === "internal-apis"
  ) {
    return "blue";
  }

  // Tester family → yellow
  if (
    normalized === "tester" ||
    normalized === "e2e-tester" ||
    normalized === "visual-tester"
  ) {
    return "yellow";
  }

  // Pentester / offensive security → red
  if (
    normalized === "pentester" ||
    normalized === "pen-tester" ||
    normalized === "security" ||
    normalized === "security-reviewer"
  ) {
    return "red";
  }

  // Operator / ops-facing → magenta
  if (
    normalized === "operator" ||
    normalized === "devops-mlops" ||
    normalized === "cicd"
  ) {
    return "magenta";
  }

  return "white";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, "../../config");

/**
 * Loads and assembles CLAUDE.md content for a given agent role.
 * Combines the base template with role-specific instructions.
 */
export async function loadRoleConfig(role: AgentRole): Promise<string> {
  const definition = getRoleDefinition(role);
  const basePath = join(CONFIG_DIR, "claude-base.md");
  const rolePath = join(CONFIG_DIR, "roles", definition.configFile);

  const [baseContent, roleContent] = await Promise.all([
    readFile(basePath, "utf-8"),
    readFile(rolePath, "utf-8"),
  ]);

  return `${baseContent}\n\n---\n\n${roleContent}`;
}

/**
 * Load SOUL.md from the repo root. Returns empty string if not found
 * (agents still function without a soul — they just lack personality).
 */
let _soulCache: string | null = null;
async function loadSoul(): Promise<string> {
  if (_soulCache !== null) return _soulCache;
  try {
    // Walk up from config dir to repo root
    const repoRoot = join(CONFIG_DIR, "..");
    _soulCache = await readFile(join(repoRoot, "SOUL.md"), "utf-8");
  } catch {
    _soulCache = "";
  }
  return _soulCache;
}

/**
 * Build the full CLAUDE.md for an agent session.
 *
 * Injection order (top → bottom of the agent's context):
 *   1. SOUL.md — Nchinda's personality (every agent inherits the soul)
 *   2. Role config — role-specific instructions
 *   3. Recalled memories — top-k relevant past experiences from pgvector
 *   4. Past learnings — success/fail exemplars from the learning loop
 *
 * This is the single function that turns a generic Claude CLI instance
 * into a Nchinda specialist agent.
 */
export async function buildAgentClaudeMd(
  role: AgentRole,
  learnings?: string,
  recalledMemories?: string,
): Promise<string> {
  const [soul, config] = await Promise.all([loadSoul(), loadRoleConfig(role)]);

  const sections: string[] = [];

  // Soul first — personality shapes everything downstream
  if (soul) {
    sections.push(soul);
  }

  // Role-specific instructions
  sections.push(config);

  // Relevant memories from pgvector (injected by orchestrator before spawn)
  if (recalledMemories) {
    sections.push(`## Relevant Context from Memory\n\n${recalledMemories}`);
  }

  // Past learnings from the learning loop
  if (learnings) {
    sections.push(`## Past Learnings\n\n${learnings}`);
  }

  return sections.join("\n\n---\n\n");
}
