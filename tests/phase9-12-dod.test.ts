/**
 * Phase 9–12 integration DoD smoke — cross-cuts the four merged branches:
 *
 *   P9  — camera bridge + nchinda_look + voice camera-query branch
 *   P10 — computer-use see→plan→act→verify loop with irreversibility escalation
 *   P12a — Mail/Messages/Calendar comms drivers behind MCP tools
 *   P12b — Safari/Notes/Reminders/Finder content drivers, path security
 *
 * Everything uses fakes — no real camera, no real Mail/Calendar, no real
 * accessibility, no AppleScript shell-out. The tests verify the public
 * surfaces exposed by the merge are coherent (shapes, gating, escalation)
 * and that phase-shared files (audit, tool-schema, voice-orchestrator)
 * correctly host every branch's additions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// P9 — nchinda_look
import { nchindaLook } from "../src/mcp/nchinda-look.js";
import type { CameraFrame } from "../src/perception/camera-capture.js";
import { extractIntent } from "../src/voice/intent-extractor.js";

// P10 — computer-use
import {
  runComputerUse,
  type AgentLoopDeps,
  type LoopCapturer,
  type LoopFrame,
  type ObservationBrief,
  type PlanResponse,
  type ProposedAction,
} from "../src/computer-use/agent-loop.js";
import type { Actuator } from "../src/computer-use/actuator.js";

// P12a — comms
import { AppCommsTools } from "../src/mcp/app-tools-comms.js";
import type { MailDriver } from "../src/apps/mail-driver.js";
import type { MessagesDriver } from "../src/apps/messages-driver.js";
import type { CalendarDriver } from "../src/apps/calendar-driver.js";
import { computeGaps } from "../src/apps/calendar-driver.js";

// P12b — content
import { AppToolsContent } from "../src/mcp/app-tools-content.js";
import type { SafariDriver } from "../src/apps/safari-driver.js";
import type { NotesDriver } from "../src/apps/notes-driver.js";
import type { RemindersDriver } from "../src/apps/reminders-driver.js";
import type { FinderDriver } from "../src/apps/finder-driver.js";
import { sanitizePath, PathSecurityError } from "../src/apps/finder-driver.js";

// Schema surface — every merge registered its tools here.
import { NCHINDA_TOOL_SCHEMAS } from "../src/mcp/tool-schema.js";

/* ================================================================ *
 *  Phase 9 — camera look                                            *
 * ================================================================ */

describe("DoD P9 — nchinda_look + voice camera routing", () => {
  it("mocked camera + mocked Sonnet returns description with frame.id", async () => {
    const frame: CameraFrame = {
      id: "p9-dod-frame-1",
      ts: new Date("2026-04-15T12:00:00Z"),
      jpeg_path: "/tmp/p9-dod.jpg",
      width: 1920,
      height: 1080,
      device: "front",
    };

    // The real nchindaLook reads the jpeg from disk via readFile before
    // calling Sonnet. Write a byte so the base64 encode step succeeds.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(frame.jpeg_path, "fake-jpeg");

    const capture = (async () => frame) as typeof import(
      "../src/perception/camera-capture.js"
    ).captureCameraFrame;

    const ocr = async () => ({ text: "COFFEE SHOP MENU" });

    const haikuFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "A coffee shop menu board listing drinks and prices.",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const result = await nchindaLook(
      { question: "what am I looking at", mode: "still" },
      { capture, ocr, haikuFetch, apiKey: "dod-test-key" },
    );

    assert.equal(result.frame!.id, "p9-dod-frame-1", "frame.id round-trips");
    assert.match(result.description, /coffee shop/i);
    assert.equal(result.ocr_text, "COFFEE SHOP MENU");
  });

  it("'what am I looking at' routes to camera-query (not task)", () => {
    const r = extractIntent("what am I looking at");
    assert.equal(r.kind, "camera-query");
    assert.equal(r.confidence, 1);
    assert.match(r.payload?.question ?? "", /looking at/i);
  });

  it("'is that a bird?' routes to camera-query", () => {
    const r = extractIntent("is that a bird?");
    assert.equal(r.kind, "camera-query");
    assert.match(r.payload?.question ?? "", /\?$/);
  });

  it("registers nchinda_look in the canonical MCP tool schema list", () => {
    const names = NCHINDA_TOOL_SCHEMAS.map((s) => s.name);
    assert.ok(names.includes("nchinda_look"), "nchinda_look registered");
    assert.ok(names.includes("nchinda_see"), "nchinda_see still registered");
  });
});

