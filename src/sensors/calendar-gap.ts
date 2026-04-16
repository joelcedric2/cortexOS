/**
 * Calendar-gap sensor (plan §5.7.1).
 *
 * Queries Calendar.app for events in the next 30 minutes.
 * If an event has no associated doc/file mentioned in its notes,
 * produces an observation suggesting prep is needed.
 *
 * All commands via execFile with arg arrays.
 */
import { execFile } from "node:child_process";
import type { Sensor, SensorSample } from "./sensor.js";

/** AppleScript that returns events in the next 30 min as pipe-delimited lines. */
const CALENDAR_SCRIPT = `
set now to current date
set later to now + 30 * 60
set output to ""
tell application "Calendar"
  repeat with cal in calendars
    set evts to (every event of cal whose start date >= now and start date <= later)
    repeat with evt in evts
      set evtName to summary of evt
      set evtStart to start date of evt
      set evtNotes to ""
      try
        set evtNotes to description of evt
      end try
      set minutesUntil to round ((evtStart - now) / 60)
      set output to output & evtName & "|" & minutesUntil & "|" & evtNotes & linefeed
    end repeat
  end repeat
end tell
return output
`;

interface CalendarEvent {
  name: string;
  minutesUntil: number;
  notes: string;
  hasDoc: boolean;
}

export function createCalendarGapSensor(): Sensor {
  return {
    name: "calendar-gap",
    description: "Detects upcoming meetings without preparation docs",
    permissionsRequired: ["calendar-read"],
    privacyLevel: "llm-on-action",
    interval: 300_000, // 5 min
    enabled: true,

    async sample(): Promise<SensorSample | null> {
      let raw: string;
      try {
        raw = await execAsync("osascript", ["-e", CALENDAR_SCRIPT]);
      } catch {
        // Calendar.app not available or access denied
        return null;
      }

      const lines = raw.trim().split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) return null;

      const events: CalendarEvent[] = [];
      for (const line of lines) {
        const parts = line.split("|");
        if (parts.length < 2) continue;

        const name = parts[0].trim();
        const minutesUntil = parseInt(parts[1].trim(), 10);
        const notes = parts.slice(2).join("|").trim();

        // Check if notes reference a doc/file
        const hasDoc = /\.(pdf|doc|docx|pptx?|xlsx?|md|txt|pages|key|numbers|gdoc|gsheet)/i.test(notes)
          || /https?:\/\//i.test(notes);

        events.push({ name, minutesUntil, notes, hasDoc });
      }

      // Only report events without docs
      const unprepared = events.filter((e) => !e.hasDoc);
      if (unprepared.length === 0) return null;

      // Highest urgency event
      const mostUrgent = unprepared.reduce((a, b) =>
        a.minutesUntil < b.minutesUntil ? a : b,
      );

      const urgency = mostUrgent.minutesUntil < 15 ? 0.8 : 0.5;

      const names = unprepared.map((e) => `"${e.name}" in ${e.minutesUntil}min`).join(", ");
      const observation = `Upcoming meeting(s) without prep docs: ${names}`;

      return {
        sensorName: "calendar-gap",
        observation,
        urgency,
        data: {
          events: unprepared.map((e) => ({
            name: e.name,
            minutesUntil: e.minutesUntil,
          })),
        },
        sampledAt: new Date(),
      };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function execAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
