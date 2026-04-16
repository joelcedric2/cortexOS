/**
 * Tests for the `watch_draft` MCP tool (Phase 13 — writing coach).
 *
 * Covers the enable/disable round-trip, per-app toggles, global toggle,
 * and validation of malformed inputs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  watchDraft,
  InMemoryWatchDraftController,
} from "../src/mcp/watch-draft-tool.js";
import { WATCH_DRAFT_SCHEMA } from "../src/mcp/tool-schema.js";

describe("watch_draft MCP tool", () => {
  it("registers a schema with the expected shape", () => {
    assert.equal(WATCH_DRAFT_SCHEMA.name, "watch_draft");
    assert.deepEqual(WATCH_DRAFT_SCHEMA.inputSchema.required, ["enable"]);
  });

  it("enables then disables a single app", async () => {
    const ctrl = new InMemoryWatchDraftController();
    const r1 = await watchDraft(
      { enable: true, app: "com.apple.mail" },
      { controller: ctrl },
    );
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.enabled, ["com.apple.mail"]);

    const r2 = await watchDraft(
      { enable: false, app: "com.apple.mail" },
      { controller: ctrl },
    );
    assert.deepEqual(r2.enabled, []);
  });

  it("enables multiple apps independently", async () => {
    const ctrl = new InMemoryWatchDraftController();
    await watchDraft({ enable: true, app: "com.apple.mail" }, { controller: ctrl });
    await watchDraft(
      { enable: true, app: "com.tinyspeck.slackmacgap" },
      { controller: ctrl },
    );
    const all = ctrl.enabledApps().sort();
    assert.deepEqual(all, ["com.apple.mail", "com.tinyspeck.slackmacgap"].sort());
  });

  it("global enable (no `app`) returns the default apps", async () => {
    const ctrl = new InMemoryWatchDraftController([
      "com.apple.mail",
      "com.apple.MobileSMS",
    ]);
    const r = await watchDraft({ enable: true }, { controller: ctrl });
    assert.ok(r.enabled.includes("com.apple.mail"));
    assert.ok(r.enabled.includes("com.apple.MobileSMS"));
  });

  it("global disable clears all enabled apps", async () => {
    const ctrl = new InMemoryWatchDraftController(["com.apple.mail"]);
    await watchDraft({ enable: true }, { controller: ctrl });
    await watchDraft({ enable: true, app: "com.apple.Notes" }, { controller: ctrl });
    const r = await watchDraft({ enable: false }, { controller: ctrl });
    assert.deepEqual(r.enabled, []);
  });

  it("rejects malformed input", async () => {
    const ctrl = new InMemoryWatchDraftController();
    await assert.rejects(() =>
      watchDraft({ app: "com.apple.mail" } as unknown, { controller: ctrl }),
    );
    await assert.rejects(() =>
      watchDraft({ enable: "yes" } as unknown, { controller: ctrl }),
    );
  });

  it("default state is OFF (empty enabled list)", () => {
    const ctrl = new InMemoryWatchDraftController();
    assert.deepEqual(ctrl.enabledApps(), []);
  });
});