/* ================================================================ *
 *  Phase 10 — computer-use loop                                     *
 * ================================================================ */

function makeLoopFrame(id: string): LoopFrame {
  return {
    id,
    png_path: `/tmp/${id}.png`,
    active_app: "TestApp",
    window_title: "TestWindow",
    ts: new Date(0),
  };
}

class FakeCapturer implements LoopCapturer {
  public calls = 0;
  async captureNow(): Promise<{ ok: true; frame: LoopFrame }> {
    this.calls++;
    return { ok: true, frame: makeLoopFrame(`step-${this.calls}`) };
  }
}

class FakeActuator implements Actuator {
  public actions: string[] = [];
  async click(x: number, y: number, btn?: "left" | "right"): Promise<void> {
    this.actions.push(`click ${x} ${y} ${btn ?? "left"}`);
  }
  async doubleClick(x: number, y: number): Promise<void> {
    this.actions.push(`double ${x} ${y}`);
  }
  async moveTo(x: number, y: number): Promise<void> {
    this.actions.push(`move ${x} ${y}`);
  }
  async type(text: string): Promise<void> {
    this.actions.push(`type ${text}`);
  }
  async scroll(x: number, y: number, dy: number): Promise<void> {
    this.actions.push(`scroll ${x} ${y} ${dy}`);
  }
  async screenshot(): Promise<{ path: string; width: number; height: number }> {
    this.actions.push("screenshot");
    return { path: "/tmp/ss.png", width: 10, height: 20 };
  }
}

function briefFn(): (f: LoopFrame) => Promise<ObservationBrief> {
  return async (f: LoopFrame): Promise<ObservationBrief> => ({
    summary: `observation-of-${f.id}`,
    active_app: f.active_app,
    window_title: f.window_title,
  });
}

function scriptedPlanner(plans: PlanResponse[]): AgentLoopDeps["haikuFetch"] {
  let i = 0;
  return async (): Promise<PlanResponse> => {
    if (i >= plans.length) throw new Error("ran out of scripted plans");
    return plans[i++]!;
  };
}

