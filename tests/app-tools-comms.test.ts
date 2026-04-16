/**
 * Tests for src/mcp/app-tools-comms.ts — Phase 12a.
 *
 * Covers:
 *   - MCP round-trip (every operation calls the expected driver method)
 *   - Escalation fires before mail_send, messages_send, messages_send_group,
 *     and calendar_create with attendees; does NOT fire otherwise
 *   - zod rejection on bad inputs
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createAppCommsTools,
  type AppCommsToolDeps,
  type CommsEscalator,
} from "../src/mcp/app-tools-comms.js";
import type {
  MailDriver,
  MailSearchHit,
} from "../src/apps/mail-driver.js";
import type {
  MessagesDriver,
  MessagesRecent,
} from "../src/apps/messages-driver.js";
import type {
  CalendarDriver,
  CalendarGap,
  CalendarUpcoming,
} from "../src/apps/calendar-driver.js";

/* ------------------------------------------------------------------ */
/*  Fakes                                                              */
/* ------------------------------------------------------------------ */

interface Call {
  name: string;
  args: unknown[];
}

function makeFakeMail(): { driver: MailDriver; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: string, args: unknown[]) => calls.push({ name, args });
  const driver: MailDriver = {
    compose: async (opts) => {
      rec("compose", [opts]);
      return { draftId: "d1" };
    },
    send: async (id) => {
      rec("send", [id]);
      return { messageId: "m1" };
    },
    reply: async (mid, body) => {
      rec("reply", [mid, body]);
      return { draftId: "dr1" };
    },
    search: async (q, limit) => {
      rec("search", [q, limit]);
      const hits: MailSearchHit[] = [
        { id: "h1", from: "a@x", subject: "s", snippet: "sn", ts: "t" },
      ];
      return hits;
    },
    unreadCount: async () => {
      rec("unreadCount", []);
      return 3;
    },
    archive: async (mid) => {
      rec("archive", [mid]);
    },
    flag: async (mid, on) => {
      rec("flag", [mid, on]);
    },
  };
  return { driver, calls };
}

function makeFakeMessages(): { driver: MessagesDriver; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: string, args: unknown[]) => calls.push({ name, args });
  const driver: MessagesDriver = {
    send: async (to, body, opts) => {
      rec("send", [to, body, opts]);
    },
    sendGroup: async (cid, body) => {
      rec("sendGroup", [cid, body]);
    },
    react: async (mid, emoji) => {
      rec("react", [mid, emoji]);
    },
    listRecent: async (limit) => {
      rec("listRecent", [limit]);
      const rows: MessagesRecent[] = [
        { id: "m1", chat: "c1", from: "a", body: "hi", ts: "t" },
      ];
      return rows;
    },
    unreadCount: async () => {
      rec("unreadCount", []);
      return 5;
    },
  };
  return { driver, calls };
}

function makeFakeCalendar(): { driver: CalendarDriver; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: string, args: unknown[]) => calls.push({ name, args });
  const driver: CalendarDriver = {
    createEvent: async (opts) => {
      rec("createEvent", [opts]);
      return { eventId: "e1" };
    },
    findGap: async (opts) => {
      rec("findGap", [opts]);
      const gaps: CalendarGap[] = [
        {
          start: new Date("2026-04-15T09:00:00Z"),
          end: new Date("2026-04-15T10:00:00Z"),
        },
      ];
      return gaps;
    },
    decline: async (id, reason) => {
      rec("decline", [id, reason]);
    },
    listUpcoming: async (within) => {
      rec("listUpcoming", [within]);
      const rows: CalendarUpcoming[] = [
        {
          id: "u1",
          title: "Standup",
          start: new Date("2026-04-15T09:00:00Z"),
          end: new Date("2026-04-15T09:30:00Z"),
        },
      ];
      return rows;
    },
  };
  return { driver, calls };
}

interface EscalatorRecorder {
  fn: CommsEscalator;
  calls: Array<{ question: string; level?: string }>;
  shouldThrow?: boolean;
  approved?: boolean; // defaults true
}

