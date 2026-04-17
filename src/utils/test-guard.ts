/**
 * Global test-mode guard.
 *
 * When `CORTEXOS_TEST=1` is set (the `npm test` script sets it), any
 * code that would shell out to a real macOS binary (say, osascript, sox,
 * ffmpeg) should check this flag and no-op. This prevents tests from
 * triggering Siri, playing audio, or mutating the real system.
 *
 * Production code should NEVER set this env var.
 */
export function isTestMode(): boolean {
  return process.env.CORTEXOS_TEST === "1";
}