describe("DoD P10 — runComputerUse happy + escalation", () => {
  it("3 scripted vision steps → outcome:'done' + 2 clicks actuated", async () => {
    const capturer = new FakeCapturer();
    const actuator = new FakeActuator();
    const plans: PlanResponse[] = [
      {
        plan: "look for Save button",
        action: { kind: "click", x: 100, y: 200, reason: "Save btn AX found" },
      },
      {
        plan: "confirm dialog appeared",
        action: { kind: "click", x: 300, y: 400, reason: "OK btn" },
      },
      {
        plan: "done — file saved",
        action: { kind: "done", reason: "file saved" },
      },
    ];
    const deps: AgentLoopDeps = {
      actuator,
      capturer,
      brief: briefFn(),
      policy: { isIrreversible: () => false },
      haikuFetch: scriptedPlanner(plans),
    };
    const result = await runComputerUse(
      { goal: "click Save button" },
      deps,
    );
    assert.equal(result.outcome, "done", `outcome was: ${result.outcome}`);
    assert.equal(result.steps.length, 3);
    // Only the two clicks actuate; `done` is a loop-terminator, not an action.
    assert.deepEqual(actuator.actions, [
      "click 100 200 left",
      "click 300 400 left",
    ]);
  });

  it("irreversible action at step 2 → outcome:'escalated' + zero actuation after escalation", async () => {
    const capturer = new FakeCapturer();
    const actuator = new FakeActuator();
    const plans: PlanResponse[] = [
      // step 0 — safe click
      {
        plan: "open Mail",
        action: { kind: "click", x: 50, y: 50, reason: "Mail icon" },
      },
      // step 1 — irreversible: policy gate should intercept this
      {
        plan: "hit send on draft",
        action: { kind: "click", x: 800, y: 600, reason: "send button" },
      },
      // step 2 — should NEVER run (escalated from step 1)
      {
        plan: "should not be reached",
        action: { kind: "click", x: 1, y: 1 },
      },
    ];

    // The policy decides the SECOND click (send) is irreversible.
    let planSeen = 0;
    const policy = {
      isIrreversible(action: ProposedAction): boolean {
        // The agent-loop calls isIrreversible exactly once per actuation
        // attempt. Count calls: 1st call = step 0 (safe), 2nd = step 1 (send).
        planSeen++;
        return planSeen === 2;
      },
    };

    const deps: AgentLoopDeps = {
      actuator,
      capturer,
      brief: briefFn(),
      policy,
      haikuFetch: scriptedPlanner(plans),
    };

    const result = await runComputerUse({ goal: "send the draft" }, deps);
    assert.equal(result.outcome, "escalated");
    // First step actuated (1 click), second step escalated BEFORE actuation,
    // third plan never consumed.
    assert.deepEqual(actuator.actions, ["click 50 50 left"]);
    assert.equal(
      actuator.actions.length,
      1,
      "zero actuation calls after the escalation point",
    );
    // The loop should have stopped at step 1 (escalation step appended);
    // a third step (the never-reached plan) must NOT appear.
    assert.equal(result.steps.length, 2);
  });

  it("registers cu_* MCP tools in the canonical schema list", () => {
    const names = NCHINDA_TOOL_SCHEMAS.map((s) => s.name);
    for (const cu of [
      "cu_click",
      "cu_type",
      "cu_screenshot",
      "cu_find_element",
      "cu_scroll",
    ]) {
      assert.ok(names.includes(cu), `${cu} registered`);
    }
  });
});

/* ================================================================ *
 *  Phase 12a — comms drivers                                        *
 * ================================================================ */

function makeFakeMail(): {
  driver: MailDriver;
  script: string[];
} {
  const script: string[] = [];
  const driver: MailDriver = {
    async compose(opts) {
      const to = Array.isArray(opts.to) ? opts.to.join(",") : opts.to;
      // Simulate the real driver's osascript invocation — record the call
      // shape so the test can assert on it.
      script.push(`osascript:compose to=${to} subject=${opts.subject}`);
      return { draftId: "draft-42" };
    },
    async send(draftId) {
      script.push(`osascript:send draft=${draftId}`);
      return { messageId: "mid-42" };
    },
    async reply() { return { draftId: "r-1" }; },
    async search() { return []; },
    async unreadCount() { return 0; },
    async archive() {},
    async flag() {},
  };
  return { driver, script };
}

function makeFakeMessages(): MessagesDriver {
  return {
    async send() {},
    async sendGroup() {},
    async react() {},
    async listRecent() { return []; },
    async unreadCount() { return 0; },
  };
}

function makeFakeCalendar(): CalendarDriver {
  return {
    async createEvent() { return { eventId: "evt-1" }; },
    async findGap() { return []; },
    async decline() {},
    async listUpcoming() { return []; },
  };
}

