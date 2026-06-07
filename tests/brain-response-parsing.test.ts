import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  stripAnsi,
  stripFormattingForTTS,
  BrainSession,
} from "../src/voice/brain-session.js";

// ---------------------------------------------------------------------------
// Access private/non-exported helpers via the module for testing.
// hasReadyPrompt is module-private, so we replicate its logic here to test
// the contract. extractResponse is a private method on BrainSession — we
// test it through a thin wrapper that instantiates the class with a mock.
// ---------------------------------------------------------------------------

/**
 * Mirrors the hasReadyPrompt() logic from brain-session.ts.
 * We test the contract rather than importing the private function.
 */
function hasReadyPrompt(output: string): boolean {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const tail = lines.slice(-6).join("\n");
  if (tail.includes("esc to interrupt")) return false;
  if (tail.includes("Ionizing") || tail.includes("Thinking")) return false;
  return tail.includes("❯");
}

/**
 * Helper to call the private extractResponse method on a BrainSession
 * instance. Uses `as any` to bypass TypeScript visibility.
 */
function extractResponse(paneOutput: string, sentMessage: string): string {
  const mockTmux = {
    createSession: async () => {},
    destroySession: async () => {},
    sessionExists: async () => false,
    sendKeys: async () => {},
    capturePane: async () => "",
  };
  const brain = new BrainSession({
    tmux: mockTmux as any,
    workDir: "/tmp/test",
  });
  return (brain as any).extractResponse(paneOutput, sentMessage);
}

// ---------------------------------------------------------------------------
// Realistic Claude CLI pane output fixtures
// ---------------------------------------------------------------------------

