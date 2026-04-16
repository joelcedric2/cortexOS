import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SkillRegistryDB } from "../src/skills/skill-registry-db.js";
import type { TrustLevel } from "../src/skills/skill-registry-db.js";

describe("SkillRegistryDB", () => {
  let db: SkillRegistryDB;

  beforeEach(() => {
    db = new SkillRegistryDB({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
  });

  // ─── CRUD round-trip ───────────────────────────────────────────────────

  test("insert + get returns the row with defaults", () => {
    const row = db.insert({ id: "sk-1", name: "tiktok-scraper" });
    assert.equal(row.id, "sk-1");
    assert.equal(row.name, "tiktok-scraper");
    assert.equal(row.trust_level, "unvetted");
    assert.equal(row.success_count, 0);
    assert.equal(row.fail_count, 0);
    assert.equal(row.preferred_for_tags, "[]");
    assert.ok(row.installed_at);
  });

  test("insert with all fields", () => {
    const row = db.insert({
      id: "sk-2",
      name: "figma-react",
      repo_url: "https://github.com/foo/figma-react",
      commit_sha: "abc123",
      subpath: "packages/core",
      trust_level: "user-trusted",
      preferred_for_tags: ["ui", "figma"],
      skill_md_path: "/tmp/SKILL.md",
    });
    assert.equal(row.repo_url, "https://github.com/foo/figma-react");
    assert.equal(row.commit_sha, "abc123");
    assert.equal(row.subpath, "packages/core");
    assert.equal(row.trust_level, "user-trusted");
    assert.equal(row.preferred_for_tags, '["ui","figma"]');
    assert.equal(row.skill_md_path, "/tmp/SKILL.md");
  });

  test("get returns undefined for missing id", () => {
    assert.equal(db.get("nonexistent"), undefined);
  });

  test("list returns all skills ordered by installed_at desc", () => {
    db.insert({ id: "a", name: "alpha" });
    db.insert({ id: "b", name: "bravo" });
    db.insert({ id: "c", name: "charlie" });
    const all = db.list();
    assert.equal(all.length, 3);
  });

  test("list with trust_level filter", () => {
    db.insert({ id: "a", name: "alpha", trust_level: "unvetted" });
    db.insert({ id: "b", name: "bravo", trust_level: "user-trusted" });
    db.insert({ id: "c", name: "charlie", trust_level: "unvetted" });
    const unvetted = db.list({ trust_level: "unvetted" });
    assert.equal(unvetted.length, 2);
    for (const row of unvetted) {
      assert.equal(row.trust_level, "unvetted");
    }
  });

  test("list with limit", () => {
    db.insert({ id: "a", name: "alpha" });
    db.insert({ id: "b", name: "bravo" });
    db.insert({ id: "c", name: "charlie" });
    const limited = db.list({ limit: 2 });
    assert.equal(limited.length, 2);
  });

  test("delete removes a row and returns true", () => {
    db.insert({ id: "sk-del", name: "delete-me" });
    assert.equal(db.delete("sk-del"), true);
    assert.equal(db.get("sk-del"), undefined);
  });

  test("delete returns false for missing id", () => {
    assert.equal(db.delete("nonexistent"), false);
  });

  // ─── Trust transitions ────────────────────────────────────────────────

  test("setTrustLevel transitions trust", () => {
    db.insert({ id: "sk-t", name: "trust-test" });
    db.setTrustLevel("sk-t", "user-trusted");
    assert.equal(db.get("sk-t")!.trust_level, "user-trusted");
    db.setTrustLevel("sk-t", "system-trusted");
    assert.equal(db.get("sk-t")!.trust_level, "system-trusted");
  });

  test("setTrustLevel to quarantined sets quarantined_at", () => {
    db.insert({ id: "sk-q", name: "quarantine-test" });
    db.setTrustLevel("sk-q", "quarantined");
    const row = db.get("sk-q")!;
    assert.equal(row.trust_level, "quarantined");
    assert.ok(row.quarantined_at, "quarantined_at should be set");
  });

  // ─── recordRun increments ─────────────────────────────────────────────

  test("recordRun increments success_count", () => {
    db.insert({ id: "sk-r", name: "run-test" });
    db.recordRun("sk-r", "success");
    db.recordRun("sk-r", "success");
    db.recordRun("sk-r", "success");
    assert.equal(db.get("sk-r")!.success_count, 3);
    assert.equal(db.get("sk-r")!.fail_count, 0);
  });

  test("recordRun increments fail_count", () => {
    db.insert({ id: "sk-f", name: "fail-test" });
    db.recordRun("sk-f", "fail");
    db.recordRun("sk-f", "fail");
    assert.equal(db.get("sk-f")!.fail_count, 2);
    assert.equal(db.get("sk-f")!.success_count, 0);
  });

  // ─── promoteToSystemTrusted ───────────────────────────────────────────

  test("promoteToSystemTrusted promotes when threshold met", () => {
    db.insert({ id: "sk-p", name: "promote-test", trust_level: "user-trusted" });
    for (let i = 0; i < 20; i++) {
      db.recordRun("sk-p", "success");
    }
    const promoted = db.promoteToSystemTrusted("sk-p");
    assert.equal(promoted, true);
    assert.equal(db.get("sk-p")!.trust_level, "system-trusted");
  });

  test("promoteToSystemTrusted does not promote below threshold", () => {
    db.insert({ id: "sk-np", name: "no-promote", trust_level: "user-trusted" });
    for (let i = 0; i < 19; i++) {
      db.recordRun("sk-np", "success");
    }
    assert.equal(db.promoteToSystemTrusted("sk-np"), false);
    assert.equal(db.get("sk-np")!.trust_level, "user-trusted");
  });

  test("promoteToSystemTrusted refuses for unvetted skills", () => {
    db.insert({ id: "sk-uv", name: "unvetted-skill" });
    for (let i = 0; i < 30; i++) {
      db.recordRun("sk-uv", "success");
    }
    assert.equal(db.promoteToSystemTrusted("sk-uv"), false);
  });

  test("promoteToSystemTrusted returns false for missing id", () => {
    assert.equal(db.promoteToSystemTrusted("nonexistent"), false);
  });

  test("promoteToSystemTrusted with custom threshold", () => {
    db.insert({ id: "sk-ct", name: "custom-threshold", trust_level: "user-trusted" });
    for (let i = 0; i < 5; i++) {
      db.recordRun("sk-ct", "success");
    }
    assert.equal(db.promoteToSystemTrusted("sk-ct", 5), true);
    assert.equal(db.get("sk-ct")!.trust_level, "system-trusted");
  });
});
