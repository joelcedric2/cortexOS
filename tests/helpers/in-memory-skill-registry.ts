/**
 * In-memory implementation of SkillRegistryDB for tests.
 *
 * Conforms to the same public interface as the real SkillRegistryDB
 * (src/skills/skill-registry-db.ts) but backed by a Map instead of SQLite.
 */
import type {
  TrustLevel,
  SkillRow,
  SkillInsert,
  ListOpts,
} from "../../src/skills/skill-registry-db.js";

export type { TrustLevel, SkillRow, SkillInsert, ListOpts };

export class InMemorySkillRegistry {
  private readonly rows = new Map<string, SkillRow>();

  insert(skill: SkillInsert): SkillRow {
    if (this.rows.has(skill.id)) {
      throw new Error(`skill already exists: ${skill.id}`);
    }
    const row: SkillRow = {
      id: skill.id,
      name: skill.name,
      repo_url: skill.repo_url ?? null,
      commit_sha: skill.commit_sha ?? null,
      subpath: skill.subpath ?? null,
      installed_at: new Date().toISOString(),
      trust_level: skill.trust_level ?? "unvetted",
      preferred_for_tags: JSON.stringify(skill.preferred_for_tags ?? []),
      success_count: 0,
      fail_count: 0,
      quarantined_at: null,
      skill_md_path: skill.skill_md_path ?? null,
    };
    this.rows.set(skill.id, row);
    return row;
  }

  get(id: string): SkillRow | undefined {
    return this.rows.get(id);
  }

  list(opts?: ListOpts): SkillRow[] {
    const limit = opts?.limit ?? 100;
    let rows = [...this.rows.values()];
    if (opts?.trust_level) {
      rows = rows.filter((r) => r.trust_level === opts.trust_level);
    }
    return rows.slice(0, limit);
  }

  setTrustLevel(id: string, level: TrustLevel): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`skill not found: ${id}`);
    row.trust_level = level;
    if (level === "quarantined") {
      row.quarantined_at = new Date().toISOString();
    }
  }

  recordRun(id: string, outcome: "success" | "fail"): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`skill not found: ${id}`);
    if (outcome === "success") {
      row.success_count += 1;
    } else {
      row.fail_count += 1;
    }
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  close(): void {
    // no-op for in-memory
  }
}
