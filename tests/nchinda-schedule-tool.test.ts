/**
 * Phase 1.5 — Agent B
 * Tests for the nchinda_schedule MCP tool handler.
 * Uses in-memory CronJobsDB stub + empty apiKey so parseNl takes the
 * deterministic heuristic path.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NchindaTools, type NchindaToolsDeps } from "../src/mcp/nchinda-tools.js";
import { CronJobsDB } from "../src/scheduler/_cron-jobs-db-stub.js";

function makeDeps(): { deps: NchindaToolsDeps; db: CronJobsDB } {
  const db = new CronJobsDB();
  const deps: NchindaToolsDeps = {
    vectorStore: {
      storeMemory: async () => "unused",
      searchMemories: async () => [],
    },
    embedder: { embed: async () => new Array(384).fill(0) },
    cronDb: db,
    parseNlOptions: { apiKey: "" },
  };
  return { deps, db };
}

describe("nchinda_schedule", () => {
  test("'every Friday at 5pm' → cron_expr 0 17 * * 5 + job_id", async () => {
    const { deps, db } = makeDeps();
    const tools = new NchindaTools(deps);
    const result = await tools.schedule({ utterance: "every Friday at 5pm" });
    assert.equal(result.cron_expr, "0 17 * * 5");
    assert.ok(result.job_id.startsWith("cron_"));
    assert.ok(result.confidence >= 0.8);
    assert.ok(typeof result.next_run === "string");
    assert.equal(result.enabled, false);
    const row = db.getById(result.job_id);
    assert.ok(row);
    assert.equal(row?.cron_expr, "0 17 * * 5");
  });

  test("autoEnable=true flips enabled on the persisted row", async () => {
    const { deps, db } = makeDeps();
    const tools = new NchindaTools(deps);
    const result = await tools.schedule({
      utterance: "hourly: check the queue",
      autoEnable: true,
    });
    assert.equal(result.cron_expr, "0 * * * *");
    assert.equal(result.enabled, true);
    assert.equal(db.getById(result.job_id)?.enabled, true);
    assert.equal(result.extractedTask, "check the queue");
  });

  test("createdBy='nchinda_proactive' is persisted", async () => {
    const { deps, db } = makeDeps();
    const tools = new NchindaTools(deps);
    const result = await tools.schedule({
      utterance: "daily at 9am",
      createdBy: "nchinda_proactive",
    });
    assert.equal(db.getById(result.job_id)?.created_by, "nchinda_proactive");
  });

  test("rejects empty utterance", async () => {
    const { deps } = makeDeps();
    const tools = new NchindaTools(deps);
    await assert.rejects(() => tools.schedule({ utterance: "" }));
  });

  test("throws when cronDb dep is missing", async () => {
    const tools = new NchindaTools({
      vectorStore: {
        storeMemory: async () => "unused",
        searchMemories: async () => [],
      },
      embedder: { embed: async () => [] },
      parseNlOptions: { apiKey: "" },
    });
    await assert.rejects(() => tools.schedule({ utterance: "hourly" }), /cronDb/);
  });

  test("low-confidence fallback still produces a valid row", async () => {
    const { deps, db } = makeDeps();
    const tools = new NchindaTools(deps);
    const result = await tools.schedule({
      utterance: "gibberish utterance with no schedule",
    });
    assert.equal(result.cron_expr, "0 * * * *");
    assert.equal(result.confidence, 0.2);
    assert.ok(db.getById(result.job_id));
  });
});