function makeEscalator(): EscalatorRecorder {
  const calls: EscalatorRecorder["calls"] = [];
  const rec: EscalatorRecorder = {
    calls,
    fn: async ({ question, level }) => {
      calls.push({ question, ...(level ? { level } : {}) });
      if (rec.shouldThrow) throw new Error("user rejected");
      return {
        approved: rec.approved ?? true,
        escalation_id: `esc-${calls.length}`,
      };
    },
  };
  return rec;
}

interface Harness {
  tools: ReturnType<typeof createAppCommsTools>;
  mail: Call[];
  messages: Call[];
  calendar: Call[];
  escalator: EscalatorRecorder;
}

function buildHarness(): Harness {
  const mail = makeFakeMail();
  const messages = makeFakeMessages();
  const calendar = makeFakeCalendar();
  const escalator = makeEscalator();
  const deps: AppCommsToolDeps = {
    mail: mail.driver,
    messages: messages.driver,
    calendar: calendar.driver,
    escalate: escalator.fn,
  };
  return {
    tools: createAppCommsTools(deps),
    mail: mail.calls,
    messages: messages.calls,
    calendar: calendar.calls,
    escalator,
  };
}

/* ------------------------------------------------------------------ */
/*  Round-trip: every operation delegates                               */
/* ------------------------------------------------------------------ */

describe("AppCommsTools — mail round-trip", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });

  it("mail_compose calls driver.compose and returns {draftId}", async () => {
    const r = await h.tools.mailCompose({
      to: "a@x.com",
      subject: "Hi",
      body: "there",
    });
    assert.deepEqual(r, { draftId: "d1" });
    assert.equal(h.mail.length, 1);
    assert.equal(h.mail[0].name, "compose");
    assert.equal(h.escalator.calls.length, 0, "compose is reversible");
  });

  it("mail_send escalates BEFORE driver.send fires", async () => {
    // record order of operations
    const order: string[] = [];
    const mail = makeFakeMail();
    mail.driver.send = async (id) => {
      order.push(`send:${id}`);
      return { messageId: "m1" };
    };
    const esc = makeEscalator();
    esc.fn = async (a) => {
      order.push("escalate");
      esc.calls.push({ question: a.question, level: a.level });
      return { approved: true, escalation_id: "x" };
    };
    const tools = createAppCommsTools({
      mail: mail.driver,
      messages: makeFakeMessages().driver,
      calendar: makeFakeCalendar().driver,
      escalate: esc.fn,
    });
    await tools.mailSend({ draftId: "d9" });
    assert.deepEqual(order, ["escalate", "send:d9"]);
    assert.match(esc.calls[0].question, /Send the queued mail draft d9\?/);
  });

  it("mail_reply does NOT escalate (creates reversible draft)", async () => {
    await h.tools.mailReply({ messageId: "m1", body: "ty!" });
    assert.equal(h.mail[0].name, "reply");
    assert.equal(h.escalator.calls.length, 0);
  });

  it("mail_search forwards query + limit", async () => {
    const r = await h.tools.mailSearch({ query: "hi", limit: 5 });
    assert.equal(r.length, 1);
    assert.deepEqual(h.mail[0].args, ["hi", 5]);
    assert.equal(h.escalator.calls.length, 0);
  });

  it("mail_unread_count returns {count}", async () => {
    const r = await h.tools.mailUnreadCount({});
    assert.deepEqual(r, { count: 3 });
  });

  it("mail_archive + mail_flag delegate and do NOT escalate", async () => {
    await h.tools.mailArchive({ messageId: "a1" });
    await h.tools.mailFlag({ messageId: "f1", on: true });
    assert.equal(h.mail[0].name, "archive");
    assert.deepEqual(h.mail[1].args, ["f1", true]);
    assert.equal(h.escalator.calls.length, 0);
  });
});

