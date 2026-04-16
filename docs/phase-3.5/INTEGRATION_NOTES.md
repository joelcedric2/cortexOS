# Phase 3.5 Integration Notes

## Stub Kill

Deleted `src/skills/_registry-stub.ts` (Agent B's `InMemorySkillRegistry`).
All imports redirected to Agent A's real `src/skills/skill-registry-db.ts`.

### Files modified

| File | Change |
|------|--------|
| `src/skills/install.ts` | Import redirect; `insert()` call adapted: `{id,name,...}` instead of `{slug,...}`; `metadata` replaced with `skill_md_path` |
| `src/skills/runner.ts` | Import redirect; `recordRun()` call changed from `{success,durationMs}` object to `"success"\|"fail"` string; removed `deprecated` trust level check (not in real enum) |
| `src/mcp/skill-tools-wiring.ts` | Replaced `InMemorySkillRegistry` with real `SkillRegistryDB` class |
| `tests/skill-runner.test.ts` | Switched to test helper; adapted seed data to `SkillInsert` shape; `run_count` -> `success_count`; removed deprecated test |
| `tests/skill-install.test.ts` | Switched to test helper; adapted insert calls |
| `tests/skill-mcp-tools.test.ts` | Switched to test helper; `run_count` -> `success_count` |

### API reconciliation

| Stub API | Real API | Resolution |
|----------|----------|------------|
| `insert({slug,...})` | `insert({id, name,...})` | Use slug as both `id` and `name` |
| `recordRun(slug, {success, durationMs})` | `recordRun(id, "success"\|"fail")` | Changed call sites |
| TrustLevel includes `deprecated`, `sandboxed`, `trusted` | TrustLevel: `unvetted\|user-trusted\|system-trusted\|quarantined` | Removed deprecated check; changed test seeds to `user-trusted` |
| SkillRow.`run_count` | SkillRow.`success_count` | Updated all assertions |
| SkillRow.`metadata` | Not present; `skill_md_path` exists | Pass `skill_md_path` instead |

### New files

- `tests/helpers/in-memory-skill-registry.ts` -- test double matching real `SkillRegistryDB` interface

## Test count

- Baseline: 461
- After stub kill: 460 (removed 1 deprecated-trust-level test)
- After DoD test: 464 (added 4 lifecycle tests)
- All passing, 0 failures

## DoD result

PASS. Full lifecycle verified: discover -> install (vet + SKILL.md auto-gen) -> trust promotion -> sandboxed run -> outcome recording. Real SkillRegistryDB with `:memory:` SQLite.

## Quick-scan findings

- **`any` types**: None found in Phase 3.5 source files
- **Silent catches**: 1 in `runner.ts:110` (malformed package.json fall-through) -- intentional and commented
- **`child_process.exec`**: Only in `vet.ts` as a detection pattern (flags exec in vetted skill code) -- correct usage
- **Hardcoded secrets**: None; `discover.ts` reads `GITHUB_TOKEN` from env only
- **tsc --noEmit**: Clean (exit 0)
