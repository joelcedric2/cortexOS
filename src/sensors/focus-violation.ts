/**
 * Focus-violation sensor (plan section 5.7).
 *
 * Checks if a distracting app is frontmost while macOS Focus mode is active.
 * Uses `defaults read` and osascript. All commands via execFile.
 */
import { execFile } from "node:child_process";
import type { Sensor, SensorSample } from "./sensor.js";

const DEFAULT_DISTRACTIONS = [
  "Twitter",
  "Instagram",
  "TikTok",
  "YouTube",
  "Reddit",
];

export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

/**
 * Create a focus-violation sensor.
 *
 * @param opts.distractionApps Override the default distraction list.
 * @param opts.execFn Override execFile for testing.
 */
export function createFocusViolationSensor(opts?: {
  distractionApps?: string[];
  execFn?: ExecFn;
}): Sensor {
  const distractions = opts?.distractionApps ?? DEFAULT_DISTRACTIONS;
  const exec = opts?.execFn ?? execAsync;

  return {
    name: "focus-violation",
    description: "Detects distracting apps during Focus mode",
    permissionsRequired: ["accessibility"],
    privacyLevel: "local-only",
    interval: 30_000, // 30 seconds
    enabled: true,

    async sample(): Promise<SensorSample | null> {
      try {
        // Check if Focus mode is active via Control Center state
        const dndOut = await exec("defaults", [
          "read",
          "com.apple.controlcenter",
          "NSStatusItem Visible FocusModes",
        ]);

        const focusActive = dndOut.trim() === "1";
        if (!focusActive) return null;

        // Get frontmost app
        const frontmost = (
          await exec("osascript", [
            "-e",
            'tell application "System Events" to get name of first application process whose frontmost is true',
          ])
        ).trim();

        // Case-insensitive match against distraction list
        const isDistraction = distractions.some(
          (d) => d.toLowerCase() === frontmost.toLowerCase(),
        );

        if (!isDistraction) return null;

        return {
          sensorName: "focus-violation",
          observation: `"${frontmost}" is open during Focus mode`,
          urgency: 0.6,
          data: { app: frontmost, focusModeActive: true },
          sampledAt: new Date(),
        };
      } catch {
        // defaults read fails if key doesn't exist — Focus not configured
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
