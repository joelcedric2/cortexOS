/**
 * MCP tool handlers for the Dynamic Skill Loader (Phase 3.5).
 *
 *   skill_discover(need) → wraps Agent A's skillDiscover
 *   skill_install(repo_url, subpath?) → wraps installSkill
 *   skill_use(slug, args, opts?) → wraps runSkill
 *
 * Each handler validates input via zod. No silent catches — errors
 * propagate to the MCP server layer which converts them to protocol
 * error frames.
 */
import { z } from "zod";
import { installSkill } from "../skills/install.js";
import type { InstallDeps, InstallResult } from "../skills/install.js";
import { runSkill } from "../skills/runner.js";
import type { RunSkillDeps, RunSkillOutput } from "../skills/runner.js";
import { createSkill } from "../skills/create.js";
import type { CreateSkillDeps, CreateSkillResult } from "../skills/create.js";

// ----------------------------- Input schemas --------------------------------

const DiscoverInputSchema = z.object({
  need: z.string().min(1),
});

const InstallInputSchema = z.object({
  repo_url: z.string().min(1),
  subpath: z.string().optional(),
});

const UseInputSchema = z.object({
  slug: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  timeout_s: z.number().int().min(1).max(300).optional(),
});

const CreateInputSchema = z.object({
  need: z.string().min(1),
  name: z.string().optional(),
  language: z.enum(["typescript", "python", "shell"]).optional(),
});

// ----------------------------- Types ----------------------------------------

export interface DiscoverResult {
  skills: Array<{
    slug: string;
    description: string;
    confidence: number;
  }>;
}

export interface SkillToolsDeps {
  installDeps: InstallDeps;
  runDeps: RunSkillDeps;
  /** Agent A's discover function. Stub returns [] if not wired. */
  skillDiscover?: (need: string) => Promise<DiscoverResult>;
  /** Dependencies for createSkill. Optional — skill_create unavailable if absent. */
  createDeps?: CreateSkillDeps;
}

// ----------------------------- Handlers -------------------------------------

export class SkillTools {
  constructor(private readonly deps: SkillToolsDeps) {}

  /**
   * skill_discover(need) — semantic skill search.
   * Wraps Agent A's discover function; returns [] if not wired.
   */
  async discover(raw: unknown): Promise<DiscoverResult> {
    const input = DiscoverInputSchema.parse(raw);
    if (!this.deps.skillDiscover) {
      return { skills: [] };
    }
    return this.deps.skillDiscover(input.need);
  }

  /**
   * skill_install(repo_url, subpath?) — clone + vet + register a skill.
   */
  async install(raw: unknown): Promise<InstallResult> {
    const input = InstallInputSchema.parse(raw);
    return installSkill(
      {
        repo_url: input.repo_url,
        subpath: input.subpath ?? "",
      },
      this.deps.installDeps,
    );
  }

  /**
   * skill_use(slug, args, opts?) — execute a registered skill.
   */
  async use(raw: unknown): Promise<RunSkillOutput> {
    const input = UseInputSchema.parse(raw);
    return runSkill(
      {
        slug: input.slug,
        args: input.args,
        env: input.env ?? {},
        timeout_s: input.timeout_s ?? 30,
      },
      this.deps.runDeps,
    );
  }

  /**
   * skill_create(need, name?, language?) — create a new skill from scratch.
   */
  async create(raw: unknown): Promise<CreateSkillResult> {
    if (!this.deps.createDeps) {
      throw new Error("skill_create: createDeps not wired");
    }
    const input = CreateInputSchema.parse(raw);
    return createSkill(
      {
        need: input.need,
        name: input.name,
        language: input.language,
      },
      this.deps.createDeps,
    );
  }
}

export function createSkillTools(deps: SkillToolsDeps): SkillTools {
  return new SkillTools(deps);
}
