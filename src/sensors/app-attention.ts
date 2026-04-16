/**
 * App-attention sensor (plan section 5.7).
 *
 * Detects apps that have been running > 30 minutes without being the
 * frontmost application. Uses osascript to query macOS app state.
 * All commands via execFile with arg arrays.
 */
import { execFile } from "node:child_process";
import type { Sensor, SensorSample } from "./sensor.js";

/** Default threshold before an app is considered "neglected". */
const ATTENTION_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

/**
 * Create an app-attention sensor.
 *
 * @param opts.thresholdMs Override the default 30-minute threshold.
 * @param opts.execFn Override execFile for testing.
 */
export function createAppAttentionSensor(opts?: {
  thresholdMs?: number;
  execFn?: ExecFn;
}): Sensor {
  const threshold = opts?.thresholdMs ?? ATTENTION_THRESHOLD_MS;
  const exec = opts?.execFn ?? execAsync;

  /** Tracks when each app was last seen as frontmost. */
  const lastFocusMap = new Map<string, number>();

  return {
    name: "app-attention",
    description: "Detects apps open without focus for > 30 minutes",
    permissionsRequired: ["accessibility"],
    privacyLevel: "local-only",
    interval: 120_000, // 2 min
    enabled: true,

    async sample(): Promise<SensorSample | null> {
      try {
        // Get frontmost app
        const frontmost = (
          await exec("osascript", [
            "-e",
            'tell application "System Events" to get name of first application process whose frontmost is true',
          ])
        ).trim();

        // Get all running app names
        const runningRaw = await exec("osascript", [
          "-e",
          'tell application "System Events" to get name of every application process whose background only is false',
        ]);

        const runningApps = runningRaw
          .trim()
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        const now = Date.now();

        // Update focus time for frontmost app
        lastFocusMap.set(frontmost, now);

        // Find neglected apps
        const neglected: string[] = [];
        for (const app of runningApps) {
          if (app === frontmost) continue;

          const lastFocus = lastFocusMap.get(app);
          if (lastFocus === undefined) {
            // First time seeing this app — set its baseline
            lastFocusMap.set(app, now);
          } else if (now - lastFocus > threshold) {
            neglected.push(app);
          }
        }

        // Clean up apps no longer running
        for (const tracked of Array.from(lastFocusMap.keys())) {
          if (!runningApps.includes(tracked)) {
            lastFocusMap.delete(tracked);
          }
        }

        if (neglected.length === 0) return null;

        return {
          sensorName: "app-attention",
          observation: `${neglected.length} app(s) open without focus > ${Math.round(threshold / 60000)} min: ${neglected.join(", ")}`,
          urgency: 0.2,
          data: { neglectedApps: neglected, frontmost },
          sampledAt: new Date(),
        };
      } catch {
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
