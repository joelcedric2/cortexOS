/**
 * Unsent-drafts sensor (plan section 5.7).
 *
 * Checks Mail.app for draft messages that have been sitting > 5 minutes.
 * Uses osascript via execFile for all system queries.
 */
import { execFile } from "node:child_process";
import type { Sensor, SensorSample } from "./sensor.js";

/** Default age threshold for a draft to trigger an observation. */
const DRAFT_AGE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

/**
 * Create an unsent-drafts sensor.
 *
 * @param opts.ageThresholdMs Override the default 5-minute threshold.
 * @param opts.execFn Override execFile for testing.
 */
export function createUnsentDraftsSensor(opts?: {
  ageThresholdMs?: number;
  execFn?: ExecFn;
}): Sensor {
  const ageThreshold = opts?.ageThresholdMs ?? DRAFT_AGE_THRESHOLD_MS;
  const exec = opts?.execFn ?? execAsync;

  return {
    name: "unsent-drafts",
    description: "Checks Mail.app for draft messages older than 5 minutes",
    permissionsRequired: ["mail-read"],
    privacyLevel: "llm-on-action",
    interval: 300_000, // 5 min
    enabled: true,

    async sample(): Promise<SensorSample | null> {
      try {
        // Check draft count
        const countStr = await exec("osascript", [
          "-e",
          'tell application "Mail" to get count of messages of mailbox "Drafts"',
        ]);

        const count = parseInt(countStr.trim(), 10);
        if (isNaN(count) || count <= 0) return null;

        // Check oldest draft age
        const dateStr = await exec("osascript", [
          "-e",
          'tell application "Mail" to get date received of message 1 of mailbox "Drafts"',
        ]);

        const oldestDate = new Date(dateStr.trim());
        const now = Date.now();
        const ageMs = now - oldestDate.getTime();

        if (isNaN(oldestDate.getTime()) || ageMs < ageThreshold) return null;

        const ageMin = Math.round(ageMs / 60_000);

        return {
          sensorName: "unsent-drafts",
          observation: `${count} unsent draft(s) in Mail.app (oldest: ${ageMin} min ago)`,
          urgency: 0.4,
          data: { draftCount: count, oldestAgeMinutes: ageMin },
          sampledAt: new Date(),
        };
      } catch {
        // Mail not running or access denied
        return null;
      }
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
