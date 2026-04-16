/**
 * MCP tool handlers for the Phase-12 "content/utility" native-app drivers
 * (Safari, Notes, Reminders, Music, Finder).
 *
 * Shape:
 *   - zod schemas for every tool input
 *   - thin `AppToolsContent` class that dispatches raw args to the right
 *     driver method and returns plain-object results the MCP server can
 *     JSON-serialise directly
 *
 * Coder 12a ships the "comms" half (Mail, Messages, Calendar) — this
 * module owns the *other* five drivers only. Both can coexist because
 * they don't share state.
 */
import { z } from "zod";

import type {
  SafariDriver,
  OpenTabResult,
  CurrentTab,
  TabInfo,
  BookmarkEntry,
  HistoryHit,
} from "../apps/safari-driver.js";
import type {
  NotesDriver,
  AppendResult,
  CreateResult,
  NoteHit,
} from "../apps/notes-driver.js";
import type {
  RemindersDriver,
  AddReminderResult,
  ReminderHit,
  ReminderPriority,
} from "../apps/reminders-driver.js";
import type { MusicDriver, NowPlaying } from "../apps/music-driver.js";
import type { FinderDriver } from "../apps/finder-driver.js";

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

// --- Safari -------------------------------------------------------------
const SafariOpenTabSchema = z.object({
  url: z.string().min(1).max(4096),
});

const SafariReadCurrentTabSchema = z.object({}).strict();
const SafariListTabsSchema = z.object({}).strict();

const SafariCloseTabSchema = z.object({
  tabId: z.string().min(1).max(128),
});

const SafariListBookmarksSchema = z.object({}).strict();

const SafariSearchHistorySchema = z.object({
  query: z.string().min(1).max(512),
  limit: z.number().int().positive().max(200).optional(),
});

// --- Notes --------------------------------------------------------------
const NotesAppendSchema = z.object({
  noteTitle: z.string().min(1).max(256),
  text: z.string().min(1).max(50_000),
  folder: z.string().min(1).max(128).optional(),
});

const NotesCreateSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().min(0).max(50_000),
  folder: z.string().min(1).max(128).optional(),
});

const NotesSearchSchema = z.object({
  query: z.string().min(1).max(512),
  limit: z.number().int().positive().max(200).optional(),
});

const NotesDeleteSchema = z.object({
  noteId: z.string().min(1).max(128),
});

// --- Reminders ----------------------------------------------------------
const RemindersAddSchema = z.object({
  title: z.string().min(1).max(256),
  dueAt: z.string().datetime().optional(),
  list: z.string().min(1).max(128).optional(),
  notes: z.string().max(10_000).optional(),
  priority: z
    .union([z.literal(0), z.literal(1), z.literal(5), z.literal(9)])
    .optional(),
});

const RemindersCompleteSchema = z.object({
  reminderId: z.string().min(1).max(128),
});

const RemindersListSchema = z.object({
  listName: z.string().min(1).max(128).optional(),
});

const RemindersRemoveSchema = z.object({
  reminderId: z.string().min(1).max(128),
});

// --- Music --------------------------------------------------------------
const MusicPlaySchema = z.object({
  query: z.string().min(1).max(256).optional(),
});

const MusicPauseSchema = z.object({}).strict();
const MusicSkipSchema = z.object({}).strict();
const MusicCurrentlyPlayingSchema = z.object({}).strict();

const MusicQueueSchema = z.object({
  track: z.string().min(1).max(256),
});

const MusicSetVolumeSchema = z.object({
  pct: z.number().min(0).max(100),
});

// --- Finder -------------------------------------------------------------
const FinderRevealSchema = z.object({
  path: z.string().min(1).max(4096),
});

const FinderMoveSchema = z.object({
  from: z.string().min(1).max(4096),
  to: z.string().min(1).max(4096),
});

const FinderRenameSchema = z.object({
  path: z.string().min(1).max(4096),
  newName: z.string().min(1).max(256),
});

const FinderTagSchema = z.object({
  path: z.string().min(1).max(4096),
  tags: z.array(z.string().min(1).max(64)).max(32),
});

const FinderListTagsSchema = z.object({
  path: z.string().min(1).max(4096),
});

const FinderTrashSchema = z.object({
  path: z.string().min(1).max(4096),
});