const PANE_FULL_RESPONSE = [
  "❯ What time is it?",
  "",
  "⏺ Bash(date)",
  "  ⎿  Fri Apr 17 11:02:49 CDT 2026",
  "",
  "⏺ It's 11:02 AM Central, Sir.",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

const PANE_STILL_THINKING = [
  "❯ Explain quantum entanglement",
  "",
  "⏺ Let me think about this...",
  "",
  "  esc to interrupt",
].join("\n");

const PANE_IONIZING = [
  "Ionizing neural pathways...",
  "❯ ",
].join("\n");

const PANE_THINKING_LABEL = [
  "Thinking...",
  "❯ something",
].join("\n");

const PANE_IDLE_READY = [
  "Welcome to Claude Code",
  "",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

const PANE_MULTI_RESPONSE = [
  "❯ What's the weather?",
  "",
  "⏺ Bash(curl wttr.in)",
  "  ⎿  Partly cloudy, 72°F",
  "",
  "⏺ It's partly cloudy and 72 degrees right now.",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ What time is it?",
  "",
  "⏺ Bash(date)",
  "  ⎿  Fri Apr 17 11:02:49 CDT 2026",
  "",
  "⏺ It's 11:02 AM Central, Sir.",
  "",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

// ---------------------------------------------------------------------------
// hasReadyPrompt tests
// ---------------------------------------------------------------------------

describe("hasReadyPrompt", () => {
  test("returns true when prompt and shortcuts hint present", () => {
    assert.equal(hasReadyPrompt(PANE_IDLE_READY), true);
  });

  test("returns true for full response with trailing prompt", () => {
    assert.equal(hasReadyPrompt(PANE_FULL_RESPONSE), true);
  });

  test("returns false when 'esc to interrupt' is in tail (still thinking)", () => {
    assert.equal(hasReadyPrompt(PANE_STILL_THINKING), false);
  });

  test("returns false when 'Ionizing' is present", () => {
    assert.equal(hasReadyPrompt(PANE_IONIZING), false);
  });

  test("returns false when 'Thinking' is present", () => {
    assert.equal(hasReadyPrompt(PANE_THINKING_LABEL), false);
  });

  test("returns true for empty prompt followed by separator and hints", () => {
    const output = [
      "❯ ",
      "────────────────────────────────────────",
      "  ? for shortcuts",
    ].join("\n");
    assert.equal(hasReadyPrompt(output), true);
  });

  test("returns false for empty input", () => {
    assert.equal(hasReadyPrompt(""), false);
  });

  test("returns false for whitespace-only input", () => {
    assert.equal(hasReadyPrompt("   \n  \n   "), false);
  });

  test("returns true when prompt is in last 5 non-empty lines", () => {
    const output = [
      "Some earlier output",
      "More earlier output",
      "❯ ",
      "────────────",
      "  ? for shortcuts",
    ].join("\n");
    assert.equal(hasReadyPrompt(output), true);
  });
});

// ---------------------------------------------------------------------------
// extractResponse tests
// ---------------------------------------------------------------------------

describe("extractResponse", () => {
  test("extracts clean text between sent message and next prompt", () => {
    const result = extractResponse(PANE_FULL_RESPONSE, "What time is it?");
    assert.ok(result.includes("11:02 AM Central"), `got: "${result}"`);
  });

  test("strips tool-use lines (Bash invocation)", () => {
    const result = extractResponse(PANE_FULL_RESPONSE, "What time is it?");
    assert.ok(!result.includes("Bash(date)"), `tool line leaked: "${result}"`);
  });

  test("strips tool output lines (⎿ prefix)", () => {
    const result = extractResponse(PANE_FULL_RESPONSE, "What time is it?");
    assert.ok(!result.includes("⎿"), `tool output leaked: "${result}"`);
    assert.ok(!result.includes("Fri Apr 17"), `raw date leaked: "${result}"`);
  });

  test("strips separator lines", () => {
    const result = extractResponse(PANE_FULL_RESPONSE, "What time is it?");
    assert.ok(!result.includes("────"), `separator leaked: "${result}"`);
  });

  test("strips hint lines (? for shortcuts)", () => {
    const result = extractResponse(PANE_FULL_RESPONSE, "What time is it?");
    assert.ok(!result.includes("shortcut"), `hint leaked: "${result}"`);
  });

  test("strips ⏺ prefix from response text", () => {
    const pane = [
      "❯ Hello",
      "",
      "⏺ Hi there, how can I help?",
      "",
      "❯ ",
    ].join("\n");
    const result = extractResponse(pane, "Hello");
    assert.equal(result, "Hi there, how can I help?");
  });

  test("keeps actual response content intact", () => {
    const pane = [
      "❯ Tell me a joke",
      "",
      "⏺ Why did the chicken cross the road? To get to the other side!",
      "",
      "❯ ",
    ].join("\n");
    const result = extractResponse(pane, "Tell me a joke");
    assert.ok(result.includes("chicken cross the road"), `got: "${result}"`);
  });

  test("returns empty string when message not found", () => {
    const result = extractResponse(PANE_FULL_RESPONSE, "This was never sent");
    assert.equal(result, "");
  });

  test("handles multi-turn pane — extracts last response only", () => {
    const result = extractResponse(PANE_MULTI_RESPONSE, "What time is it?");
    assert.ok(result.includes("11:02 AM Central"), `got: "${result}"`);
    // Should NOT contain the weather response
    assert.ok(!result.includes("72 degrees"), `old response leaked: "${result}"`);
  });

  test("filters standalone ⏺ bullet", () => {
    const pane = [
      "❯ test",
      "",
      "⏺",
      "⏺ Actual content here.",
      "",
      "❯ ",
    ].join("\n");
    const result = extractResponse(pane, "test");
    assert.equal(result, "Actual content here.");
  });

  test("handles real Claude CLI output format", () => {
    const realisticPane = [
      "╭────────────────────────────────────────────────────────────╮",
      "│ Welcome to Claude Code                                     │",
      "╰────────────────────────────────────────────────────────────╯",
      "",
      "❯ What time is it?",
      "",
      "⏺ Bash(date)",
      "  ⎿  Fri Apr 17 11:02:49 CDT 2026",
      "",
      "⏺ It's 11:02 AM Central, Sir.",
      "",
      "────────────────────────────────────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────────────────────────────────────",
      "  ? for shortcuts",
    ].join("\n");
    const result = extractResponse(realisticPane, "What time is it?");
    assert.ok(result.includes("11:02 AM Central"), `got: "${result}"`);
    assert.ok(!result.includes("Bash"), `tool line leaked: "${result}"`);
    assert.ok(!result.includes("⎿"), `tool output leaked: "${result}"`);
  });
});

// ---------------------------------------------------------------------------
// stripFormattingForTTS tests
// ---------------------------------------------------------------------------

describe("stripFormattingForTTS", () => {
  test("removes thinking tags", () => {
    const input = "<thinking>I need to consider this carefully</thinking>The answer is 42.";
    assert.equal(stripFormattingForTTS(input), "The answer is 42.");
  });

  test("removes code fences", () => {
    const input = "Here is code:\n```typescript\nconst x = 1;\n```\nDone.";
    assert.equal(stripFormattingForTTS(input), "Here is code:\n\nDone.");
  });

  test("removes markdown headers", () => {
    const input = "# Title\n## Section\nContent here";
    const result = stripFormattingForTTS(input);
    assert.ok(!result.includes("#"), `headers remain: "${result}"`);
    assert.ok(result.includes("Title"), `title lost: "${result}"`);
    assert.ok(result.includes("Content here"), `content lost: "${result}"`);
  });

  test("removes bold markers but keeps text", () => {
    const input = "This is **bold** text.";
    assert.equal(stripFormattingForTTS(input), "This is bold text.");
  });

  test("removes italic markers but keeps text", () => {
    const input = "This is *italic* text.";
    assert.equal(stripFormattingForTTS(input), "This is italic text.");
  });

  test("removes triple bold/italic markers", () => {
    const input = "This is ***bold italic*** text.";
    assert.equal(stripFormattingForTTS(input), "This is bold italic text.");
  });

  test("removes inline code", () => {
    const input = "Run the `npm install` command.";
    assert.equal(stripFormattingForTTS(input), "Run the  command.");
  });

  test("removes tool_use blocks", () => {
    const input = "Checking.\n<tool_use>bash ls</tool_use>\nDone.";
    assert.equal(stripFormattingForTTS(input), "Checking.\n\nDone.");
  });

  test("removes result blocks", () => {
    const input = "Here.\n<result>file list</result>\nDone.";
    assert.equal(stripFormattingForTTS(input), "Here.\n\nDone.");
  });

  test("preserves natural speech text", () => {
    const input = "It's currently 11:02 AM Central time, Sir. The weather is partly cloudy.";
    assert.equal(stripFormattingForTTS(input), input);
  });

  test("collapses excessive newlines", () => {
    const input = "First.\n\n\n\n\nSecond.";
    assert.equal(stripFormattingForTTS(input), "First.\n\nSecond.");
  });

  test("handles mixed formatting in a single block", () => {
    const input = [
      "<thinking>Let me check</thinking>",
      "## Weather Report",
      "It's **72 degrees** and `partly cloudy`.",
      "```json",
      '{"temp": 72}',
      "```",
      "Have a great day!",
    ].join("\n");
    const result = stripFormattingForTTS(input);
    assert.ok(result.includes("72 degrees"), `temp lost: "${result}"`);
    assert.ok(result.includes("Have a great day"), `closing lost: "${result}"`);
    assert.ok(!result.includes("<thinking>"), `thinking leaked: "${result}"`);
    assert.ok(!result.includes("```"), `code fence leaked: "${result}"`);
    assert.ok(!result.includes("##"), `header leaked: "${result}"`);
  });
});

// ---------------------------------------------------------------------------
// stripAnsi tests (extended — complements the existing brain-session.test.ts)
// ---------------------------------------------------------------------------

describe("stripAnsi (extended)", () => {
  test("removes ANSI color codes", () => {
    const input = "\x1B[31mred\x1B[0m normal \x1B[1;34mbold blue\x1B[0m";
    assert.equal(stripAnsi(input), "red normal bold blue");
  });

  test("removes cursor movement sequences", () => {
    const input = "\x1B[2A\x1B[3Bhello\x1B[K";
    assert.equal(stripAnsi(input), "hello");
  });

  test("removes OSC hyperlinks (ST-terminated)", () => {
    const input = "\x1B]8;;https://example.com\x1B\\Click here\x1B]8;;\x1B\\";
    assert.equal(stripAnsi(input), "Click here");
  });

  test("removes BEL-terminated OSC sequences", () => {
    const input = "before\x1B]0;Window Title\x07after";
    assert.equal(stripAnsi(input), "beforeafter");
  });

  test("preserves regular text untouched", () => {
    const input = "Hello, world! 42 degrees. It's 11:02 AM.";
    assert.equal(stripAnsi(input), input);
  });

  test("handles multiple ANSI codes in sequence", () => {
    const input = "\x1B[1m\x1B[34m❯\x1B[0m What time is it?";
    assert.equal(stripAnsi(input), "❯ What time is it?");
  });

  test("removes charset selection sequences", () => {
    const input = "hello\x1B(Bworld";
    assert.equal(stripAnsi(input), "helloworld");
  });
});
