/**
 * Echo suppression gate — prevents the wake-word detector from picking up
 * Nchinda's own TTS output through the speakers.
 *
 * Usage:
 *   echoGate.mute()          — call before TTS starts speaking
 *   echoGate.unmute(1500)    — call after TTS finishes + decay time for echo
 *   echoGate.isMuted()       — check if audio should be discarded
 *
 * While muted, the wake-word detector still runs its sox recording loop
 * (to keep timing consistent) but skips Groq transcription entirely —
 * no wasted API calls, no false "[Cedric]" transcripts.
 */

export class EchoGate {
  private muted = false;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;

  /** Call before TTS starts speaking. */
  mute(): void {
    this.muted = true;
    // Clear any pending unmute timer — a new mute supersedes it.
    if (this.muteTimer) {
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }
  }

  /**
   * Call after TTS finishes. Unmute is delayed by `decayMs` to allow
   * residual echo to dissipate before the mic resumes transcription.
   *
   * @param decayMs — milliseconds to wait after TTS ends (default 1500).
   */
  unmute(decayMs = 1500): void {
    this.muteTimer = setTimeout(() => {
      this.muted = false;
      this.muteTimer = null;
    }, decayMs);
  }

  /** Check if audio should be discarded (TTS is playing or echoing). */
  isMuted(): boolean {
    return this.muted;
  }

  /** Clean up any pending timer. Call on shutdown. */
  dispose(): void {
    if (this.muteTimer) {
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }
    this.muted = false;
  }
}
