/**
 * Unread-email sensor (plan §5.7.1).
 *
 * Checks Mail.app unread count via osascript. Only fires if Mail.app
 * is running and unread > 0. All commands via execFile with arg arrays.
 */
import { execFile } from "node:child_process";
import type { Sensor, SensorSample } from "./sensor.js";

export function createUnreadEmailSensor(): Sensor {
  return {
    name: "unread-email",
    description: "Checks Mail.app for unread messages",
    permissionsRequired: ["mail-read"],
    privacyLevel: "llm-on-action",
    interval: 300_000, // 5 min
    enabled: true,

    async sample(): Promise<SensorSample | null> {
      // Check if Mail.app is running
      try {
        const pgrepOut = await execAsync("pgrep", ["-x", "Mail"]);
        if (!pgrepOut.trim()) return null;
      } catch {
        // pgrep returns exit code 1 if no match — Mail not running
        return null;
      }

      // Get unread count
      try {
        const countStr = await execAsync("osascript", [
          "-e",
          'tell application "Mail" to get unread count of inbox',
        ]);
        const count = parseInt(countStr.trim(), 10);
        if (isNaN(count) || count <= 0) return null;

        let urgency: number;
        if (count > 20) {
          urgency = 0.7;
        } else if (count > 5) {
          urgency = 0.5;
        } else {
          urgency = 0.3;
        }

        return {
          sensorName: "unread-email",
          observation: `${count} unread email(s) in Mail.app inbox`,
          urgency,
          data: { unreadCount: count },
          sampledAt: new Date(),
        };
      } catch {
        // osascript failed — Mail may have quit or access denied
        return null;
      }
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
