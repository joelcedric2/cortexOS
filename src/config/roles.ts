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
 * Write a temporary CLAUDE.md for an agent session, injecting
 * learnings from the vector store.
 */
export async function buildAgentClaudeMd(
  role: AgentRole,
  learnings?: string
): Promise<string> {
  const config = await loadRoleConfig(role);
  if (learnings) {
    return `${config}\n\n## Past Learnings\n\n${learnings}`;
  }
  return config;
}
