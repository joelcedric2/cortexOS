/**
 * Tests for Phase-12 content-app MCP tools (src/mcp/app-tools-content.ts).
 *
 * Uses stub drivers that record calls. Asserts:
 *   • Input validation returns `{ok:false, error:"invalid-input"}`
 *   • Missing driver returns `{ok:false, error:"<app>-unavailable"}`
 *   • Driver errors are caught and wrapped into an ok=false envelope
 *   • Happy-path round-trips forward the right args to the driver
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { AppToolsContent } from "../src/mcp/app-tools-content.js";
import type {
  SafariDriver,
  OpenTabResult,
  CurrentTab,
  TabInfo,
  BookmarkEntry,
  HistoryHit,
} from "../src/apps/safari-driver.js";
import type {
  NotesDriver,
  AppendResult,
  CreateResult,
  NoteHit,
  AppendOptions,
  CreateOptions,
} from "../src/apps/notes-driver.js";
import type {
  RemindersDriver,
  AddReminderResult,
  ReminderHit,
  AddReminderOptions,
} from "../src/apps/reminders-driver.js";
import type { MusicDriver, NowPlaying } from "../src/apps/music-driver.js";
import type { FinderDriver } from "../src/apps/finder-driver.js";

// ─── Stub drivers ─────────────────────────────────────────────────────

interface SafariStub extends SafariDriver {
  calls: string[];
}
function makeSafari(): SafariStub {
  const calls: string[] = [];
  return {
    calls,
    async openTab(u: string): Promise<OpenTabResult> {
      calls.push(`openTab ${u}`);
      return { tabId: "TAB-1" };
    },
    async readCurrentTab(): Promise<CurrentTab> {
      calls.push("readCurrentTab");
      return { url: "https://x", title: "X" };
    },
    async listTabs(): Promise<TabInfo[]> {
      calls.push("listTabs");
      return [{ id: "1", url: "https://x", title: "X", window: 1 }];
    },
    async closeTab(id: string): Promise<void> {
      calls.push(`closeTab ${id}`);
    },
    async listBookmarks(): Promise<BookmarkEntry[]> {
      calls.push("listBookmarks");
      return [{ url: "https://x", title: "X" }];
    },
    async searchHistory(q: string, lim?: number): Promise<HistoryHit[]> {
      calls.push(`searchHistory ${q} ${lim ?? ""}`);
      return [{ url: "https://x", title: "X", ts: new Date(0) }];
    },
  };
}

interface NotesStub extends NotesDriver {
  calls: string[];
}
function makeNotes(failDelete = false): NotesStub {
  const calls: string[] = [];
  return {
    calls,
    async append(t: string, text: string, opts?: AppendOptions): Promise<AppendResult> {
      calls.push(`append ${t} | ${text} | ${opts?.folder ?? ""}`);
      return { noteId: "N-1" };
    },
    async create(t: string, b: string, opts?: CreateOptions): Promise<CreateResult> {
      calls.push(`create ${t} | ${b} | ${opts?.folder ?? ""}`);
      return { noteId: "N-2" };
    },
    async search(q: string, lim?: number): Promise<NoteHit[]> {
      calls.push(`search ${q} ${lim ?? ""}`);
      return [];
    },
    async delete(id: string): Promise<void> {
      calls.push(`delete ${id}`);
      if (failDelete) throw new Error("user declined");
    },
  };
}

interface RemindersStub extends RemindersDriver {
  calls: string[];
  lastAdd?: AddReminderOptions;
}
function makeReminders(): RemindersStub {
  const stub: RemindersStub = {
    calls: [] as string[],
    async add(opts: AddReminderOptions): Promise<AddReminderResult> {
      stub.calls.push("add");
      stub.lastAdd = opts;
      return { reminderId: "R-1" };
    },
    async complete(id: string): Promise<void> {
      stub.calls.push(`complete ${id}`);
    },
    async list(name?: string): Promise<ReminderHit[]> {
      stub.calls.push(`list ${name ?? ""}`);
      return [];
    },
    async remove(id: string): Promise<void> {
      stub.calls.push(`remove ${id}`);
    },
  };
  return stub;
}

interface MusicStub extends MusicDriver {
  calls: string[];
}
function makeMusic(): MusicStub {
  const calls: string[] = [];
  return {
    calls,
    async play(q?: string): Promise<{ track?: string }> {
      calls.push(`play ${q ?? ""}`);
      return q ? { track: "T" } : {};
    },
    async pause(): Promise<void> {
      calls.push("pause");
    },
    async skip(): Promise<void> {
      calls.push("skip");
    },
    async queue(t: string): Promise<void> {
      calls.push(`queue ${t}`);
    },
    async setVolume(v: number): Promise<void> {
      calls.push(`setVolume ${v}`);
    },
    async currentlyPlaying(): Promise<NowPlaying | null> {
      calls.push("cp");
      return null;
    },
  };
}

interface FinderStub extends FinderDriver {
  calls: string[];
}
function makeFinder(failTrash = false): FinderStub {
  const calls: string[] = [];
  return {
    calls,
    async reveal(p: string): Promise<void> { calls.push(`reveal ${p}`); },
    async move(a: string, b: string): Promise<void> { calls.push(`move ${a} ${b}`); },
    async rename(p: string, n: string): Promise<void> { calls.push(`rename ${p} ${n}`); },
    async tag(p: string, tags: string[]): Promise<void> { calls.push(`tag ${p} ${tags.join(",")}`); },
    async listTags(p: string): Promise<string[]> {
      calls.push(`listTags ${p}`);
      return ["Work"];
    },
    async trash(p: string): Promise<void> {
      calls.push(`trash ${p}`);
      if (failTrash) throw new Error("user declined escalation");
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("AppToolsContent — invalid input", () => {
  test("safari_open_tab rejects missing url", async () => {
    const apps = new AppToolsContent({ safari: makeSafari() });
    const r = await apps.safariOpenTab({});
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, "invalid-input");
  });

  test("notes_append rejects empty title", async () => {
    const apps = new AppToolsContent({ notes: makeNotes() });
    const r = await apps.notesAppend({ noteTitle: "", text: "x" });
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, "invalid-input");
  });

  test("reminders_add rejects bad priority", async () => {
    const apps = new AppToolsContent({ reminders: makeReminders() });
    const r = await apps.remindersAdd({ title: "x", priority: 7 });
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, "invalid-input");
  });

  test("music_set_volume rejects out-of-range", async () => {
    const apps = new AppToolsContent({ music: makeMusic() });
    const r = await apps.musicSetVolume({ pct: 200 });
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, "invalid-input");
  });
});

describe("AppToolsContent — missing driver", () => {
  test("returns <app>-unavailable", async () => {
    const apps = new AppToolsContent({});
    const r1 = await apps.safariListTabs({});
    assert.deepEqual(r1, { ok: false, error: "safari-unavailable" });
    const r2 = await apps.notesSearch({ query: "x" });
    assert.deepEqual(r2, { ok: false, error: "notes-unavailable" });
    const r3 = await apps.remindersList({});
    assert.deepEqual(r3, { ok: false, error: "reminders-unavailable" });
    const r4 = await apps.musicPlay({});
    assert.deepEqual(r4, { ok: false, error: "music-unavailable" });
    const r5 = await apps.finderReveal({ path: "/tmp/x" });
    assert.deepEqual(r5, { ok: false, error: "finder-unavailable" });
  });
});

describe("AppToolsContent — driver errors", () => {
  test("notes_delete wraps user-declined error", async () => {
    const notes = makeNotes(true);
    const apps = new AppToolsContent({ notes });
    const r = await apps.notesDelete({ noteId: "N-9" });
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, "notes-delete-failed");
    assert.match(String((r as { message?: string }).message), /user declined/);
  });

  test("finder_trash wraps driver error", async () => {
    const finder = makeFinder(true);
    const apps = new AppToolsContent({ finder });
    const r = await apps.finderTrash({ path: "/tmp/x" });
    assert.equal(r.ok, false);
    assert.equal((r as { error: string }).error, "finder-trash-failed");
  });
});

describe("AppToolsContent — happy paths", () => {
  test("safari round-trips", async () => {
    const safari = makeSafari();
    const apps = new AppToolsContent({ safari });
    const r = await apps.safariOpenTab({ url: "https://example.com" });
    assert.equal(r.ok, true);
    assert.equal((r as unknown as OpenTabResult).tabId, "TAB-1");
    assert.equal(safari.calls[0], "openTab https://example.com");
  });

  test("notes_append forwards folder only when provided", async () => {
    const notes = makeNotes();
    const apps = new AppToolsContent({ notes });
    await apps.notesAppend({ noteTitle: "T", text: "body" });
    assert.equal(notes.calls[0], "append T | body | ");
    await apps.notesAppend({ noteTitle: "T", text: "body", folder: "F" });
    assert.equal(notes.calls[1], "append T | body | F");
  });

  test("reminders_add maps ISO dueAt to Date", async () => {
    const reminders = makeReminders();
    const apps = new AppToolsContent({ reminders });
    const r = await apps.remindersAdd({
      title: "T",
      dueAt: "2026-05-01T09:30:00.000Z",
      list: "Work",
      priority: 1,
    });
    assert.equal(r.ok, true);
    assert.ok(reminders.lastAdd?.dueAt instanceof Date);
    assert.equal(reminders.lastAdd?.list, "Work");
    assert.equal(reminders.lastAdd?.priority, 1);
  });

  test("music_play + music_currently_playing + music_set_volume round-trip", async () => {
    const music = makeMusic();
    const apps = new AppToolsContent({ music });
    const r1 = await apps.musicPlay({ query: "Miles" });
    assert.equal(r1.ok, true);
    const r2 = await apps.musicSetVolume({ pct: 55 });
    assert.deepEqual(r2, { ok: true, pct: 55 });
    const r3 = await apps.musicCurrentlyPlaying({});
    assert.deepEqual(r3, { ok: true, nowPlaying: null });
    assert.deepEqual(music.calls, [
      "play Miles",
      "setVolume 55",
      "cp",
    ]);
  });

  test("finder tools forward args", async () => {
    const finder = makeFinder();
    const apps = new AppToolsContent({ finder });
    assert.equal((await apps.finderReveal({ path: "/tmp/x" })).ok, true);
    assert.equal(
      (await apps.finderMove({ from: "/tmp/a", to: "/tmp/b" })).ok,
      true,
    );
    assert.equal(
      (await apps.finderRename({ path: "/tmp/a", newName: "new" })).ok,
      true,
    );
    assert.equal(
      (await apps.finderTag({ path: "/tmp/a", tags: ["Work"] })).ok,
      true,
    );
    assert.equal(
      (await apps.finderListTags({ path: "/tmp/a" })).ok,
      true,
    );
    assert.deepEqual(finder.calls, [
      "reveal /tmp/x",
      "move /tmp/a /tmp/b",
      "rename /tmp/a new",
      "tag /tmp/a Work",
      "listTags /tmp/a",
    ]);
  });
});
