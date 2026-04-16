/**
 * Common sensor interface for the proactive-awareness subsystem (plan §5.7).
 *
 * Every sensor implements this contract. The SensorManager polls sensors at
 * their declared interval and routes non-null observations through the
 * ObservationStore and EventBus.
 *
 * Privacy: `local-only` sensors never send data to an LLM.
 * `llm-on-action` sensors may share the observation text with the LLM only
 * when the user acts on the pending surface item.
 */

/** A single observation produced by a sensor. */
export interface SensorSample {
  sensorName: string;
  observation: string;
  urgency: number; // 0..1
  data?: Record<string, unknown>;
  sampledAt: Date;
}

/** Contract every sensor must implement. */
export interface Sensor {
  /** Unique machine-readable name (e.g. "system-health"). */
  name: string;

  /** Human-readable description for settings UI. */
  description: string;

  /** OS-level permissions the sensor needs (informational). */
  permissionsRequired: string[];

  /**
   * `local-only` — observation never leaves the device.
   * `llm-on-action` — observation may be sent to the LLM when user acts.
   */
  privacyLevel: "local-only" | "llm-on-action";

  /** Minimum milliseconds between samples. */
  interval: number;

  /** Whether this sensor is currently active. */
  enabled: boolean;

  /**
   * Produce an observation or `null` if nothing noteworthy.
   * Must never throw — implementations should catch internally.
   */
  sample(): Promise<SensorSample | null>;
}
