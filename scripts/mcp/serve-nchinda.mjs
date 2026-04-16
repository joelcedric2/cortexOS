#!/usr/bin/env node
/**
 * Minimal MCP stdio server for Nchinda.
 *
 * Speaks JSON-RPC 2.0 framed as newline-delimited JSON on stdin/stdout.
 *
 * Tools exposed:
 *   nchinda_recall, nchinda_remember, nchinda_schedule, nchinda_research,
 *   nchinda_send, nchinda_broadcast, nchinda_status, nchinda_escalate,
 *   nchinda_ask_peer, nchinda_see, nchinda_rewind, watch_draft
 */

import { createInterface } from "node:readline";

let toolsInstance = null;

async function getTools() {
  if (toolsInstance) return toolsInstance;
  const [
    { NchindaTools },
    { ResearchTool },
    { NchindaCoordination },
    { VectorStore },
    { Embedder },
    { CronJobsDB },
    { EscalationsDB },
    { getAgentRegistry },
    { MessageBus },
  ] = await Promise.all([
    import("../../dist/mcp/nchinda-tools.js"),
    import("../../dist/mcp/research-tool.js"),
    import("../../dist/mcp/nchinda-coordination.js"),
    import("../../dist/memory/vector-store.js"),
    import("../../dist/memory/embedder.js"),
    import("../../dist/scheduler/cron-jobs-db.js"),
    import("../../dist/mcp/escalations-db.js"),
    import("../../dist/registry/agent-registry.js"),
    import("../../dist/communication/message-bus.js"),
  ]);
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error("DATABASE_URL env var is required");

  const store = new VectorStore(connStr);
  await store.initialize();
  const embedder = new Embedder();
  await embedder.initialize();
  const cronDb = new CronJobsDB();
  const escalationsDb = new EscalationsDB();
  const registry = getAgentRegistry();

  const nchindaTools = new NchindaTools({
    vectorStore: store,
    embedder,
    cronDb,
    resolveAgentRole: () => process.env.NCHINDA_AGENT_ROLE,
  });
  const researchTool = new ResearchTool();

  // Coordination tools: Orchestrator wires the live MessageBus / SlotManager
  // by assigning globalThis.NCHINDA_RUNTIME before spawning the server.
  // Absent that, we build a MessageBus with whatever handles are in env.
  const runtime = globalThis.NCHINDA_RUNTIME ?? {};
  const messageBus =
    runtime.messageBus ??
    new MessageBus(runtime.tmux, runtime.slotManager, store);
  const slotMap = runtime.slotMap ?? parseSlotMap(process.env.NCHINDA_SLOTS_JSON);
  const coordination = new NchindaCoordination({
    messageBus,
    registry,
    eventBus: runtime.eventBus,
    escalationsDb,
    resolvePeerSlot: (agent) => slotMap.get(agent.id),
  });

  toolsInstance = { nchindaTools, researchTool, coordination };
  return toolsInstance;
}

function parseSlotMap(raw) {
  const map = new Map();
  if (!raw) return map;
  try {
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number") map.set(k, v);
    }
  } catch {
    // malformed env var — silently ignore; callers get `no-peer` responses.
  }
  return map;
}

async function getToolSchemas() {
  const { NCHINDA_TOOL_SCHEMAS } = await import("../../dist/mcp/tool-schema.js");
  return NCHINDA_TOOL_SCHEMAS;
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: "2.0", id, error: err });
}

