/**
 * Pending Surface API (plan section 5.7.4).
 *
 * Provides a unified view of pending observations and actions the user
 * can take on them. Bridges the ObservationStore with the autonomy loop
 * via the EventBus.
 */
import type { ObservationStore } from "../sensors/_a-stub.js";
import type { EventBus } from "../ipc/event-bus.js";

export interface PendingSurfaceItem {
  id: number;
  sensorName: string;
  observation: string;
  urgency: number;
  suggestedAction?: string;
  sampledAt: Date;
}

/** Actions the user can take on a pending surface item. */
export type SurfaceAction = "reply" | "commit" | "skip" | "never";

/** Duration constants in milliseconds. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Map sensor names to default suggested actions. */
const ACTION_SUGGESTIONS: Record<string, string> = {
  "unsent-drafts": "[Reply]",
  "git-dirty": "[Commit]",
  "focus-violation": "[Close App]",
  "app-attention": "[Switch]",
};

/**
 * The Pending Surface is the user-facing observation list.
 *
 * It reads from ObservationStore.pending(), sorts by urgency descending,
 * and provides action methods that update the store and optionally emit
 * events for the autonomy loop.
 */
export class PendingSurface {
  constructor(
    private readonly store: ObservationStore,
    private readonly bus?: EventBus,
  ) {}

  /**
   * List pending observations sorted by urgency (highest first).
   * @param limit Maximum items to return (default 20).
   */
  list(limit = 20): PendingSurfaceItem[] {
    const pending = this.store.pending();
    const sorted = pending.sort((a, b) => b.urgency - a.urgency);
    return sorted.slice(0, limit).map((obs) => ({
      id: obs.id,
      sensorName: obs.sensorName,
      observation: obs.observation,
      urgency: obs.urgency,
      suggestedAction: ACTION_SUGGESTIONS[obs.sensorName],
      sampledAt: obs.sampledAt,
    }));
  }

  /**
   * Act on a pending observation.
   *
   * - `skip` suppresses the item for 24 hours.
   * - `never` suppresses the entire sensor type for ~1 year.
   * - `reply` / `commit` marks the item as acted-on and emits a task
   *   event on the bus so the autonomy loop can handle it.
   */
  actOn(id: number, action: SurfaceAction): void {
    const now = Date.now();

    switch (action) {
      case "skip":
        this.store.suppress(id, new Date(now + TWENTY_FOUR_HOURS_MS));
        break;

      case "never": {
        // Find the sensor name for this observation
        const items = this.store.pending();
        const item = items.find((o) => o.id === id);
        if (item) {
          this.store.suppressByType(
            item.sensorName,
            new Date(now + ONE_YEAR_MS),
          );
        }
        break;
      }

      case "reply":
      case "commit":
        this.store.markActedOn(id);
        if (this.bus) {
          this.bus.emit({
            kind: "done",
            payload: { surfaceAction: action, observationId: id },
            ts: new Date(),
          });
        }
        break;
    }
  }

  /**
   * Suppress all observations from a given sensor type.
   * @param sensorName The sensor to suppress.
   * @param hours Duration in hours (default 24).
   */
  suppressType(sensorName: string, hours = 24): void {
    const durationMs = hours * 60 * 60 * 1000;
    this.store.suppressByType(sensorName, new Date(Date.now() + durationMs));
  }
}
