/**
 * MCP tool surface for the Phase 12a communications drivers:
 *
 *   Mail:      mail_compose, mail_send, mail_reply, mail_search,
 *              mail_unread_count, mail_archive, mail_flag
 *   Messages:  messages_send, messages_send_group, messages_react,
 *              messages_list_recent, messages_unread_count
 *   Calendar:  calendar_create, calendar_find_gap, calendar_decline,
 *              calendar_list_upcoming
 *
 * All inputs are zod-validated. Irreversible actions fire an
 * escalation callback BEFORE the driver mutates state:
 *   - mail_send                                → always
 *   - messages_send, messages_send_group       → always
 *   - calendar_create with at least 1 attendee → only then
 *
 * Callers inject the escalation function (typically
 * `NchindaCoordination.escalate`). The tool layer records that the
 * confirmation fired in the audit trail and proceeds — Phase 12a
 * treats the escalation as a best-effort notification; gating on the
 * user's answer is Phase 12b scope.
 */
import { z } from "zod";
import type { MailDriver } from "../apps/mail-driver.js";
import type { MessagesDriver } from "../apps/messages-driver.js";
import type { CalendarDriver } from "../apps/calendar-driver.js";

/* ------------------------------------------------------------------ */
/*  Escalation dep                                                     */
/* ------------------------------------------------------------------ */

export interface CommsEscalator {
  (args: {
    question: string;
    level?: "info" | "question" | "blocker" | "ask";
    task_id?: string;
    agent_id?: string;
  }): Promise<{ escalation_id: string }> | { escalation_id: string };
}

/* ------------------------------------------------------------------ */
/*  Dependency bundle                                                  */
/* ------------------------------------------------------------------ */

export interface AppCommsToolDeps {
  mail: MailDriver;
  messages: MessagesDriver;
  calendar: CalendarDriver;
  /**
   * Fired before any irreversible action (send / send-group / invite).
   * Typically wired to `NchindaCoordination.escalate`.
   * Must never throw silently — propagate failures to the caller.
   */
  escalate: CommsEscalator;
}

/* ------------------------------------------------------------------ */
/*  Zod schemas                                                        */
/* ------------------------------------------------------------------ */

const MailComposeInput = z.object({
  to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).max(200_000),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
});

const MailSendInput = z.object({
  draftId: z.string().min(1),
});

const MailReplyInput = z.object({
  messageId: z.string().min(1),
  body: z.string().min(1).max(200_000),
});

const MailSearchInput = z.object({
  query: z.string().min(1).max(1_000),
  limit: z.number().int().min(1).max(200).optional(),
});

const MailUnreadInput = z.object({}).strict();

const MailArchiveInput = z.object({
  messageId: z.string().min(1),
});

const MailFlagInput = z.object({
  messageId: z.string().min(1),
  on: z.boolean(),
});

const MessagesSendInput = z.object({
  to: z.string().min(1).max(256),
  body: z.string().min(1).max(10_000),
  attachments: z.array(z.string().min(1)).max(10).optional(),
});

const MessagesSendGroupInput = z.object({
  chatId: z.string().min(1).max(256),
  body: z.string().min(1).max(10_000),
});

const MessagesReactInput = z.object({
  messageId: z.string().min(1),
  emoji: z.string().min(1).max(16),
});

const MessagesListRecentInput = z
  .object({ limit: z.number().int().min(1).max(200).optional() })
  .strict();

const MessagesUnreadInput = z.object({}).strict();

const CalendarCreateInput = z.object({
  title: z.string().min(1).max(512),
  start: z.coerce.date(),
  end: z.coerce.date(),
  calendar: z.string().min(1).max(128).optional(),
  location: z.string().max(512).optional(),
  notes: z.string().max(10_000).optional(),
  attendees: z.array(z.string().min(1)).max(100).optional(),
});

const CalendarFindGapInput = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  durationMin: z.number().int().min(1).max(60 * 24),
});

const CalendarDeclineInput = z.object({
  eventId: z.string().min(1),
  reason: z.string().max(1_000).optional(),
});

const CalendarListUpcomingInput = z
  .object({ withinMin: z.number().int().min(1).max(60 * 24 * 14).optional() })
  .strict();

export type CommsToolSchemas = {
  mail_compose: z.infer<typeof MailComposeInput>;
  mail_send: z.infer<typeof MailSendInput>;
  mail_reply: z.infer<typeof MailReplyInput>;
  mail_search: z.infer<typeof MailSearchInput>;
  mail_unread_count: z.infer<typeof MailUnreadInput>;
  mail_archive: z.infer<typeof MailArchiveInput>;
  mail_flag: z.infer<typeof MailFlagInput>;
  messages_send: z.infer<typeof MessagesSendInput>;
  messages_send_group: z.infer<typeof MessagesSendGroupInput>;
  messages_react: z.infer<typeof MessagesReactInput>;
  messages_list_recent: z.infer<typeof MessagesListRecentInput>;
  messages_unread_count: z.infer<typeof MessagesUnreadInput>;
  calendar_create: z.infer<typeof CalendarCreateInput>;
  calendar_find_gap: z.infer<typeof CalendarFindGapInput>;
  calendar_decline: z.infer<typeof CalendarDeclineInput>;
  calendar_list_upcoming: z.infer<typeof CalendarListUpcomingInput>;
};

