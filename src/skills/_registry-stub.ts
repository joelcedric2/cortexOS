/**
 * Minimal stub for Agent A's SkillRegistryDB.
 *
 * Provides the same interface that `install.ts` and `runner.ts` depend on.
 * Agent A ships the real implementation at `src/skills/skill-registry-db.ts`.
 * Delete this file at integration time.
 */

export type TrustLevel = "unvetted" | "sandboxed" | "trusted" | "quarantined" | "deprecated";

export interface SkillRow {
  id: string;
  slug: string;
  repo_url: string;
  subpath: string;
  commit_sha: string;
  trust_level: TrustLevel;
  installed_at: string;
  last_run_at: string | null;
  run_count: number;
  fail_count: number;
  metadata: Record<string, unknown>;
}

export interface InsertSkillInput {
  slug: string;
  repo_url: string;
  subpath: string;
  commit_sha: string;
  trust_level: TrustLevel;
  metadata?: Record<string, unknown>;
}

export interface RunOutcome {
  success: boolean;
  durationMs: number;
}

export interface SkillRegistryDB {
  insert(input: InsertSkillInput): SkillRow;
  get(slug: string): SkillRow | undefined;
  list(): SkillRow[];
  setTrustLevel(slug: string, level: TrustLevel): void;
  recordRun(slug: string, outcome: RunOutcome): void;
}

/**
 * In-memory implementation for tests and early integration.
 */
export class InMemorySkillRegistry implements SkillRegistryDB {
  private readonly rows = new Map<string, SkillRow>();

  insert(input: InsertSkillInput): SkillRow {
    if (this.rows.has(input.slug)) {
      throw new Error(`skill already exists: ${input.slug}`);
    }
    const row: SkillRow = {
      id: `skill_${Date.now().toString(36)}`,
      slug: input.slug,
      repo_url: input.repo_url,
      subpath: input.subpath,
      commit_sha: input.commit_sha,
      trust_level: input.trust_level,
      installed_at: new Date().toISOString(),
      last_run_at: null,
      run_count: 0,
      fail_count: 0,
      metadata: input.metadata ?? {},
    };
    this.rows.set(input.slug, row);
    return row;
  }

  get(slug: string): SkillRow | undefined {
    return this.rows.get(slug);
  }

  list(): SkillRow[] {
    return [...this.rows.values()];
  }

  setTrustLevel(slug: string, level: TrustLevel): void {
    const row = this.rows.get(slug);
    if (!row) throw new Error(`skill not found: ${slug}`);
    row.trust_level = level;
  }

  recordRun(slug: string, outcome: RunOutcome): void {
    const row = this.rows.get(slug);
    if (!row) throw new Error(`skill not found: ${slug}`);
    row.run_count += 1;
    if (!outcome.success) row.fail_count += 1;
    row.last_run_at = new Date().toISOString();
  }
}
