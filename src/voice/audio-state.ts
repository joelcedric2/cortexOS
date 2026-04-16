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

const VALID_TRANSITIONS: Record<AudioState, ReadonlyArray<AudioState>> = {
  idle:      ['listening', 'speaking', 'error'],
  listening: ['thinking', 'idle', 'error'],
  thinking:  ['speaking', 'idle', 'error'],
  speaking:  ['idle', 'listening', 'error'],
  error:     ['idle'],
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
