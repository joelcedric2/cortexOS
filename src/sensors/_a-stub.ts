/**
 * Stubs for Agent A's deliverables that haven't landed yet.
 * These will be replaced by the real implementations once Agent A ships
 * observation-store.ts and sensor-manager.ts.
 */
import type { SensorSample } from "./sensor.js";

export interface StoredObservation {
  id: number;
  sensorName: string;
  observation: string;
  urgency: number;
  data?: Record<string, unknown>;
  sampledAt: Date;
  actedOn: boolean;
  suppressedUntil?: Date;
}

/**
 * Minimal ObservationStore stub matching Agent A's contract.
 * In-memory implementation for testing and early integration.
 */
export class ObservationStore {
  private observations: StoredObservation[] = [];
  private nextId = 1;
  private typeSuppression = new Map<string, Date>();

  insert(sample: SensorSample): number {
    const id = this.nextId++;
    this.observations.push({
      id,
      sensorName: sample.sensorName,
      observation: sample.observation,
      urgency: sample.urgency,
      data: sample.data,
      sampledAt: sample.sampledAt,
      actedOn: false,
    });
    return id;
  }

  pending(): StoredObservation[] {
    const now = new Date();
    return this.observations.filter((o) => {
      if (o.actedOn) return false;
      if (o.suppressedUntil && o.suppressedUntil > now) return false;
      const typeSup = this.typeSuppression.get(o.sensorName);
      if (typeSup && typeSup > now) return false;
      return true;
    });
  }

  markActedOn(id: number): void {
    const obs = this.observations.find((o) => o.id === id);
    if (obs) obs.actedOn = true;
  }

  suppress(id: number, until: Date): void {
    const obs = this.observations.find((o) => o.id === id);
    if (obs) obs.suppressedUntil = until;
  }

  suppressByType(sensorName: string, until: Date): void {
    this.typeSuppression.set(sensorName, until);
  }

  cleanup(olderThan: Date): number {
    const before = this.observations.length;
    this.observations = this.observations.filter(
      (o) => o.sampledAt >= olderThan,
    );
    return before - this.observations.length;
  }
}
