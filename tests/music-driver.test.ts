/**
 * Tests for MacMusicDriver (src/apps/music-driver.ts).
 *
 * Mocks execFile(osascript, …) and asserts:
 *   • script contents
 *   • user-string escaping on play()/queue()
 *   • audit entries
 *   • volume bounds
 *   • currentlyPlaying parses or returns null
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuditLog } from "../src/proactivity/audit.js";
import { MacMusicDriver } from "../src/apps/music-driver.js";

function makeMockExec(out: string | ((args: readonly string[]) => string)) {
  const calls: { args: readonly string[] }[] = [];
  const fn = async (_f: string, args: readonly string[]) => {
    calls.push({ args });
    return { stdout: typeof out === "function" ? out(args) : out, stderr: "" };
  };
  return { fn: fn as unknown as (typeof import("node:child_process"))["execFile"], calls };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "music-audit-"));
});

describe("MacMusicDriver.play", () => {
  test("no-arg play runs bare AppleScript and audits", async () => {
    const { fn, calls } = makeMockExec("");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacMusicDriver({ execFileFn: fn, audit });
    const res = await driver.play();
    assert.deepEqual(res, {});
    const script = String(calls[0]?.args[1] ?? "");
    assert.equal(script, `tell application "Music" to play`);
    assert.match(readFileSync(auditPath, "utf-8"), /music\.play/);
  });

  test("query play runs search AppleScript, returns track name", async () => {
    const { fn, calls } = makeMockExec("Blue in Green\n");
    const driver = new MacMusicDriver({ execFileFn: fn });
    const res = await driver.play(`Miles "Davis"`);
    assert.equal(res.track, "Blue in Green");
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /name contains "Miles \\"Davis\\""/);
    assert.match(script, /artist contains/);
  });
});

describe("MacMusicDriver.pause / skip", () => {
  test("pause runs right script", async () => {
    const { fn, calls } = makeMockExec("");
    const driver = new MacMusicDriver({ execFileFn: fn });
    await driver.pause();
    assert.equal(String(calls[0]?.args[1] ?? ""), `tell application "Music" to pause`);
  });

  test("skip runs right script", async () => {
    const { fn, calls } = makeMockExec("");
    const driver = new MacMusicDriver({ execFileFn: fn });
    await driver.skip();
    assert.equal(
      String(calls[0]?.args[1] ?? ""),
      `tell application "Music" to next track`,
    );
  });
});

describe("MacMusicDriver.queue", () => {
  test("escapes track name and audits", async () => {
    const { fn, calls } = makeMockExec("");
    const auditPath = join(tmp, "audit.ndjson");
    const audit = new AuditLog(auditPath);
    const driver = new MacMusicDriver({ execFileFn: fn, audit });
    await driver.queue(`So "What"`);
    const script = String(calls[0]?.args[1] ?? "");
    assert.match(script, /name contains "So \\"What\\""/);
    assert.match(readFileSync(auditPath, "utf-8"), /music\.queue/);
  });

  test("empty track rejected", async () => {
    const { fn } = makeMockExec("");
    const driver = new MacMusicDriver({ execFileFn: fn });
    await assert.rejects(() => driver.queue(""), /track required/);
  });
});

describe("MacMusicDriver.setVolume", () => {
  test("rejects out-of-range", async () => {
    const { fn } = makeMockExec("");
    const driver = new MacMusicDriver({ execFileFn: fn });
    await assert.rejects(() => driver.setVolume(-1));
    await assert.rejects(() => driver.setVolume(101));
    await assert.rejects(() => driver.setVolume(Number.NaN));
  });

  test("rounds and emits numeric literal", async () => {
    const { fn, calls } = makeMockExec("");
    const driver = new MacMusicDriver({ execFileFn: fn });
    await driver.setVolume(42.7);
    const script = String(calls[0]?.args[1] ?? "");
    assert.equal(
      script,
      `tell application "Music" to set sound volume to 43`,
    );
  });
});

describe("MacMusicDriver.currentlyPlaying", () => {
  test("returns null when stopped", async () => {
    const { fn } = makeMockExec("");
    const driver = new MacMusicDriver({ execFileFn: fn });
    const np = await driver.currentlyPlaying();
    assert.equal(np, null);
  });

  test("parses title/artist/album", async () => {
    const { fn } = makeMockExec("Song\tArtist\tAlbum\n");
    const driver = new MacMusicDriver({ execFileFn: fn });
    const np = await driver.currentlyPlaying();
    assert.deepEqual(np, { title: "Song", artist: "Artist", album: "Album" });
  });
});

process.on("exit", () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});