describe("DoD P12a — mail_compose + mail_send escalation + calendar gap", () => {
  it("mail_compose creates draft and records the osascript call", async () => {
    const { driver, script } = makeFakeMail();
    const tools = new AppCommsTools({
      mail: driver,
      messages: makeFakeMessages(),
      calendar: makeFakeCalendar(),
      escalate: async () => {
        throw new Error("escalate should NOT fire on compose (reversible)");
      },
    });
    const r = await tools.mailCompose({
      to: "alice@example.com",
      subject: "Hello",
      body: "Greetings from the DoD smoke.",
    });
    assert.deepEqual(r, { draftId: "draft-42" });
    assert.equal(script.length, 1);
    assert.match(script[0]!, /compose to=alice@example\.com subject=Hello/);
  });

  it("mail_send — EscalationGate denial → NO AppleScript call", async () => {
    const { driver, script } = makeFakeMail();
    const tools = new AppCommsTools({
      mail: driver,
      messages: makeFakeMessages(),
      calendar: makeFakeCalendar(),
      escalate: async () => {
        throw new Error("escalation-denied");
      },
    });
    let failed = false;
    try {
      await tools.mailSend({ draftId: "draft-42" });
    } catch (e) {
      failed = true;
      assert.match(String(e), /escalation-denied/);
    }
    assert.ok(failed, "mailSend must reject when escalation denies");
    assert.equal(
      script.length,
      0,
      "AppleScript must NOT have fired — escalation blocks transmission",
    );
  });

  it("calendar findGap math — 3 busy periods → expected free gaps", () => {
    // Day window 09:00–17:00 UTC with three busy periods.
    const from = new Date("2026-04-15T09:00:00Z");
    const to = new Date("2026-04-15T17:00:00Z");
    const busy = [
      {
        start: new Date("2026-04-15T10:00:00Z"),
        end: new Date("2026-04-15T10:30:00Z"),
      },
      {
        start: new Date("2026-04-15T12:00:00Z"),
        end: new Date("2026-04-15T13:00:00Z"),
      },
      {
        start: new Date("2026-04-15T15:00:00Z"),
        end: new Date("2026-04-15T15:30:00Z"),
      },
    ];
    const gaps = computeGaps(from, to, busy, 30);
    // Expected gaps (each ≥ 30 min):
    //   09:00–10:00 (60 min)
    //   10:30–12:00 (90 min)
    //   13:00–15:00 (120 min)
    //   15:30–17:00 (90 min)
    assert.equal(gaps.length, 4, `got ${gaps.length} gaps`);
    const iso = (d: Date) => d.toISOString().slice(11, 16);
    assert.equal(iso(gaps[0]!.start), "09:00");
    assert.equal(iso(gaps[0]!.end), "10:00");
    assert.equal(iso(gaps[1]!.start), "10:30");
    assert.equal(iso(gaps[1]!.end), "12:00");
    assert.equal(iso(gaps[2]!.start), "13:00");
    assert.equal(iso(gaps[2]!.end), "15:00");
    assert.equal(iso(gaps[3]!.start), "15:30");
    assert.equal(iso(gaps[3]!.end), "17:00");
  });
});

/* ================================================================ *
 *  Phase 12b — content drivers (Safari / Notes / Reminders / Finder) *
 * ================================================================ */

function makeFakeSafari(): { driver: SafariDriver; opened: string[] } {
  const opened: string[] = [];
  const driver: SafariDriver = {
    async openTab(url) {
      opened.push(url);
      return { tabId: "tab-123" };
    },
    async readCurrentTab() {
      return { url: "https://example.com", title: "Example" };
    },
    async listTabs() { return []; },
    async closeTab() {},
    async listBookmarks() { return []; },
    async searchHistory() { return []; },
  };
  return { driver, opened };
}

function makeFakeNotes(): { driver: NotesDriver; appended: string[] } {
  const appended: string[] = [];
  const driver: NotesDriver = {
    async append(title, text) {
      appended.push(`${title}::${text}`);
      return { noteId: "note-1" };
    },
    async create() { return { noteId: "note-new" }; },
    async search() { return []; },
    async delete() {},
  };
  return { driver, appended };
}

function makeFakeReminders(): { driver: RemindersDriver; added: string[] } {
  const added: string[] = [];
  const driver: RemindersDriver = {
    async add(opts) {
      added.push(opts.title);
      return { reminderId: "rem-1" };
    },
    async complete() {},
    async list() { return []; },
    async remove() {},
  };
  return { driver, added };
}

