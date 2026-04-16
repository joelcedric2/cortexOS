import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  surfaceIntent,
  INTENT_SENSOR_NAME,
  type ObservationWriter,
  type ActionDrafter,
  type DraftHandle,
  type IntentSurfaceDeps,
} from "../src/intent/intent-surface.js";
import type { ConvIntent } from "../src/intent/conversation-intent.js";
import type { ProactivityMode } from "../src/proactivity/modes.js";

// ─── Test doubles ───────────────────────────────────────────────────────────

interface InsertedRow {
  sensorName: string;
  observation: string;
  urgency: number;
  data?: Record<string, unknown>;
  sampledAt: Date;
}

function fakeStore(): ObservationWriter & { rows: InsertedRow[] } {
  const rows: InsertedRow[] = [];
  return {
    rows,
    insert(sample) {
      rows.push(sample);
      return rows.length;
    },
  };
}

function fakeRegistry(installed: string[] = []) {
  return {
    get: (id: string) =>
      installed.includes(id)
        ? ({ id, name: id } as unknown as never) // row-ish
        : undefined,
    list: () =>
      installed.map(
        (name) =>
          ({
            id: name,
            name,
            repo_url: null,
            commit_sha: null,
            subpath: null,
            installed_at: "",
            trust_level: "user-trusted",
            preferred_for_tags: "[]",
            success_count: 0,
            fail_count: 0,
            quarantined_at: null,
            skill_md_path: null,
          }) as unknown as never,
      ),
  };
}

function fakeAudit() {
  const entries: Array<{ action: string; detail: string; ts: Date }> = [];
  return {
    entries,
    append(e: { action: string; detail: string; ts: Date }) {
      entries.push(e);
    },
  };
}

function statedIntent(
  partial: Partial<ConvIntent> = {},
): ConvIntent {
  return {
    kind: "stated-intent",
    confidence: 0.85,
    action_candidate: {
      verb: "order",
      object: "Thai food",
      recipients: ["Maya"],
      suggested_tool: "social_send",
    },
    transcript: "I should order Thai for Maya",
    ts: new Date("2026-04-15T10:00:00Z").toISOString(),
    source: "rule",
    ...partial,
  };
}

function depsFor(
  mode: ProactivityMode,
  overrides: Partial<IntentSurfaceDeps> = {},
): {
  deps: IntentSurfaceDeps;
  store: ReturnType<typeof fakeStore>;
  audit: ReturnType<typeof fakeAudit>;
} {
  const store = fakeStore();
  const audit = fakeAudit();
  const deps: IntentSurfaceDeps = {
    store,
    proactivityMode: () => mode,
    audit: audit as unknown as IntentSurfaceDeps["audit"],
    ...overrides,
  };
  return { deps, store, audit };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("surfaceIntent — non-stated-intent kinds are a no-op", () => {
  for (const kind of [
    "question",
    "direct-command",
    "idle-chat",
    "reminder",
  ] as const) {
    it(`${kind} → no surface, no audit`, async () => {
      const { deps, store, audit } = depsFor("volunteer");
      const intent = statedIntent({ kind });
      const r = await surfaceIntent(intent, deps);
      assert.equal(r.surfaced, false);
      assert.equal(r.reason, "not-stated-intent");
      assert.equal(store.rows.length, 0);
      assert.equal(audit.entries.length, 0);
    });
  }
});

describe("surfaceIntent — silent mode", () => {
  it("never surfaces; audits the skip", async () => {
    const { deps, store, audit } = depsFor("silent");
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, false);
    assert.equal(r.reason, "silent-mode");
    assert.equal(store.rows.length, 0);
    assert.equal(audit.entries.length, 1);
    assert.match(audit.entries[0]!.detail, /silent/);
  });
});

describe("surfaceIntent — volunteer mode", () => {
  it("surfaces at urgency 0.4 with 'Offer to execute' label", async () => {
    const { deps, store, audit } = depsFor("volunteer");
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    assert.equal(r.urgency, 0.4);
    assert.equal(store.rows.length, 1);
    const row = store.rows[0]!;
    assert.equal(row.sensorName, INTENT_SENSOR_NAME);
    assert.equal(row.urgency, 0.4);
    assert.match(row.observation, /^Offer to execute:/);
    assert.match(row.observation, /order Thai food/);
    assert.match(row.observation, /Maya/);
    // Audit records routing.
    assert.equal(audit.entries.length, 1);
    assert.match(audit.entries[0]!.detail, /mode=volunteer/);
    assert.match(audit.entries[0]!.detail, /verb=order/);
  });

  it("never calls the drafter in volunteer mode", async () => {
    let drafterCalls = 0;
    const drafter: ActionDrafter = async () => {
      drafterCalls++;
      return null;
    };
    const { deps } = depsFor("volunteer", { drafter });
    await surfaceIntent(statedIntent(), deps);
    assert.equal(drafterCalls, 0);
  });

  it("stores the action_candidate in data for the UI to render", async () => {
    const { deps, store } = depsFor("volunteer");
    await surfaceIntent(statedIntent(), deps);
    const row = store.rows[0]!;
    const ac = row.data?.action_candidate as Record<string, unknown>;
    assert.equal(ac.verb, "order");
    assert.equal(ac.object, "Thai food");
  });
});

