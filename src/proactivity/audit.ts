/**
 * Audit log for the proactive-awareness subsystem (plan section 5.7.5).
 *
 * Append-only NDJSON file that records sensor samples, surface events,
 * suppressions, and user actions. Supports daily summary queries.
 */
import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface AuditEntry {
  /** Action type: sensor_sample, surface, suppress, act_on */
  action: "sensor_sample" | "surface" | "suppress" | "act_on";
  /** The sensor that produced the observation, if applicable. */
  sensorName?: string;
  /** Human-readable detail. */
  detail: string;
  /** Timestamp of the audit entry. */
  ts: Date;
}

export interface DailySummary {
  totalSamples: number;
  surfaced: number;
  actedOn: number;
}

/** Serialised form stored in NDJSON. */
interface AuditRecord {
  action: string;
  sensorName?: string;
  detail: string;
  ts: string; // ISO 8601
}

const DEFAULT_LOG_DIR = join(homedir(), ".cortexos");
const DEFAULT_LOG_FILE = "audit.ndjson";

/**
 * Append-only audit log backed by an NDJSON file.
 *
 * Each line is a JSON object with action, sensorName, detail, and ts fields.
 * The file is created lazily on first append. Directory is created if needed.
 */
export class AuditLog {
  private readonly logPath: string;

  constructor(logPath?: string) {
    this.logPath = logPath ?? join(DEFAULT_LOG_DIR, DEFAULT_LOG_FILE);
  }

  /**
   * Append an audit entry to the log file.
   * Creates the directory and file if they don't exist.
   */
  append(entry: AuditEntry): void {
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const record: AuditRecord = {
      action: entry.action,
      sensorName: entry.sensorName,
      detail: entry.detail,
      ts: entry.ts.toISOString(),
    };

    appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf-8");
  }

  /**
   * Generate a summary of audit activity for a given date.
   *
   * Reads the entire log and filters entries whose timestamp falls on the
   * specified date (UTC). Returns counts of samples, surfaces, and actions.
   */
  dailySummary(date: Date): DailySummary {
    const targetDay = date.toISOString().slice(0, 10); // YYYY-MM-DD

    const summary: DailySummary = {
      totalSamples: 0,
      surfaced: 0,
      actedOn: 0,
    };

    if (!existsSync(this.logPath)) {
      return summary;
    }

    const content = readFileSync(this.logPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      let record: AuditRecord;
      try {
        record = JSON.parse(line) as AuditRecord;
      } catch {
        // Skip malformed lines
        continue;
      }

      const recordDay = record.ts.slice(0, 10);
      if (recordDay !== targetDay) continue;

      switch (record.action) {
        case "sensor_sample":
          summary.totalSamples++;
          break;
        case "surface":
          summary.surfaced++;
          break;
        case "act_on":
          summary.actedOn++;
          break;
      }
    }

    return summary;
  }
}
