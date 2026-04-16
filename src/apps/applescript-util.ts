/**
 * Shared AppleScript string-escape utility — Phase 12 drivers.
 *
 * There are two conventions in the codebase:
 *
 *   1. **Bare inner** — returns the escape-processed string without
 *      surrounding quotes. Callers wrap `"${quoteASInner(s)}"`.
 *      (Used by mail-driver, messages-driver, calendar-driver.)
 *
 *   2. **Wrapped** — returns the string already surrounded by
 *      AppleScript double-quotes, i.e. `"…escaped…"`.
 *      (Used by safari-driver, notes-driver, reminders-driver,
 *      music-driver, finder-driver.)
 *
 * This module provides **both** exports so every call-site can pick
 * the appropriate one without duplicating the escape logic.
 *
 * Escape rules (AppleScript double-quoted string literal):
 *   - Backslashes doubled first (order matters).
 *   - Double-quotes backslash-escaped.
 *   - Bare \r / \n / \r\n collapsed to a single space (AS literals
 *     may not span lines).
 *   - NUL bytes (`\0`) rejected — they cannot appear inside an AS
 *     string and indicate corrupt or adversarial input.
 *
 * @module
 */

/**
 * Maximum input length before we reject. 200 KB is well above any
 * realistic note body / email / calendar note / search query.
 * Policy-tunable per §7.0.
 */
export const APPLESCRIPT_UTIL_DEFAULTS = Object.freeze({
  maxInputLength: 200_000,
});

/**
 * Throw on NUL bytes or excessively long inputs. Both conditions
 * indicate corrupt or adversarial data; failing early prevents
 * downstream AppleScript parse errors or memory bloat.
 */
function guard(s: string): void {
  if (s.includes("\0")) {
    throw new Error("applescript-util: NUL byte in input (rejected)");
  }
  if (s.length > APPLESCRIPT_UTIL_DEFAULTS.maxInputLength) {
    throw new Error(
      `applescript-util: input length ${s.length} exceeds ${APPLESCRIPT_UTIL_DEFAULTS.maxInputLength}`,
    );
  }
}

/**
 * Escape a user-supplied string for safe interpolation inside an
 * AppleScript double-quoted literal. Returns the **bare inner**
 * content — the caller is responsible for wrapping in `"…"`.
 *
 * @example
 * const script = `set x to "${quoteASInner(userInput)}"`;
 */
export function quoteASInner(s: string): string {
  guard(s);
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}

/**
 * Escape **and wrap** a user-supplied string in AppleScript
 * double-quotes. The returned value is a complete AS string literal.
 *
 * @example
 * const script = `set x to ${quoteAS(userInput)}`;
 */
export function quoteAS(s: string): string {
  return `"${quoteASInner(s)}"`;
}