describe("surfaceIntent — anticipatory mode", () => {
  it("calls drafter, surfaces at urgency 0.45, stores draft handle", async () => {
    const draft: DraftHandle = { id: "mail-42", tool: "social_send", note: "queued" };
    const drafter: ActionDrafter = async () => draft;
    const { deps, store, audit } = depsFor("anticipatory", { drafter });
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    assert.equal(r.urgency, 0.45);
    assert.equal(r.draftId, "mail-42");
    const row = store.rows[0]!;
    assert.equal(row.urgency, 0.45);
    assert.deepEqual(row.data?.draft, draft);
    assert.match(audit.entries[0]!.detail, /draft=social_send:mail-42/);
  });

  it("still surfaces when drafter throws — error is redacted in audit", async () => {
    const drafter: ActionDrafter = async () => {
      throw new Error("network fetch failed: ECONNREFUSED");
    };
    const { deps, store, audit } = depsFor("anticipatory", { drafter });
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    assert.equal(r.draftId, undefined);
    assert.equal(store.rows.length, 1);
    assert.match(audit.entries[0]!.detail, /draft_error=network/);
    // Raw error text must NOT leak.
    assert.doesNotMatch(audit.entries[0]!.detail, /ECONNREFUSED/);
  });

  it("handles drafter returning null as 'no draft staged'", async () => {
    const drafter: ActionDrafter = async () => null;
    const { deps, store } = depsFor("anticipatory", { drafter });
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    assert.equal(r.draftId, undefined);
    const row = store.rows[0]!;
    assert.equal(row.data?.draft, undefined);
  });
});

describe("surfaceIntent — autonomous mode", () => {
  it("drafts + surfaces at urgency 0.55 with 'Confirm send' label", async () => {
    const draft: DraftHandle = { id: "msg-7", tool: "messages_send" };
    const drafter: ActionDrafter = async () => draft;
    const { deps, store } = depsFor("autonomous", { drafter });
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    assert.equal(r.urgency, 0.55);
    const row = store.rows[0]!;
    assert.equal(row.urgency, 0.55);
    assert.match(row.observation, /^Confirm send:/);
    assert.equal(row.data?.confirm_action, "tap Y to confirm send");
  });

  it("NEVER auto-executes: no drafter-less path sends anything", async () => {
    // Verify that even in autonomous mode, if no drafter is provided, we do
    // NOT fabricate a send. We just surface a confirmation prompt.
    const { deps, store } = depsFor("autonomous"); // no drafter
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    const row = store.rows[0]!;
    // No draft was produced (no drafter), but observation still asks for
    // confirmation — never implies the action was sent.
    assert.equal(row.data?.draft, undefined);
    assert.match(row.observation, /^Confirm send:/);
  });
});

describe("surfaceIntent — registry validation", () => {
  it("surfaces normally when suggested_tool is installed", async () => {
    const registry = fakeRegistry(["social_send"]);
    const { deps, store } = depsFor("volunteer", {
      registry: registry as unknown as IntentSurfaceDeps["registry"],
    });
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    assert.equal(store.rows.length, 1);
  });

  it("surfaces with a note when suggested_tool is NOT installed", async () => {
    const registry = fakeRegistry([]); // nothing installed
    const { deps, store, audit } = depsFor("volunteer", {
      registry: registry as unknown as IntentSurfaceDeps["registry"],
    });
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    const row = store.rows[0]!;
    assert.match(String(row.data?.note), /not installed/);
    assert.match(audit.entries[0]!.detail, /note=/);
  });

  it("is resilient to registry read failures", async () => {
    const registry = {
      get: () => {
        throw new Error("db locked");
      },
      list: () => {
        throw new Error("db locked");
      },
    };
    const { deps, store } = depsFor("volunteer", {
      registry: registry as unknown as IntentSurfaceDeps["registry"],
    });
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, true);
    assert.equal(store.rows.length, 1);
  });
});

describe("surfaceIntent — no action candidate", () => {
  it("still surfaces at low urgency with 'Note to self' label", async () => {
    const { deps, store } = depsFor("volunteer");
    const intent = statedIntent({ action_candidate: undefined });
    const r = await surfaceIntent(intent, deps);
    assert.equal(r.surfaced, true);
    assert.equal(r.urgency, 0.3);
    const row = store.rows[0]!;
    assert.equal(row.urgency, 0.3);
    assert.equal(row.observation, "Note to self");
  });
});

describe("surfaceIntent — store failures", () => {
  it("returns surfaced=false but still audits on insert error", async () => {
    const badStore: ObservationWriter = {
      insert() {
        throw new Error("disk full");
      },
    };
    const audit = fakeAudit();
    const deps: IntentSurfaceDeps = {
      store: badStore,
      proactivityMode: () => "volunteer",
      audit: audit as unknown as IntentSurfaceDeps["audit"],
    };
    const r = await surfaceIntent(statedIntent(), deps);
    assert.equal(r.surfaced, false);
    assert.equal(r.reason, "insert-failed");
    assert.equal(audit.entries.length, 1);
    assert.match(audit.entries[0]!.detail, /insert_error=1/);
  });
});

describe("surfaceIntent — idempotency & clock injection", () => {
  beforeEach(() => {});

  it("uses injected clock for sampledAt", async () => {
    const fixed = new Date("2099-01-02T03:04:05Z");
    const { deps, store } = depsFor("volunteer", { now: () => fixed });
    await surfaceIntent(statedIntent(), deps);
    assert.equal(store.rows[0]!.sampledAt.getTime(), fixed.getTime());
  });
});
