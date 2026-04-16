/**
 * System-health sensor (plan §5.7.1).
 *
 * Monitors battery, disk usage, and runaway processes on macOS.
 * All system commands via execFile with arg arrays.
 */
import { execFile } from "node:child_process";
import type { Sensor, SensorSample } from "./sensor.js";

export interface SystemHealthOptions {
  /** Battery threshold percentage. Default 20. */
  batteryThreshold?: number;
  /** Disk usage threshold percentage. Default 90. */
  diskThreshold?: number;
  /** CPU threshold percentage for runaway process detection. Default 90. */
  cpuThreshold?: number;
}

export function createSystemHealthSensor(opts?: SystemHealthOptions): Sensor {
  const batteryThreshold = opts?.batteryThreshold ?? 20;
  const diskThreshold = opts?.diskThreshold ?? 90;
  const cpuThreshold = opts?.cpuThreshold ?? 90;

  return {
    name: "system-health",
    description: "Monitors battery, disk, and runaway processes",
    permissionsRequired: ["system-info"],
    privacyLevel: "local-only",
    interval: 120_000, // 2 min
    enabled: true,

    async sample(): Promise<SensorSample | null> {
      const issues: string[] = [];
      let maxUrgency = 0;
      const data: Record<string, unknown> = {};

      // ─── Battery ─────────────────────────────────────────────────────
      try {
        const battOut = await execAsync("pmset", ["-g", "batt"]);
        const battMatch = battOut.match(/(\d+)%/);
        if (battMatch) {
          const pct = parseInt(battMatch[1], 10);
          data.batteryPercent = pct;
          if (pct < 10) {
            issues.push(`Battery critically low: ${pct}%`);
            maxUrgency = Math.max(maxUrgency, 0.9);
          } else if (pct < batteryThreshold) {
            issues.push(`Battery low: ${pct}%`);
            maxUrgency = Math.max(maxUrgency, 0.5);
          }
        }
      } catch {
        // pmset not available (non-macOS) — skip
      }

      // ─── Disk ────────────────────────────────────────────────────────
      try {
        const dfOut = await execAsync("df", ["-k", "/"]);
        const lines = dfOut.trim().split("\n");
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          // df -k output: Filesystem 1K-blocks Used Available Use% Mounted
          const usePctStr = parts.find((p) => p.endsWith("%"));
          if (usePctStr) {
            const usePct = parseInt(usePctStr, 10);
            data.diskUsagePercent = usePct;
            if (usePct > 95) {
              issues.push(`Disk critically full: ${usePct}%`);
              maxUrgency = Math.max(maxUrgency, 0.8);
            } else if (usePct > diskThreshold) {
              issues.push(`Disk usage high: ${usePct}%`);
              maxUrgency = Math.max(maxUrgency, 0.6);
            }
          }
        }
      } catch {
        // df not available — skip
      }

      // ─── Runaway processes ───────────────────────────────────────────
      try {
        const psOut = await execAsync("ps", ["-eo", "pid,pcpu,comm"]);
        const psLines = psOut.trim().split("\n").slice(1); // skip header
        // Sort by CPU desc and take top 5
        const parsed = psLines
          .map((line) => {
            const trimmed = line.trim();
            const match = trimmed.match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
            if (!match) return null;
            return {
              pid: parseInt(match[1], 10),
              cpu: parseFloat(match[2]),
              comm: match[3].trim(),
            };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .sort((a, b) => b.cpu - a.cpu)
          .slice(0, 5);

        const runaways = parsed.filter((p) => p.cpu > cpuThreshold);
        if (runaways.length > 0) {
          data.runaways = runaways;
          const names = runaways.map((r) => `${r.comm} (${r.cpu}%)`).join(", ");
          issues.push(`Runaway process(es): ${names}`);
          maxUrgency = Math.max(maxUrgency, 0.7);
        }
      } catch {
        // ps not available — skip
      }

      if (issues.length === 0) return null;

      return {
        sensorName: "system-health",
        observation: issues.join("; "),
        urgency: maxUrgency,
        data,
        sampledAt: new Date(),
      };
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