describe("AppCommsTools — messages round-trip", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });

  it("messages_send escalates BEFORE send", async () => {
    const order: string[] = [];
    const messages = makeFakeMessages();
    messages.driver.send = async (to, body) => {
      order.push(`send:${to}`);
      void body;
    };
    const esc = makeEscalator();
    esc.fn = async (a) => {
      order.push("escalate");
      esc.calls.push({ question: a.question });
      return { approved: true, escalation_id: "e" };
    };
    const tools = createAppCommsTools({
      mail: makeFakeMail().driver,
      messages: messages.driver,
      calendar: makeFakeCalendar().driver,
      escalate: esc.fn,
    });
    await tools.messagesSend({ to: "+1555", body: "hi" });
    assert.deepEqual(order, ["escalate", "send:+1555"]);
    assert.match(esc.calls[0].question, /iMessage to \+1555\?/);
  });

  it("messages_send_group escalates BEFORE sendGroup", async () => {
    await h.tools.messagesSendGroup({ chatId: "c42", body: "team!" });
    assert.equal(h.escalator.calls.length, 1);
    assert.match(h.escalator.calls[0].question, /group chat c42/);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].name, "sendGroup");
  });

  it("messages_send aborts when escalation throws", async () => {
    h.escalator.shouldThrow = true;
    await assert.rejects(
      () => h.tools.messagesSend({ to: "+1", body: "x" }),
      /user rejected/,
    );
    assert.equal(h.messages.length, 0);
  });

  it("messages_react does NOT escalate", async () => {
    await h.tools.messagesReact({ messageId: "m1", emoji: "❤️" });
    assert.equal(h.escalator.calls.length, 0);
    assert.equal(h.messages[0].name, "react");
  });

  it("messages_list_recent + messages_unread_count forward", async () => {
    const rows = await h.tools.messagesListRecent({ limit: 5 });
    assert.equal(rows.length, 1);
    const unread = await h.tools.messagesUnreadCount({});
    assert.deepEqual(unread, { count: 5 });
    assert.equal(h.escalator.calls.length, 0);
  });
});