/* ------------------------------------------------------------------ */
/*  Handler class                                                      */
/* ------------------------------------------------------------------ */

export class AppCommsTools {
  constructor(private readonly deps: AppCommsToolDeps) {}

  // -------------------- Mail --------------------

  async mailCompose(raw: unknown) {
    const input = MailComposeInput.parse(raw);
    return this.deps.mail.compose({
      to: input.to,
      subject: input.subject,
      body: input.body,
      ...(input.cc ? { cc: input.cc } : {}),
      ...(input.bcc ? { bcc: input.bcc } : {}),
    });
  }

  async mailSend(raw: unknown) {
    const input = MailSendInput.parse(raw);
    await this.deps.escalate({
      question: `Send the queued mail draft ${input.draftId}?`,
      level: "question",
    });
    return this.deps.mail.send(input.draftId);
  }

  async mailReply(raw: unknown) {
    const input = MailReplyInput.parse(raw);
    // Reply creates a draft (reversible) — no escalation
    return this.deps.mail.reply(input.messageId, input.body);
  }

  async mailSearch(raw: unknown) {
    const input = MailSearchInput.parse(raw);
    return this.deps.mail.search(input.query, input.limit);
  }

  async mailUnreadCount(raw: unknown) {
    MailUnreadInput.parse(raw ?? {});
    return { count: await this.deps.mail.unreadCount() };
  }

  async mailArchive(raw: unknown) {
    const input = MailArchiveInput.parse(raw);
    await this.deps.mail.archive(input.messageId);
    return { ok: true as const };
  }

  async mailFlag(raw: unknown) {
    const input = MailFlagInput.parse(raw);
    await this.deps.mail.flag(input.messageId, input.on);
    return { ok: true as const };
  }

  // -------------------- Messages --------------------

  async messagesSend(raw: unknown) {
    const input = MessagesSendInput.parse(raw);
    await this.deps.escalate({
      question: `Send iMessage to ${input.to}?`,
      level: "question",
    });
    await this.deps.messages.send(
      input.to,
      input.body,
      input.attachments ? { attachments: input.attachments } : undefined,
    );
    return { ok: true as const };
  }

  async messagesSendGroup(raw: unknown) {
    const input = MessagesSendGroupInput.parse(raw);
    await this.deps.escalate({
      question: `Send iMessage to group chat ${input.chatId}?`,
      level: "question",
    });
    await this.deps.messages.sendGroup(input.chatId, input.body);
    return { ok: true as const };
  }

  async messagesReact(raw: unknown) {
    const input = MessagesReactInput.parse(raw);
    await this.deps.messages.react(input.messageId, input.emoji);
    return { ok: true as const };
  }

  async messagesListRecent(raw: unknown) {
    const input = MessagesListRecentInput.parse(raw ?? {});
    return this.deps.messages.listRecent(input.limit);
  }

  async messagesUnreadCount(raw: unknown) {
    MessagesUnreadInput.parse(raw ?? {});
    return { count: await this.deps.messages.unreadCount() };
  }

  // -------------------- Calendar --------------------

  async calendarCreate(raw: unknown) {
    const input = CalendarCreateInput.parse(raw);
    const hasAttendees = (input.attendees?.length ?? 0) > 0;
    if (hasAttendees) {
      await this.deps.escalate({
        question:
          `Create calendar event "${input.title}" and invite ` +
          `${input.attendees!.length} attendee(s)?`,
        level: "question",
      });
    }
    return this.deps.calendar.createEvent({
      title: input.title,
      start: input.start,
      end: input.end,
      ...(input.calendar ? { calendar: input.calendar } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.attendees ? { attendees: input.attendees } : {}),
    });
  }

  async calendarFindGap(raw: unknown) {
    const input = CalendarFindGapInput.parse(raw);
    return this.deps.calendar.findGap({
      from: input.from,
      to: input.to,
      durationMin: input.durationMin,
    });
  }

  async calendarDecline(raw: unknown) {
    const input = CalendarDeclineInput.parse(raw);
    await this.deps.calendar.decline(
      input.eventId,
      input.reason,
    );
    return { ok: true as const };
  }

  async calendarListUpcoming(raw: unknown) {
    const input = CalendarListUpcomingInput.parse(raw ?? {});
    return this.deps.calendar.listUpcoming(input.withinMin);
  }
}

export function createAppCommsTools(
  deps: AppCommsToolDeps,
): AppCommsTools {
  return new AppCommsTools(deps);
}

export {
  MailComposeInput,
  MailSendInput,
  MailReplyInput,
  MailSearchInput,
  MailUnreadInput,
  MailArchiveInput,
  MailFlagInput,
  MessagesSendInput,
  MessagesSendGroupInput,
  MessagesReactInput,
  MessagesListRecentInput,
  MessagesUnreadInput,
  CalendarCreateInput,
  CalendarFindGapInput,
  CalendarDeclineInput,
  CalendarListUpcomingInput,
};