async function dispatch(name, args, tools) {
  switch (name) {
    case "nchinda_recall":     return await tools.nchindaTools.recall(args);
    case "nchinda_remember":   return await tools.nchindaTools.remember(args);
    case "nchinda_schedule":   return await tools.nchindaTools.schedule(args);
    case "nchinda_research":   return await tools.researchTool.research(args);
    case "nchinda_send":       return await tools.coordination.send(args);
    case "nchinda_broadcast":  return await tools.coordination.broadcast(args);
    case "nchinda_status":     return tools.coordination.status(args);
    case "nchinda_escalate":   return tools.coordination.escalate(args);
    case "nchinda_ask_peer":   return await tools.coordination.askPeer(args);
    case "nchinda_see": {
      const { nchindaSee } = await import("../../dist/mcp/nchinda-see.js");
      const { buildBrief } = await import("../../dist/perception/vision-brief.js");
      const { ScreenCapturer } = await import("../../dist/perception/screen-capture.js");
      // Runtime-shared capturer (wired by Orchestrator). Fallback: a fresh
      // instance that won't have called `.start()` yet — captureNow() still
      // works independently of the loop.
      const capturer = runtime.screenCapturer ?? new ScreenCapturer();
      return await nchindaSee(args ?? {}, { capturer, brief: buildBrief });
    }
    case "nchinda_look": {
      const { nchindaLook } = await import("../../dist/mcp/nchinda-look.js");
      // Phase 9 — strictly on-demand. No runtime-shared camera; each
      // call opens the AVFoundation session once and closes it.
      return await nchindaLook(args ?? {}, {});
    }
    case "nchinda_rewind": {
      const { nchindaRewind } = await import("../../dist/mcp/nchinda-rewind.js");
      const { ScreenMemoriesDB } = await import("../../dist/perception/screen-memories-db.js");
      // Runtime-shared instances (Orchestrator wires these); fall back to a
      // fresh DB connection against the shared registry when absent. The
      // embedder MUST be shared so int8-quantization / dim matches the
      // screen-memories store.
      const db = runtime.screenMemoriesDb ?? new ScreenMemoriesDB();
      const rewindEmbedder = runtime.rewindEmbedder;
      if (!rewindEmbedder) {
        throw new Error(
          "nchinda_rewind: runtime.rewindEmbedder must be wired (int8 embedding Buffer)",
        );
      }
      return await nchindaRewind(args ?? {}, { db, embedder: rewindEmbedder });
    }
    case "web_search": {
      const { webSearch } = await import("../../dist/tools/web-search.js");
      return await webSearch(args?.query ?? "", {
        limit: args?.limit,
        timeoutMs: args?.timeoutMs,
      });
    }
    case "tool_discovery": {
      const { toolDiscovery } = await import("../../dist/tools/tool-discovery.js");
      return await toolDiscovery(args?.need ?? "", {
        timeoutMs: args?.timeoutMs,
      });
    }
    case "skill_discover":
    case "skill_install":
    case "skill_use":
    case "skill_create": {
      const { getSkillTools } = await import("../../dist/mcp/skill-tools-wiring.js");
      const st = await getSkillTools();
      if (name === "skill_discover") return await st.discover(args);
      if (name === "skill_install") return await st.install(args);
      if (name === "skill_create") return await st.create(args);
      return await st.use(args);
    }
    case "social_send":
    case "social_post": {
      const { SocialTools } = await import("../../dist/mcp/social-tools.js");
      const { SocialDB } = await import("../../dist/social/social-db.js");
      const { createEventBus } = await import("../../dist/ipc/event-bus.js");
      const socialDb = new SocialDB();
      const eventBus = runtime.eventBus ?? createEventBus();
      const drivers = runtime.socialDrivers ?? new Map();
      const st = new SocialTools({ drivers, socialDb, eventBus });
      if (name === "social_send") return await st.send(args);
      return st.post(args);
    }
    case "wm_move_window":
    case "wm_tile":
    case "wm_focus":
    case "wm_space_switch":
    case "wm_list_windows": {
      const { WmTools } = await import("../../dist/mcp/wm-tools.js");
      const wm = runtime.wmTools ?? new WmTools({ driver: runtime.wmDriver });
      if (name === "wm_move_window") return await wm.moveWindow(args);
      if (name === "wm_tile") return await wm.tile(args);
      if (name === "wm_focus") return await wm.focus(args);
      if (name === "wm_space_switch") return await wm.spaceSwitch(args);
      return await wm.listWindows(args);
    }
    // ─── Phase 12 content-app tools (safari/notes/reminders/music/finder) ───
    case "safari_open_tab":
    case "safari_read_current_tab":
    case "safari_list_tabs":
    case "safari_close_tab":
    case "safari_list_bookmarks":
    case "safari_search_history":
    case "notes_append":
    case "notes_create":
    case "notes_search":
    case "notes_delete":
    case "reminders_add":
    case "reminders_complete":
    case "reminders_list":
    case "reminders_remove":
    case "music_play":
    case "music_pause":
    case "music_skip":
    case "music_queue":
    case "music_set_volume":
    case "music_currently_playing":
    case "finder_reveal":
    case "finder_move":
    case "finder_rename":
    case "finder_tag":
    case "finder_list_tags":
    case "finder_trash": {
      const { AppToolsContent } = await import(
        "../../dist/mcp/app-tools-content.js"
      );
      const apps =
        runtime.appToolsContent ??
        new AppToolsContent({
          safari: runtime.safariDriver,
          notes: runtime.notesDriver,
          reminders: runtime.remindersDriver,
          music: runtime.musicDriver,
          finder: runtime.finderDriver,
        });
      switch (name) {
        case "safari_open_tab":          return await apps.safariOpenTab(args);
        case "safari_read_current_tab":  return await apps.safariReadCurrentTab(args);
        case "safari_list_tabs":         return await apps.safariListTabs(args);
        case "safari_close_tab":         return await apps.safariCloseTab(args);
        case "safari_list_bookmarks":    return await apps.safariListBookmarks(args);
        case "safari_search_history":    return await apps.safariSearchHistory(args);
        case "notes_append":             return await apps.notesAppend(args);
        case "notes_create":             return await apps.notesCreate(args);
        case "notes_search":             return await apps.notesSearch(args);
        case "notes_delete":             return await apps.notesDelete(args);
        case "reminders_add":            return await apps.remindersAdd(args);
        case "reminders_complete":       return await apps.remindersComplete(args);
        case "reminders_list":           return await apps.remindersList(args);
        case "reminders_remove":         return await apps.remindersRemove(args);
        case "music_play":               return await apps.musicPlay(args);
        case "music_pause":              return await apps.musicPause(args);
        case "music_skip":               return await apps.musicSkip(args);
        case "music_queue":              return await apps.musicQueue(args);
        case "music_set_volume":         return await apps.musicSetVolume(args);
        case "music_currently_playing":  return await apps.musicCurrentlyPlaying(args);
        case "finder_reveal":            return await apps.finderReveal(args);
        case "finder_move":              return await apps.finderMove(args);
        case "finder_rename":            return await apps.finderRename(args);
        case "finder_tag":               return await apps.finderTag(args);
        case "finder_list_tags":         return await apps.finderListTags(args);
        case "finder_trash":             return await apps.finderTrash(args);
      }
      break;
    }
    // ─── Phase 12a comms-app tools (mail/messages/calendar) ───
    case "mail_compose":
    case "mail_send":
    case "mail_reply":
    case "mail_search":
    case "mail_unread_count":
    case "mail_archive":
    case "mail_flag":
    case "messages_send":
    case "messages_send_group":
    case "messages_react":
    case "messages_list_recent":
    case "messages_unread_count":
    case "calendar_create":
    case "calendar_find_gap":
    case "calendar_decline":
    case "calendar_list_upcoming": {
      const [
        { createAppCommsTools },
        { createMailDriver },
        { createMessagesDriver },
        { createCalendarDriver },
      ] = await Promise.all([
        import("../../dist/mcp/app-tools-comms.js"),
        import("../../dist/apps/mail-driver.js"),
        import("../../dist/apps/messages-driver.js"),
        import("../../dist/apps/calendar-driver.js"),
      ]);
      const mail = runtime.mailDriver ?? createMailDriver({ audit: runtime.auditLog });
      const messages = runtime.messagesDriver ?? createMessagesDriver({ audit: runtime.auditLog });
      const calendar = runtime.calendarDriver ?? createCalendarDriver({ audit: runtime.auditLog });
      const comms = runtime.appCommsTools ?? createAppCommsTools({
        mail,
        messages,
        calendar,
        escalate: runtime.commsEscalator ?? (async (a) => {
          const r = await tools.coordination.escalate(a);
          return { approved: true, escalation_id: r.escalation_id };
        }),
      });
      switch (name) {
        case "mail_compose":          return await comms.mailCompose(args);
        case "mail_send":             return await comms.mailSend(args);
        case "mail_reply":            return await comms.mailReply(args);
        case "mail_search":           return await comms.mailSearch(args);
        case "mail_unread_count":     return await comms.mailUnreadCount(args);
        case "mail_archive":          return await comms.mailArchive(args);
        case "mail_flag":             return await comms.mailFlag(args);
        case "messages_send":         return await comms.messagesSend(args);
        case "messages_send_group":   return await comms.messagesSendGroup(args);
        case "messages_react":        return await comms.messagesReact(args);
        case "messages_list_recent":  return await comms.messagesListRecent(args);
        case "messages_unread_count": return await comms.messagesUnreadCount(args);
        case "calendar_create":       return await comms.calendarCreate(args);
        case "calendar_find_gap":     return await comms.calendarFindGap(args);
        case "calendar_decline":      return await comms.calendarDecline(args);
        case "calendar_list_upcoming":return await comms.calendarListUpcoming(args);
      }
      return null;
    }
    // ─── Phase 10 computer-use tools ───
    case "cu_click":
    case "cu_type":
    case "cu_screenshot":
    case "cu_find_element":
    case "cu_scroll": {
      const { CuTools } = await import("../../dist/mcp/cu-tools.js");
      const { createActuator } = await import("../../dist/computer-use/actuator.js");
      const { Policy } = await import("../../dist/loop/policy.js");
      const actuator = runtime.actuator ?? createActuator({ audit: runtime.audit });
      const cuPolicy = runtime.cuPolicy ?? new Policy();
      const cuGate = runtime.cuEscalationGate ?? {
        requestConfirmation: async (question) => {
          await tools.coordination.escalate({
            question,
            level: "question",
          });
          return true;
        },
      };
      const cu =
        runtime.cuTools ??
        new CuTools({ actuator, policy: cuPolicy, gate: cuGate });
      if (name === "cu_click") return await cu.click(args);
      if (name === "cu_type") return await cu.type(args);
      if (name === "cu_screenshot") return await cu.screenshot(args);
      if (name === "cu_find_element") return await cu.findElement(args);
      return await cu.scroll(args);
    }
    // ─── Phase 13 writing-coach tools ───
    case "watch_draft": {
      const { watchDraft, InMemoryWatchDraftController } = await import(
        "../../dist/mcp/watch-draft-tool.js"
      );
      if (!runtime.watchDraftController) {
        runtime.watchDraftController = new InMemoryWatchDraftController();
      }
      return await watchDraft(args, { controller: runtime.watchDraftController });
    }
    default: {
      const err = new Error(`unknown tool: ${name}`);
      err.isUnknownTool = true;
      throw err;
    }
  }
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "nchinda", version: "0.1.0" },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") {
      if (id !== undefined) reply(id, {});
      return;
    }
    if (method === "tools/list") {
      reply(id, { tools: await getToolSchemas() });
      return;
    }
    if (method === "tools/call") {
      const { name, arguments: args } = params ?? {};
      const tools = await getTools();
      let result;
      try {
        result = await dispatch(name, args, tools);
      } catch (err) {
        if (err && err.isUnknownTool) return replyError(id, -32601, err.message);
        throw err;
      }
      reply(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      return;
    }
    replyError(id, -32601, `method not found: ${method}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    replyError(id, -32000, message);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg && msg.method) void handleRequest(msg);
});
rl.on("close", () => process.exit(0));
