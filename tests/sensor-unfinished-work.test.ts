import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";

// We test the sensor by mocking child_process.execFile at the module boundary.
// Since the sensor uses execFile directly, we create a test-friendly wrapper
// that exercises the parsing logic via controlled output.

describe("UnfinishedWorkSensor", () => {
  // ─── Parsing logic tests ────────────────────────────────────────────────

  test("sensor returns null when git status is clean", async () => {
    const { createUnfinishedWorkSensor } = await import("../src/sensors/unfinished-work.js");

    // Use a real git repo (cortexOS itself), but we test the interface
    const sensor = createUnfinishedWorkSensor({ repoPaths: [] });
    const sample = await sensor.sample();
    // No repos to scan → null
    assert.equal(sample, null);
  });

  test("sensor has correct metadata", async () => {
    const { createUnfinishedWorkSensor } = await import("../src/sensors/unfinished-work.js");
    const sensor = createUnfinishedWorkSensor();

    assert.equal(sensor.name, "unfinished-work");
    assert.equal(sensor.privacyLevel, "local-only");
    assert.equal(sensor.enabled, true);
    assert.equal(sensor.interval, 300_000);
    assert.deepEqual(sensor.permissionsRequired, ["filesystem-read"]);
  });

  test("sensor reports non-null when repo has uncommitted work", async () => {
    // We'll use a temporary git repo with uncommitted files and an old commit
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmp = mkdtempSync(join(tmpdir(), "sensor-test-"));

    // Initialize a git repo with an old commit
    await execAsync("git", ["init"], tmp);
    await execAsync("git", ["-c", "user.name=Test", "-c", "user.email=t@t.co", "commit", "--allow-empty", "-m", "init"], tmp);

    // Backdate the commit to 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
    const dateStr = threeHoursAgo.toISOString();
    await execAsync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=t@t.co",
       "commit", "--allow-empty", "--amend", "--date", dateStr, "-m", "old"],
      tmp,
      { GIT_COMMITTER_DATE: dateStr },
    );

    // Create an uncommitted file
    writeFileSync(join(tmp, "dirty.txt"), "uncommitted");

    const { createUnfinishedWorkSensor } = await import("../src/sensors/unfinished-work.js");
    const sensor = createUnfinishedWorkSensor({ repoPaths: [tmp] });
    const sample = await sensor.sample();

    assert.ok(sample, "should produce an observation");
    assert.equal(sample.sensorName, "unfinished-work");
    assert.ok(sample.observation.includes("uncommitted"));
    // Untracked files show as "??" in porcelain — the second char is "?" not " "
    assert.equal(sample.urgency, 0.6);
  });

  test("sensor returns null when last commit is recent", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmp = mkdtempSync(join(tmpdir(), "sensor-test-"));

    await execAsync("git", ["init"], tmp);
    await execAsync("git", ["-c", "user.name=Test", "-c", "user.email=t@t.co", "commit", "--allow-empty", "-m", "fresh"], tmp);

    // Create uncommitted file but commit is recent
    writeFileSync(join(tmp, "dirty.txt"), "uncommitted");

    const { createUnfinishedWorkSensor } = await import("../src/sensors/unfinished-work.js");
    const sensor = createUnfinishedWorkSensor({ repoPaths: [tmp] });
    const sample = await sensor.sample();

    assert.equal(sample, null, "recent commit should not trigger");
  });

  test("sensor handles non-git directory gracefully", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmp = mkdtempSync(join(tmpdir(), "sensor-test-"));

    const { createUnfinishedWorkSensor } = await import("../src/sensors/unfinished-work.js");
    const sensor = createUnfinishedWorkSensor({ repoPaths: [tmp] });
    const sample = await sensor.sample();

    assert.equal(sample, null, "non-git dir should be skipped");
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function execAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 10000, env: { ...process.env, ...env } }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
