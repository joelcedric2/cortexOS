import type { TmuxManager } from "../tmux/tmux-manager.js";

export interface CaptureOptions {
  tmux: TmuxManager;
  sessionName: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const TIMEOUT_FALLBACK = "I took too long thinking about that.";
const EMPTY_FALLBACK =
  "I processed that but couldn't extract a clear response.";

/**
 * Prompt markers that indicate Claude Code has finished generating
 * and is waiting for the next user input.
 */
const PROMPT_MARKERS = ["❯", "> "];

/**
 * After sending a message to the Claude CLI pane, poll until the response
 * is complete (prompt reappears) and extract the assistant's reply text.
 * Never throws — returns a fallback string on timeout or empty extraction.
 */
export async function captureResponse(opts: CaptureOptions): Promise<string> {
  const {
    tmux,
    sessionName,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = opts;

  const deadline = Date.now() + timeoutMs;

  // Wait a beat before the first poll so the CLI has time to echo the input
  await sleep(pollIntervalMs);

  // Capture the initial state so we can detect new output
  let lastPane = "";

  while (Date.now() < deadline) {
    const raw = await tmux.capturePane(sessionName, 5000);

    if (isResponseComplete(raw, lastPane)) {
      // The pane shows a prompt marker after new content — extraction time
      const reply = extractReply(raw, "");
      return reply;
    }

    lastPane = raw;
    await sleep(pollIntervalMs);
  }

  // Timed out — try to salvage whatever text is available
  try {
    if (lastPane) {
      const partial = extractReplyPartial(lastPane);
      if (partial) {
        return partial;
      }
    }
  } catch {
    // Ignore extraction errors on timeout path
  }

  return TIMEOUT_FALLBACK;
}

/**
 * Detect whether the response is complete by checking if a prompt marker
 * appears on the last non-empty line of new pane content.
 */
function isResponseComplete(currentPane: string, _previousPane: string): boolean {
  const lines = currentPane.split("\n");
  // Walk backwards to find the last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = stripAnsi(lines[i]).trim();
    if (trimmed.length === 0) continue;
    return PROMPT_MARKERS.some((marker) => trimmed.startsWith(marker));
  }
  return false;
}

/**
 * Strip all ANSI escape sequences and non-printable control characters
 * from terminal text, preserving newlines and carriage returns.
 */
export function stripAnsi(text: string): string {
  return (
    text
      // CSI sequences: ESC [ (optional ?) digits/semicolons letter
      .replace(/\x1B\[\??[0-9;]*[A-Za-z]/g, "")
      // OSC sequences: ESC ] ... BEL
      .replace(/\x1B\][^\x07]*\x07/g, "")
      // OSC sequences terminated by ST (ESC \)
      .replace(/\x1B\][^\x1B]*\x1B\\/g, "")
      // Charset selection: ESC ( or ESC ) followed by charset designator
      .replace(/\x1B[()][AB012]/g, "")
      // Other two-byte escape sequences (ESC followed by a single char)
      .replace(/\x1B[^[\]()][A-Za-z0-9]?/g, "")
      // Control characters except \n (0x0A) and \r (0x0D)
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, "")
  );
}

/**
 * Lines that are Claude Code chrome / tool-use formatting rather than
 * the assistant's actual reply text.
 */
const TOOL_USE_PREFIXES = ["┌", "│", "└", "├", "─"];
const STATUS_PREFIXES = ["✓", "✗", "⏳"];

/**
 * Patterns for lines that should be stripped entirely.
 */
function isChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;

  // Tool-use box drawing
  if (TOOL_USE_PREFIXES.some((p) => trimmed.startsWith(p))) return true;

  // Status/spinner lines
  if (STATUS_PREFIXES.some((p) => trimmed.startsWith(p))) return true;

  // "Thinking..." or spinner text
  if (/^(Thinking|⏳\s*Thinking)\s*\.{0,3}\s*$/i.test(trimmed)) return true;

  // Progress indicators like "  ■■■■□□□□"
  if (/^[■□▪▫●○\s]+$/.test(trimmed)) return true;

  // Lines that are just the prompt marker
  if (PROMPT_MARKERS.some((m) => trimmed === m || trimmed === m.trim()))
    return true;

  // Tool invocation headers: "Read src/file.ts", "Edit src/file.ts", "Bash cmd", "Write path"
  // These appear as bold text in the CLI after ANSI is stripped
  if (/^(Read|Edit|Write|Bash|Search|Glob|Grep|TodoRead|TodoWrite)\b/.test(trimmed))
    return true;

  // Lines like "(no output)" from tool results
  if (/^\(no output\)$/.test(trimmed)) return true;

  return false;
}

/**
 * Strip lightweight markdown formatting to produce TTS-clean text.
 */
function stripMarkdown(text: string): string {
  return (
    text
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      // Italic: *text* or _text_  (single)
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
      .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "$1")
      // Inline code: `text`
      .replace(/`([^`]+)`/g, "$1")
      // Headers: # text
      .replace(/^#{1,6}\s+/gm, "")
      // Bullet points: - text or * text
      .replace(/^[\s]*[-*]\s+/gm, "")
      // Numbered lists: 1. text
      .replace(/^[\s]*\d+\.\s+/gm, "")
  );
}

/**
 * Extract the assistant's reply from raw tmux pane output.
 *
 * If `sentMessage` is provided and found in the pane, only text AFTER the
 * last occurrence of that message is considered. The reply is the last
 * contiguous block of non-chrome text before a prompt marker.
 *
 * @param rawPane - Full captured pane content (may contain ANSI codes)
 * @param sentMessage - The message that was sent to the CLI (optional)
 * @returns Cleaned reply text suitable for TTS, or a fallback string
 */
export function extractReply(rawPane: string, sentMessage: string): string {
  const clean = stripAnsi(rawPane);

  // Find the region of interest: after the last occurrence of sentMessage
  let region = clean;
  if (sentMessage && sentMessage.trim().length > 0) {
    const lastIdx = clean.lastIndexOf(sentMessage.trim());
    if (lastIdx !== -1) {
      region = clean.slice(lastIdx + sentMessage.trim().length);
    }
  }

  const lines = region.split("\n");

  // Find the last prompt marker position
  let lastPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (PROMPT_MARKERS.some((m) => trimmed.startsWith(m))) {
      lastPromptIdx = i;
      break;
    }
  }

  // Take everything before the last prompt marker (or all lines if no marker found)
  const candidateLines =
    lastPromptIdx >= 0 ? lines.slice(0, lastPromptIdx) : lines;

  // Filter out chrome/tool-use lines and collect reply blocks
  const replyLines: string[] = [];
  for (const line of candidateLines) {
    if (!isChromeLine(line)) {
      replyLines.push(line.trim());
    }
  }

  if (replyLines.length === 0) {
    return EMPTY_FALLBACK;
  }

  // Join, strip markdown, collapse whitespace
  let result = replyLines.join(" ");
  result = stripMarkdown(result);
  // Collapse multiple spaces / newlines into single space
  result = result.replace(/\s+/g, " ").trim();

  return result || EMPTY_FALLBACK;
}

/**
 * Best-effort extraction for timeout scenarios where no prompt marker appeared.
 * Grabs the last non-chrome text block from the pane.
 */
function extractReplyPartial(rawPane: string): string | null {
  const clean = stripAnsi(rawPane);
  const lines = clean.split("\n");

  // Walk backwards, collect non-chrome lines until we hit chrome or start
  const replyLines: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) {
      if (replyLines.length > 0) break; // gap after reply block
      continue;
    }
    if (isChromeLine(lines[i])) {
      if (replyLines.length > 0) break;
      continue;
    }
    // Skip prompt lines
    if (PROMPT_MARKERS.some((m) => trimmed.startsWith(m))) {
      if (replyLines.length > 0) break;
      continue;
    }
    replyLines.unshift(trimmed);
  }

  if (replyLines.length === 0) return null;

  let result = replyLines.join(" ");
  result = stripMarkdown(result);
  result = result.replace(/\s+/g, " ").trim();
  return result || null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