describe("AppCommsTools — calendar round-trip", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });

  it("calendar_create WITHOUT attendees does NOT escalate", async () => {
    await h.tools.calendarCreate({
      title: "focus",
      start: "2026-04-15T09:00:00",
      end: "2026-04-15T10:00:00",
    });
    assert.equal(h.calendar.length, 1);
    assert.equal(h.escalator.calls.length, 0);
  });

  it("calendar_create WITH attendees escalates BEFORE createEvent", async () => {
    const order: string[] = [];
    const cal = makeFakeCalendar();
    cal.driver.createEvent = async () => {
      order.push("createEvent");
      return { eventId: "e1" };
    };
    const esc = makeEscalator();
    esc.fn = async (a) => {
      order.push("escalate");
      esc.calls.push({ question: a.question });
      return { approved: true, escalation_id: "e" };
    };
    const tools = createAppCommsTools({
      mail: makeFakeMail().driver,
      messages: makeFakeMessages().driver,
      calendar: cal.driver,
      escalate: esc.fn,
    });
    await tools.calendarCreate({
      title: "sync",
      start: "2026-04-15T09:00:00",
      end: "2026-04-15T10:00:00",
      attendees: ["a@x.com", "b@x.com"],
    });
    assert.deepEqual(order, ["escalate", "createEvent"]);
    assert.match(esc.calls[0].question, /invite 2 attendee/);
  });

  it("calendar_find_gap forwards args and does NOT escalate", async () => {
    const r = await h.tools.calendarFindGap({
      from: "2026-04-15T09:00:00",
      to: "2026-04-15T17:00:00",
      durationMin: 30,
    });
    assert.equal(r.length, 1);
    assert.equal(h.calendar[0].name, "findGap");
    assert.equal(h.escalator.calls.length, 0);
  });

  it("calendar_decline forwards reason", async () => {
    await h.tools.calendarDecline({ eventId: "e1", reason: "sick" });
    assert.deepEqual(h.calendar[0].args, ["e1", "sick"]);
    assert.equal(h.escalator.calls.length, 0);
  });

  it("calendar_list_upcoming forwards withinMin", async () => {
    const rows = await h.tools.calendarListUpcoming({ withinMin: 120 });
    assert.equal(rows.length, 1);
    assert.deepEqual(h.calendar[0].args, [120]);
    assert.equal(h.escalator.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  Escalation denial — the gate MUST skip the driver mutation        */
/* ------------------------------------------------------------------ */

describe("AppCommsTools — escalation denial blocks the mutation", () => {
  it("mail_send returns {ok:false, reason:'user-denied'} + no driver.send fires", async () => {
    const h = buildHarness();
    h.escalator.approved = false;
    const result = await h.tools.mailSend({ draftId: "d9" });
    assert.deepEqual(result, { ok: false, reason: "user-denied" });
    // Exactly zero driver calls — escalate was called, but send was NOT.
    assert.equal(h.escalator.calls.length, 1);
    assert.equal(h.mail.length, 0);
  });

  it("messages_send denied → no driver.send fires", async () => {
    const h = buildHarness();
    h.escalator.approved = false;
    const result = await h.tools.messagesSend({ to: "+1555", body: "hi" });
    assert.deepEqual(result, { ok: false, reason: "user-denied" });
    assert.equal(h.escalator.calls.length, 1);
    assert.equal(h.messages.length, 0);
  });

  it("messages_send_group denied → no driver.sendGroup fires", async () => {
    const h = buildHarness();
    h.escalator.approved = false;
    const result = await h.tools.messagesSendGroup({
      chatId: "c42",
      body: "team!",
    });
    assert.deepEqual(result, { ok: false, reason: "user-denied" });
    assert.equal(h.escalator.calls.length, 1);
    assert.equal(h.messages.length, 0);
  });

  it("calendar_create with attendees denied → no driver.createEvent fires", async () => {
    const h = buildHarness();
    h.escalator.approved = false;
    const result = await h.tools.calendarCreate({
      title: "sync",
      start: "2026-04-15T09:00:00",
      end: "2026-04-15T10:00:00",
      attendees: ["a@x.com"],
    });
    assert.deepEqual(result, { ok: false, reason: "user-denied" });
    assert.equal(h.escalator.calls.length, 1);
    assert.equal(h.calendar.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/*  zod rejection on bad inputs                                        */
/* ------------------------------------------------------------------ */

describe("AppCommsTools — zod rejections", () => {
  let h: Harness;
  beforeEach(() => { h = buildHarness(); });

  it("mail_compose rejects empty to/subject/body", async () => {
    await assert.rejects(
      () => h.tools.mailCompose({ to: "", subject: "s", body: "b" }),
    );
    await assert.rejects(
      () => h.tools.mailCompose({ to: "a@x", subject: "", body: "b" }),
    );
    await assert.rejects(
      () => h.tools.mailCompose({ to: "a@x", subject: "s", body: "" }),
    );
  });

  it("mail_send rejects empty draftId", async () => {
    await assert.rejects(() => h.tools.mailSend({ draftId: "" }));
  });

  it("mail_search rejects out-of-range limit", async () => {
    await assert.rejects(
      () => h.tools.mailSearch({ query: "x", limit: 0 }),
    );
    await assert.rejects(
      () => h.tools.mailSearch({ query: "x", limit: 9999 }),
    );
  });

  it("messages_send rejects empty body and missing to", async () => {
    await assert.rejects(() => h.tools.messagesSend({ to: "+1", body: "" }));
    await assert.rejects(() => h.tools.messagesSend({ body: "x" } as never));
  });

  it("messages_send rejects >10 attachments", async () => {
    await assert.rejects(() =>
      h.tools.messagesSend({
        to: "+1",
        body: "x",
        attachments: Array.from({ length: 11 }, (_, i) => `f${i}.png`),
      }),
    );
  });

  it("calendar_create rejects missing start/end and invalid dates", async () => {
    await assert.rejects(() =>
      h.tools.calendarCreate({
        title: "x",
        start: "2026-04-15T09:00:00",
      } as never),
    );
    await assert.rejects(() =>
      h.tools.calendarCreate({
        title: "x",
        start: "not-a-date",
        end: "2026-04-15T10:00:00",
      }),
    );
  });

  it("calendar_find_gap rejects zero/negative durationMin", async () => {
    await assert.rejects(() =>
      h.tools.calendarFindGap({
        from: "2026-04-15T09:00:00",
        to: "2026-04-15T10:00:00",
        durationMin: 0,
      }),
    );
  });

  it("calendar_list_upcoming rejects withinMin beyond 14 days", async () => {
    await assert.rejects(() =>
      h.tools.calendarListUpcoming({ withinMin: 60 * 24 * 30 }),
    );
  });

  it("rejects unexpected keys on strict schemas (list_recent / unread_count)", async () => {
    await assert.rejects(() =>
      h.tools.messagesListRecent({ limit: 5, extra: true } as never),
    );
    await assert.rejects(() =>
      h.tools.mailUnreadCount({ mystery: 1 } as never),
    );
  });
});
