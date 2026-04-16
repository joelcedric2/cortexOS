/**
 * Music driver — Phase 12 (§4 app drivers).
 *
 * Drives Music.app via `osascript` (AppleScript). All mutations
 * (play/pause/skip/queue/setVolume) append to the injected
 * {@link AuditLog}. `currentlyPlaying` is read-only.
 *
 * Nothing here is irreversible, so no escalation gate is needed.
 */
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AuditLog } from "../proactivity/audit.js";
import { quoteAS } from "./safari-driver.js";

const execFile = promisify(execFileCb);

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface NowPlaying {
  title: string;
  artist: string;
  album?: string;
}

export interface MusicDriver {
  play(query?: string): Promise<{ track?: string }>;
  pause(): Promise<void>;
  skip(): Promise<void>;
  queue(track: string): Promise<void>;
  setVolume(pct: number): Promise<void>;
  currentlyPlaying(): Promise<NowPlaying | null>;
}

export interface MusicDriverDeps {
  execFileFn?: typeof execFile;
  audit?: AuditLog;
}

/* ------------------------------------------------------------------ */
/*  Implementation                                                     */
/* ------------------------------------------------------------------ */

export class MacMusicDriver implements MusicDriver {
  private readonly execFileFn: typeof execFile;
  private readonly audit: AuditLog | undefined;

  constructor(deps: MusicDriverDeps = {}) {
    this.execFileFn = deps.execFileFn ?? execFile;
    this.audit = deps.audit;
  }

  async play(query?: string): Promise<{ track?: string }> {
    if (query) {
      const script =
        `tell application "Music"\n` +
        `  set results to (every track whose name contains ${quoteAS(query)})\n` +
        `  if (count of results) is 0 then\n` +
        `    set results to (every track whose artist contains ${quoteAS(query)})\n` +
        `  end if\n` +
        `  if (count of results) is 0 then return ""\n` +
        `  set t to item 1 of results\n` +
        `  play t\n` +
        `  return name of t as text\n` +
        `end tell`;
      const { stdout } = await this.execFileFn("osascript", ["-e", script]);
      const track = String(stdout).trim();
      this.auditMut("music.play", { query, track });
      return track ? { track } : {};
    }
    const script = `tell application "Music" to play`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("music.play", {});
    return {};
  }

  async pause(): Promise<void> {
    await this.execFileFn("osascript", [
      "-e",
      `tell application "Music" to pause`,
    ]);
    this.auditMut("music.pause", {});
  }

  async skip(): Promise<void> {
    await this.execFileFn("osascript", [
      "-e",
      `tell application "Music" to next track`,
    ]);
    this.auditMut("music.skip", {});
  }

  async queue(track: string): Promise<void> {
    if (!track) throw new Error("music.queue: track required");
    const script =
      `tell application "Music"\n` +
      `  set results to (every track whose name contains ${quoteAS(track)})\n` +
      `  if (count of results) is 0 then error "no-match"\n` +
      `  duplicate (item 1 of results) to source "Library"\n` +
      `end tell`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("music.queue", { track });
  }

  async setVolume(pct: number): Promise<void> {
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error("music.setVolume: pct must be in [0,100]");
    }
    const rounded = Math.round(pct);
    const script = `tell application "Music" to set sound volume to ${rounded}`;
    await this.execFileFn("osascript", ["-e", script]);
    this.auditMut("music.setVolume", { pct: rounded });
  }

  async currentlyPlaying(): Promise<NowPlaying | null> {
    const script =
      `tell application "Music"\n` +
      `  if player state is not playing then return ""\n` +
      `  set t to current track\n` +
      `  return (name of t) & \"\\t\" & (artist of t) & \"\\t\" & (album of t)\n` +
      `end tell`;
    const { stdout } = await this.execFileFn("osascript", ["-e", script]);
    const line = String(stdout).trim();
    if (!line) return null;
    const [title = "", artist = "", album = ""] = line.split("\t");
    const result: NowPlaying = { title, artist };
    if (album) result.album = album;
    return result;
  }

  private auditMut(op: string, detail: Record<string, unknown>): void {
    if (!this.audit) return;
    this.audit.append({
      action: "app_mutation",
      sensorName: "music",
      detail: JSON.stringify({ op, ...detail }),
      ts: new Date(),
    });
  }
}
