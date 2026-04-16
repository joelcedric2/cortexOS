/**
 * Lazy-init wiring for SkillTools in the MCP serve context.
 *
 * Constructs the dependency bundles (InstallDeps, RunSkillDeps) using
 * real `runShell`, filesystem APIs, and the in-memory registry stub.
 * Swap to the real SkillRegistryDB when Agent A lands.
 */
import { readFile, writeFile, access } from "node:fs/promises";
import { SkillTools } from "./skill-tools.js";
import { runShell } from "../tools/shell.js";
import { InMemorySkillRegistry } from "../skills/_registry-stub.js";
import type { InstallDeps } from "../skills/install.js";
import type { RunSkillDeps } from "../skills/runner.js";

let instance: SkillTools | null = null;

export async function getSkillTools(): Promise<SkillTools> {
  if (instance) return instance;

  const registry = new InMemorySkillRegistry();
  const skillsDir = process.env.CORTEX_SKILLS_DIR ?? "./skills";

  const shellAdapter = async (
    cmd: string[],
    opts?: { cwd?: string; callerRole?: string; timeoutMs?: number; env?: Record<string, string> },
  ) => runShell(cmd, opts);

  const fileExists = async (path: string): Promise<boolean> => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };

  const installDeps: InstallDeps = {
    registry,
    runShell: shellAdapter,
    skillVet: async () => ({ passed: true, fatal: false, reasons: [] }),
    readFile: async (p) => readFile(p, "utf-8"),
    writeFile: async (p, c) => { await writeFile(p, c, "utf-8"); },
    fileExists,
    skillsDir,
  };

  const runDeps: RunSkillDeps = {
    registry,
    runShell: shellAdapter,
    readFile: async (p) => readFile(p, "utf-8"),
    fileExists,
    skillsDir,
  };

  instance = new SkillTools({ installDeps, runDeps });
  return instance;
}
