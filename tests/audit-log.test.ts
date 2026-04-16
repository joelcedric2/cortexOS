import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog, type AuditEntry } from "../src/proactivity/audit.js";

describe("AuditLog", () => {
  let tmpDir: string;
  let logPath: string;
  let log: AuditLog;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortexos-audit-"));
    logPath = join(tmpDir, "test-audit.ndjson");
    log = new AuditLog(logPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("append()", () => {
    it("creates the log file on first append", () => {
      const entry: AuditEntry = {
        action: "sensor_sample",
        sensorName: "test-sensor",
        detail: "Detected something",
        ts: new Date("2026-04-15T10:00:00Z"),
      };

      log.append(entry);

      const content = readFileSync(logPath, "utf-8");
      assert.ok(content.length > 0);
    });

    it("writes valid NDJSON lines", () => {
      log.append({
        action: "sensor_sample",
        sensorName: "s1",
        detail: "d1",
        ts: new Date("2026-04-15T10:00:00Z"),
      });
      log.append({
        action: "surface",
        sensorName: "s2",
        detail: "d2",
        ts: new Date("2026-04-15T11:00:00Z"),
      });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 2);

      const record1 = JSON.parse(lines[0]);
      assert.equal(record1.action, "sensor_sample");
      assert.equal(record1.sensorName, "s1");

      const record2 = JSON.parse(lines[1]);
      assert.equal(record2.action, "surface");
    });

    it("creates parent directories if needed", () => {
      const nestedPath = join(tmpDir, "nested", "deep", "audit.ndjson");
      const nestedLog = new AuditLog(nestedPath);

      nestedLog.append({
        action: "act_on",
        detail: "User replied",
        ts: new Date(),
      });

      const content = readFileSync(nestedPath, "utf-8");
      assert.ok(content.includes("act_on"));
    });

    it("appends without overwriting existing entries", () => {
      log.append({
        action: "sensor_sample",
        detail: "first",
        ts: new Date(),
      });
      log.append({
        action: "surface",
        detail: "second",
        ts: new Date(),
      });

      const content = readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 2);
      assert.ok(lines[0].includes("first"));
      assert.ok(lines[1].includes("second"));
    });
  });

  describe("dailySummary()", () => {
    it("returns zeros when log does not exist", () => {
      const freshLog = new AuditLog(join(tmpDir, "nonexistent.ndjson"));
      const summary = freshLog.dailySummary(new Date("2026-04-15"));

      assert.equal(summary.totalSamples, 0);
      assert.equal(summary.surfaced, 0);
      assert.equal(summary.actedOn, 0);
    });

    it("counts sensor_sample entries", () => {
      log.append({
        action: "sensor_sample",
        sensorName: "s1",
        detail: "a",
        ts: new Date("2026-04-15T08:00:00Z"),
      });
      log.append({
        action: "sensor_sample",
        sensorName: "s2",
        detail: "b",
        ts: new Date("2026-04-15T09:00:00Z"),
      });
      log.append({
        action: "sensor_sample",
        sensorName: "s3",
        detail: "c",
        ts: new Date("2026-04-16T08:00:00Z"),
      });

      const summary = log.dailySummary(new Date("2026-04-15"));
      assert.equal(summary.totalSamples, 2);
    });

    it("counts surfaced and actedOn entries", () => {
      log.append({
        action: "surface",
        detail: "surfaced-1",
        ts: new Date("2026-04-15T10:00:00Z"),
      });
      log.append({
        action: "surface",
        detail: "surfaced-2",
        ts: new Date("2026-04-15T11:00:00Z"),
      });
      log.append({
        action: "act_on",
        detail: "acted",
        ts: new Date("2026-04-15T12:00:00Z"),
      });

      const summary = log.dailySummary(new Date("2026-04-15"));
      assert.equal(summary.surfaced, 2);
      assert.equal(summary.actedOn, 1);
    });

    it("filters by date correctly", () => {
      log.append({
        action: "sensor_sample",
        detail: "today",
        ts: new Date("2026-04-15T23:59:59Z"),
      });
      log.append({
        action: "sensor_sample",
        detail: "tomorrow",
        ts: new Date("2026-04-16T00:00:01Z"),
      });

      const todaySummary = log.dailySummary(new Date("2026-04-15"));
      assert.equal(todaySummary.totalSamples, 1);

      const tomorrowSummary = log.dailySummary(new Date("2026-04-16"));
      assert.equal(tomorrowSummary.totalSamples, 1);
    });

    it("ignores suppress entries in counts", () => {
      log.append({
        action: "suppress",
        detail: "suppressed",
        ts: new Date("2026-04-15T10:00:00Z"),
      });

      const summary = log.dailySummary(new Date("2026-04-15"));
      assert.equal(summary.totalSamples, 0);
      assert.equal(summary.surfaced, 0);
      assert.equal(summary.actedOn, 0);
    });
  });
});