describe("DoD P12b — notes/safari/reminders round-trip + finder path-security", () => {
  it("notes_append + safari_open_tab + reminders_add all round-trip ok", async () => {
    const { driver: safari, opened } = makeFakeSafari();
    const { driver: notes, appended } = makeFakeNotes();
    const { driver: reminders, added } = makeFakeReminders();
    const tools = new AppToolsContent({ safari, notes, reminders });

    const noteRes = await tools.notesAppend({
      noteTitle: "DoD Notes",
      text: "hello phase-12",
    });
    assert.equal(noteRes.ok, true);
    assert.deepEqual(appended, ["DoD Notes::hello phase-12"]);

    const tabRes = await tools.safariOpenTab({ url: "https://example.com/x" });
    assert.equal(tabRes.ok, true);
    assert.deepEqual(opened, ["https://example.com/x"]);

    const remRes = await tools.remindersAdd({ title: "Ship DoD" });
    assert.equal(remRes.ok, true);
    assert.deepEqual(added, ["Ship DoD"]);
  });

  it("finder.sanitizePath — path outside allowed root → PathSecurityError", () => {
    // `/etc/passwd` is not under $HOME; sanitize must throw.
    assert.throws(
      () => sanitizePath("/etc/passwd", { allowedRoot: "/Users/someone" }),
      PathSecurityError,
    );
  });

  it("finder.sanitizePath — symlink escape → PathSecurityError", () => {
    // Fake realpath resolves a path inside $HOME to /etc/passwd.
    const fakeRealpath = (p: string): string => {
      if (p === "/Users/dod/trap") return "/etc/passwd";
      return p;
    };
    assert.throws(
      () =>
        sanitizePath("/Users/dod/trap", {
          allowedRoot: "/Users/dod",
          realpathFn: fakeRealpath,
        }),
      PathSecurityError,
    );
  });

  it("finder_move through AppToolsContent returns structured AppToolErr for escape", async () => {
    // Build a Finder driver that defers to real sanitize inside a fake
    // $HOME. The move call should reject before any AppleScript runs.
    const moves: Array<{ from: string; to: string }> = [];
    const driver: FinderDriver = {
      async reveal() {},
      async move(from, to) {
        // The real MacFinderDriver sanitizes before invoking AppleScript;
        // if we get here with an escaping path, the security layer failed.
        try {
          sanitizePath(from, { allowedRoot: "/Users/dod" });
          sanitizePath(to, { allowedRoot: "/Users/dod" });
        } catch (e) {
          throw e;
        }
        moves.push({ from, to });
      },
      async rename() {},
      async tag() {},
      async listTags() { return []; },
      async trash() {},
    };
    const tools = new AppToolsContent({ finder: driver });
    const res = await tools.finderMove({
      from: "/Users/dod/doc.txt",
      to: "/etc/passwd",
    });
    assert.equal(res.ok, false);
    assert.match((res as { error: string }).error, /finder-move-failed/);
    assert.equal(moves.length, 0, "AppleScript move must NOT have fired");
  });

  it("registers representative P12a+P12b MCP tools in the canonical schema list", () => {
    const names = NCHINDA_TOOL_SCHEMAS.map((s) => s.name);
    // P12a
    assert.ok(names.includes("mail_compose"));
    assert.ok(names.includes("mail_send"));
    assert.ok(names.includes("calendar_find_gap"));
    // P12b
    assert.ok(names.includes("notes_append"));
    assert.ok(names.includes("safari_open_tab"));
    assert.ok(names.includes("reminders_add"));
    assert.ok(names.includes("finder_move"));
  });
});

/* ================================================================ *
 *  Cross-cut — AuditAction union has every phase's variants         *
 * ================================================================ */

describe("DoD cross-cut — AuditAction union", () => {
  it("append accepts every phase's AuditAction variant (compile-time + runtime)", async () => {
    const { AuditLog } = await import("../src/proactivity/audit.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "dod-audit-"));
    try {
      const log = new AuditLog(join(dir, "audit.ndjson"));
      // Every variant introduced by the four branches must be accepted
      // by the AuditAction type. A type-check failure here means the
      // merge lost a branch's variant.
      log.append({ action: "capture", detail: "p8-baseline", ts: new Date() });
      log.append({ action: "camera_capture", detail: "p9", ts: new Date() });
      log.append({ action: "camera_llm", detail: "p9", ts: new Date() });
      log.append({ action: "cu_action", detail: "p10", ts: new Date() });
      log.append({ action: "app_mutation", detail: "p12", ts: new Date() });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
