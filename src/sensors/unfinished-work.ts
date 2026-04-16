/**
 * Unfinished-work sensor (plan §5.7.1).
 *
 * Checks git repos for uncommitted work. If a repo has uncommitted changes
 * AND the last commit was > 2 hours ago, produces an observation.
 *
 * All git commands via execFile with arg arrays.
 */
import { execFile } from "node:child_process";
import type { Sensor, SensorSample } from "./sensor.js";

export interface UnfinishedWorkOptions {
  /** Repository paths to scan. Defaults to [process.cwd()]. */
  repoPaths?: string[];
  /** Hours since last commit before flagging. Default 2. */
  staleHours?: number;
}

export function createUnfinishedWorkSensor(opts?: UnfinishedWorkOptions): Sensor {
  const repoPaths = opts?.repoPaths ?? [process.cwd()];
  const staleHours = opts?.staleHours ?? 2;

  return {
    name: "unfinished-work",
    description: "Detects git repos with uncommitted work and stale last commit",
    permissionsRequired: ["filesystem-read"],
    privacyLevel: "local-only",
    interval: 300_000, // 5 min
    enabled: true,

    async sample(): Promise<SensorSample | null> {
      const findings: Array<{ path: string; hasUnstaged: boolean; fileCount: number }> = [];

      for (const repoPath of repoPaths) {
        try {
          const status = await execAsync("git", ["status", "--porcelain"], repoPath);
          if (!status.trim()) continue;

          // Check last commit time
          const logOut = await execAsync(
            "git",
            ["log", "-1", "--format=%ct"],
            repoPath,
          );
          const lastCommitEpoch = parseInt(logOut.trim(), 10);
          if (isNaN(lastCommitEpoch)) continue;

          const hoursSinceCommit = (Date.now() / 1000 - lastCommitEpoch) / 3600;
          if (hoursSinceCommit < staleHours) continue;

          // Parse status lines
          const lines = status.trim().split("\n");
          const hasUnstaged = lines.some((l) => l.length >= 2 && l[1] !== " ");

          findings.push({
            path: repoPath,
            hasUnstaged,
            fileCount: lines.length,
          });
        } catch {
          // Not a git repo or git not available — skip
          continue;
        }
      }

      if (findings.length === 0) return null;

      const hasUnstaged = findings.some((f) => f.hasUnstaged);
      const totalFiles = findings.reduce((s, f) => s + f.fileCount, 0);
      const urgency = hasUnstaged ? 0.6 : 0.3;

      const paths = findings.map((f) => f.path).join(", ");
      const observation = hasUnstaged
        ? `${totalFiles} uncommitted file(s) with unstaged changes in: ${paths}`
        : `${totalFiles} uncommitted file(s) in: ${paths}`;

      return {
        sensorName: "unfinished-work",
        observation,
        urgency,
        data: { findings },
        sampledAt: new Date(),
      };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function execAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
