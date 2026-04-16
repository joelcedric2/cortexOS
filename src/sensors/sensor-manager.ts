/**
 * Sensor orchestrator for the proactive-awareness subsystem (plan §5.7).
 *
 * Runs a periodic sweep, calling each enabled sensor whose interval has
 * elapsed. Non-null samples are stored in the ObservationStore and emitted
 * on the EventBus. Sensor failures are logged but never propagate.
 */
import type { EventBus } from "../ipc/event-bus.js";
import type { Sensor, SensorSample } from "./sensor.js";
import type { ObservationStore } from "./observation-store.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface SensorManagerOptions {
  bus: EventBus;
  sensors: Sensor[];
  store: ObservationStore;
  /** Milliseconds between sweep ticks. Default 60 000 (1 min). */
  tickIntervalMs?: number;
  /** Optional logger — defaults to console.error. */
  log?: (msg: string) => void;
}

// ─── State per sensor ────────────────────────────────────────────────────────

interface SensorState {
  sensor: Sensor;
  lastSample?: Date;
}

// ─── Class ───────────────────────────────────────────────────────────────────

export class SensorManager {
  private readonly bus: EventBus;
  private readonly store: ObservationStore;
  private readonly states: Map<string, SensorState> = new Map();
  private readonly tickMs: number;
  private readonly log: (msg: string) => void;

  private timer: ReturnType<typeof setInterval> | undefined;
  private paused = false;

  constructor(opts: SensorManagerOptions) {
    this.bus = opts.bus;
    this.store = opts.store;
    this.tickMs = opts.tickIntervalMs ?? 60_000;
    this.log = opts.log ?? console.error;

    for (const sensor of opts.sensors) {
      this.states.set(sensor.name, { sensor });
    }
  }

  /** Start the periodic sweep timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // Also fire immediately on start
    void this.tick();
  }

  /** Stop the periodic sweep timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Enable a sensor by name. */
  enableSensor(name: string): void {
    const state = this.states.get(name);
    if (state) {
      state.sensor.enabled = true;
    }
  }

  /** Disable a sensor by name. */
  disableSensor(name: string): void {
    const state = this.states.get(name);
    if (state) {
      state.sensor.enabled = false;
    }
  }

  /** Pause all sensors without clearing the timer. */
  pauseAll(): void {
    this.paused = true;
  }

  /** Resume all sensors after a pause. */
  resumeAll(): void {
    this.paused = false;
  }

  /** Return the current state of all registered sensors. */
  getSensorStates(): Array<{ name: string; enabled: boolean; lastSample?: Date }> {
    const result: Array<{ name: string; enabled: boolean; lastSample?: Date }> = [];
    for (const [name, state] of this.states) {
      result.push({
        name,
        enabled: state.sensor.enabled,
        lastSample: state.lastSample,
      });
    }
    return result;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.paused) return;

    const now = Date.now();

    for (const [, state] of this.states) {
      if (!state.sensor.enabled) continue;

      // Check if enough time has elapsed since last sample
      if (state.lastSample) {
        const elapsed = now - state.lastSample.getTime();
        if (elapsed < state.sensor.interval) continue;
      }

      try {
        const sample = await state.sensor.sample();
        state.lastSample = new Date();

        if (sample) {
          this.store.insert(sample);
          this.bus.emit({
            kind: "plan_emitted",
            payload: {
              phase: "SENSOR_OBSERVATION",
              sensorName: sample.sensorName,
              observation: sample.observation,
              urgency: sample.urgency,
              data: sample.data,
              sampledAt: sample.sampledAt,
            },
            ts: new Date(),
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[SensorManager] sensor "${state.sensor.name}" failed: ${msg}`);
      }
    }
  }
}
