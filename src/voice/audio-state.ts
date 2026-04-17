/**
 * Audio state machine for voice I/O pipeline.
 * Pure state machine — no I/O. Emits events to registered listeners.
 * Used by the WS bridge (Agent B) and waveform UI (Phase 6).
 */

export type AudioState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface AudioStateEvent {
  state: AudioState;
  rms: number;
  caption?: string;
  ts: Date;
}

// Allow any→any transitions. The voice orchestrator manages the actual
// flow logic; the state machine just tracks + broadcasts current state.
// Strict transitions caused crashes on valid flows (speaking→thinking
// after ack, idle→speaking for greeting, etc.).
const ALL_STATES: AudioState[] = ['idle', 'listening', 'thinking', 'speaking', 'error'];
const VALID_TRANSITIONS: Record<AudioState, ReadonlyArray<AudioState>> = {
  idle:      ALL_STATES,
  listening: ALL_STATES,
  thinking:  ALL_STATES,
  speaking:  ALL_STATES,
  error:     ALL_STATES,
};

export class AudioStateMachine {
  private current: AudioState = 'idle';
  private rms = 0;
  private listeners: Array<(e: AudioStateEvent) => void> = [];

  /**
   * Transition to a new state. Throws on invalid transitions.
   */
  transition(to: AudioState, rms?: number, caption?: string): void {
    const allowed = VALID_TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new Error(
        `Invalid audio state transition: ${this.current} -> ${to}`,
      );
    }

    this.current = to;
    this.rms = rms ?? 0;

    const event: AudioStateEvent = {
      state: this.current,
      rms: this.rms,
      caption,
      ts: new Date(),
    };

    for (const fn of this.listeners) {
      fn(event);
    }
  }

  getState(): AudioState {
    return this.current;
  }

  getRms(): number {
    return this.rms;
  }

  /**
   * Register a state-change listener. Returns an unsubscribe function.
   */
  onStateChange(fn: (e: AudioStateEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) {
        this.listeners.splice(idx, 1);
      }
    };
  }
}