/* ------------------------------------------------------------------ */
/*  Result envelopes                                                   */
/* ------------------------------------------------------------------ */

export type AppToolOk<T> = { ok: true } & T;
export type AppToolErr = { ok: false; error: string; message?: string };
export type AppToolResult<T> = AppToolOk<T> | AppToolErr;

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

export interface AppToolsContentDeps {
  safari?: SafariDriver;
  notes?: NotesDriver;
  reminders?: RemindersDriver;
  music?: MusicDriver;
  finder?: FinderDriver;
}

/* ------------------------------------------------------------------ */
/*  Impl                                                               */
/* ------------------------------------------------------------------ */

function parse<T>(
  raw: unknown,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; res: AppToolErr } {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    res: { ok: false, error: "invalid-input", message: r.error.message },
  };
}

function missingDriverErr(which: string): AppToolErr {
  return { ok: false, error: `${which}-unavailable` };
}

function wrapErr(where: string, err: unknown): AppToolErr {
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `${where}-failed`, message: msg };
}

export class AppToolsContent {
  constructor(private readonly deps: AppToolsContentDeps) {}

  // ──────────────────────────── Safari ────────────────────────────
  async safariOpenTab(raw: unknown): Promise<AppToolResult<OpenTabResult>> {
    const p = parse(raw, SafariOpenTabSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.safari;
    if (!driver) return missingDriverErr("safari");
    try {
      const r = await driver.openTab(p.data.url);
      return { ok: true, ...r };
    } catch (e) {
      return wrapErr("safari-open-tab", e);
    }
  }

  async safariReadCurrentTab(raw: unknown): Promise<AppToolResult<CurrentTab>> {
    const p = parse(raw ?? {}, SafariReadCurrentTabSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.safari;
    if (!driver) return missingDriverErr("safari");
    try {
      const r = await driver.readCurrentTab();
      return { ok: true, ...r };
    } catch (e) {
      return wrapErr("safari-read-current-tab", e);
    }
  }

  async safariListTabs(raw: unknown): Promise<AppToolResult<{ tabs: TabInfo[] }>> {
    const p = parse(raw ?? {}, SafariListTabsSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.safari;
    if (!driver) return missingDriverErr("safari");
    try {
      const tabs = await driver.listTabs();
      return { ok: true, tabs };
    } catch (e) {
      return wrapErr("safari-list-tabs", e);
    }
  }

  async safariCloseTab(raw: unknown): Promise<AppToolResult<{ tabId: string }>> {
    const p = parse(raw, SafariCloseTabSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.safari;
    if (!driver) return missingDriverErr("safari");
    try {
      await driver.closeTab(p.data.tabId);
      return { ok: true, tabId: p.data.tabId };
    } catch (e) {
      return wrapErr("safari-close-tab", e);
    }
  }

  async safariListBookmarks(
    raw: unknown,
  ): Promise<AppToolResult<{ bookmarks: BookmarkEntry[] }>> {
    const p = parse(raw ?? {}, SafariListBookmarksSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.safari;
    if (!driver) return missingDriverErr("safari");
    try {
      const bookmarks = await driver.listBookmarks();
      return { ok: true, bookmarks };
    } catch (e) {
      return wrapErr("safari-list-bookmarks", e);
    }
  }

  async safariSearchHistory(
    raw: unknown,
  ): Promise<AppToolResult<{ hits: HistoryHit[] }>> {
    const p = parse(raw, SafariSearchHistorySchema);
    if (!p.ok) return p.res;
    const driver = this.deps.safari;
    if (!driver) return missingDriverErr("safari");
    try {
      const hits = await driver.searchHistory(p.data.query, p.data.limit);
      return { ok: true, hits };
    } catch (e) {
      return wrapErr("safari-search-history", e);
    }
  }

  // ──────────────────────────── Notes ─────────────────────────────
  async notesAppend(raw: unknown): Promise<AppToolResult<AppendResult>> {
    const p = parse(raw, NotesAppendSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.notes;
    if (!driver) return missingDriverErr("notes");
    try {
      const opts = p.data.folder !== undefined ? { folder: p.data.folder } : {};
      const r = await driver.append(p.data.noteTitle, p.data.text, opts);
      return { ok: true, ...r };
    } catch (e) {
      return wrapErr("notes-append", e);
    }
  }

  async notesCreate(raw: unknown): Promise<AppToolResult<CreateResult>> {
    const p = parse(raw, NotesCreateSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.notes;
    if (!driver) return missingDriverErr("notes");
    try {
      const opts = p.data.folder !== undefined ? { folder: p.data.folder } : {};
      const r = await driver.create(p.data.title, p.data.body, opts);
      return { ok: true, ...r };
    } catch (e) {
      return wrapErr("notes-create", e);
    }
  }

  async notesSearch(raw: unknown): Promise<AppToolResult<{ hits: NoteHit[] }>> {
    const p = parse(raw, NotesSearchSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.notes;
    if (!driver) return missingDriverErr("notes");
    try {
      const hits = await driver.search(p.data.query, p.data.limit);
      return { ok: true, hits };
    } catch (e) {
      return wrapErr("notes-search", e);
    }
  }

  async notesDelete(raw: unknown): Promise<AppToolResult<{ noteId: string }>> {
    const p = parse(raw, NotesDeleteSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.notes;
    if (!driver) return missingDriverErr("notes");
    try {
      await driver.delete(p.data.noteId);
      return { ok: true, noteId: p.data.noteId };
    } catch (e) {
      return wrapErr("notes-delete", e);
    }
  }

  // ───────────────────────── Reminders ────────────────────────────
  async remindersAdd(
    raw: unknown,
  ): Promise<AppToolResult<AddReminderResult>> {
    const p = parse(raw, RemindersAddSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.reminders;
    if (!driver) return missingDriverErr("reminders");
    try {
      const opts: Parameters<RemindersDriver["add"]>[0] = {
        title: p.data.title,
      };
      if (p.data.dueAt) opts.dueAt = new Date(p.data.dueAt);
      if (p.data.list) opts.list = p.data.list;
      if (p.data.notes) opts.notes = p.data.notes;
      if (p.data.priority !== undefined) {
        opts.priority = p.data.priority as ReminderPriority;
      }
      const r = await driver.add(opts);
      return { ok: true, ...r };
    } catch (e) {
      return wrapErr("reminders-add", e);
    }
  }

  async remindersComplete(
    raw: unknown,
  ): Promise<AppToolResult<{ reminderId: string }>> {
    const p = parse(raw, RemindersCompleteSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.reminders;
    if (!driver) return missingDriverErr("reminders");
    try {
      await driver.complete(p.data.reminderId);
      return { ok: true, reminderId: p.data.reminderId };
    } catch (e) {
      return wrapErr("reminders-complete", e);
    }
  }

  async remindersList(
    raw: unknown,
  ): Promise<AppToolResult<{ reminders: ReminderHit[] }>> {
    const p = parse(raw ?? {}, RemindersListSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.reminders;
    if (!driver) return missingDriverErr("reminders");
    try {
      const reminders = await driver.list(p.data.listName);
      return { ok: true, reminders };
    } catch (e) {
      return wrapErr("reminders-list", e);
    }
  }

  async remindersRemove(
    raw: unknown,
  ): Promise<AppToolResult<{ reminderId: string }>> {
    const p = parse(raw, RemindersRemoveSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.reminders;
    if (!driver) return missingDriverErr("reminders");
    try {
      await driver.remove(p.data.reminderId);
      return { ok: true, reminderId: p.data.reminderId };
    } catch (e) {
      return wrapErr("reminders-remove", e);
    }
  }

  // ──────────────────────────── Music ─────────────────────────────
  async musicPlay(raw: unknown): Promise<AppToolResult<{ track?: string }>> {
    const p = parse(raw ?? {}, MusicPlaySchema);
    if (!p.ok) return p.res;
    const driver = this.deps.music;
    if (!driver) return missingDriverErr("music");
    try {
      const r = await driver.play(p.data.query);
      return { ok: true, ...r };
    } catch (e) {
      return wrapErr("music-play", e);
    }
  }

  async musicPause(raw: unknown): Promise<AppToolResult<{ done: true }>> {
    const p = parse(raw ?? {}, MusicPauseSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.music;
    if (!driver) return missingDriverErr("music");
    try {
      await driver.pause();
      return { ok: true, done: true };
    } catch (e) {
      return wrapErr("music-pause", e);
    }
  }

  async musicSkip(raw: unknown): Promise<AppToolResult<{ done: true }>> {
    const p = parse(raw ?? {}, MusicSkipSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.music;
    if (!driver) return missingDriverErr("music");
    try {
      await driver.skip();
      return { ok: true, done: true };
    } catch (e) {
      return wrapErr("music-skip", e);
    }
  }

  async musicQueue(raw: unknown): Promise<AppToolResult<{ track: string }>> {
    const p = parse(raw, MusicQueueSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.music;
    if (!driver) return missingDriverErr("music");
    try {
      await driver.queue(p.data.track);
      return { ok: true, track: p.data.track };
    } catch (e) {
      return wrapErr("music-queue", e);
    }
  }

  async musicSetVolume(
    raw: unknown,
  ): Promise<AppToolResult<{ pct: number }>> {
    const p = parse(raw, MusicSetVolumeSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.music;
    if (!driver) return missingDriverErr("music");
    try {
      await driver.setVolume(p.data.pct);
      return { ok: true, pct: p.data.pct };
    } catch (e) {
      return wrapErr("music-set-volume", e);
    }
  }

  async musicCurrentlyPlaying(
    raw: unknown,
  ): Promise<AppToolResult<{ nowPlaying: NowPlaying | null }>> {
    const p = parse(raw ?? {}, MusicCurrentlyPlayingSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.music;
    if (!driver) return missingDriverErr("music");
    try {
      const nowPlaying = await driver.currentlyPlaying();
      return { ok: true, nowPlaying };
    } catch (e) {
      return wrapErr("music-currently-playing", e);
    }
  }

  // ──────────────────────────── Finder ────────────────────────────
  async finderReveal(raw: unknown): Promise<AppToolResult<{ path: string }>> {
    const p = parse(raw, FinderRevealSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.finder;
    if (!driver) return missingDriverErr("finder");
    try {
      await driver.reveal(p.data.path);
      return { ok: true, path: p.data.path };
    } catch (e) {
      return wrapErr("finder-reveal", e);
    }
  }

  async finderMove(
    raw: unknown,
  ): Promise<AppToolResult<{ from: string; to: string }>> {
    const p = parse(raw, FinderMoveSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.finder;
    if (!driver) return missingDriverErr("finder");
    try {
      await driver.move(p.data.from, p.data.to);
      return { ok: true, from: p.data.from, to: p.data.to };
    } catch (e) {
      return wrapErr("finder-move", e);
    }
  }

  async finderRename(
    raw: unknown,
  ): Promise<AppToolResult<{ path: string; newName: string }>> {
    const p = parse(raw, FinderRenameSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.finder;
    if (!driver) return missingDriverErr("finder");
    try {
      await driver.rename(p.data.path, p.data.newName);
      return { ok: true, path: p.data.path, newName: p.data.newName };
    } catch (e) {
      return wrapErr("finder-rename", e);
    }
  }

  async finderTag(
    raw: unknown,
  ): Promise<AppToolResult<{ path: string; tags: string[] }>> {
    const p = parse(raw, FinderTagSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.finder;
    if (!driver) return missingDriverErr("finder");
    try {
      await driver.tag(p.data.path, p.data.tags);
      return { ok: true, path: p.data.path, tags: p.data.tags };
    } catch (e) {
      return wrapErr("finder-tag", e);
    }
  }

  async finderListTags(
    raw: unknown,
  ): Promise<AppToolResult<{ path: string; tags: string[] }>> {
    const p = parse(raw, FinderListTagsSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.finder;
    if (!driver) return missingDriverErr("finder");
    try {
      const tags = await driver.listTags(p.data.path);
      return { ok: true, path: p.data.path, tags };
    } catch (e) {
      return wrapErr("finder-list-tags", e);
    }
  }

  async finderTrash(raw: unknown): Promise<AppToolResult<{ path: string }>> {
    const p = parse(raw, FinderTrashSchema);
    if (!p.ok) return p.res;
    const driver = this.deps.finder;
    if (!driver) return missingDriverErr("finder");
    try {
      await driver.trash(p.data.path);
      return { ok: true, path: p.data.path };
    } catch (e) {
      return wrapErr("finder-trash", e);
    }
  }
}
