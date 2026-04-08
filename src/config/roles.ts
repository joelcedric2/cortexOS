import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { AgentRole } from "../agents/roles.js";
import { getRoleDefinition } from "../agents/roles.js";

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
