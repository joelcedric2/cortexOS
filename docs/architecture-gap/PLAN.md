# Architecture Gap Close — Voice ↔ cortexOS Deep Integration

## The Problem

`claude -p` is a stateless one-shot that bypasses everything we built:
- No SOUL.md personality
- No pgvector memory recall
- No research loop
- No resourcefulness ladder
- No MCP tools (can't even run `date`)
- No learning/evolution
- No conversation history

Additionally:
- Wake-word detector picks up TTS output (echo)
- Groq transcribes Nchinda's own speech as "[Cedric]"

## The Fix — 6 Agents

### Agent 1: Persistent Brain Session
Replace `claude -p` with a persistent Claude Code CLI in a tmux pane.

**Files**: `src/voice/brain-session.ts`

```ts
export class BrainSession {
  private sessionName = "nchinda_brain";
  
  async boot(workDir: string): Promise<void>;
  async send(message: string): Promise<string>;
  async isAlive(): Promise<boolean>;
  async restart(): Promise<void>;
  shutdown(): Promise<void>;
}
```

Flow:
- On cortexOS boot: `tmux new-session -d -s nchinda_brain -c <workDir>`
- Start claude in the pane: `tmux send-keys -t nchinda_brain "claude" Enter`
- The working dir has SOUL.md + CLAUDE.md with all cortexOS context
- To send a voice command: `tmux send-keys -t nchinda_brain "<transcript>" Enter`
- To capture response: poll `tmux capture-pane -p -t nchinda_brain` until the prompt (❯) returns
- Parse the response text between the user input and the next prompt
- This session persists — conversation history, tools, context all maintained

The CLAUDE.md in the brain's working dir should include:
- SOUL.md content (personality)
- Available MCP tools list
- Instructions to use tools (date, web search, shell) before guessing
- Instructions to check memory before answering
- Voice mode instructions (reply conversationally for TTS)

### Agent 2: Echo Suppression
Stop the wake-word detector from picking up TTS output.

**Files**: `src/voice/echo-gate.ts`, edits to `voice-orchestrator.ts`

```ts
export class EchoGate {
  private muted = false;
  mute(): void;    // called before TTS speaks
  unmute(): void;  // called after TTS finishes + 1s decay
  isMuted(): boolean;
}
```

Wire into wake-word: if `echoGate.isMuted()`, skip the Groq transcription for that chunk — just discard the audio. Don't log it as "[Cedric]".

Wire into orchestrator: `echoGate.mute()` before every `tts.speak()`, `echoGate.unmute()` after speak resolves + 1s delay.

### Agent 3: Brain CLAUDE.md Generator
Generate the CLAUDE.md that goes into the brain session's working directory. This is the "context injection" that makes the brain session aware of all cortexOS capabilities.

**Files**: `src/voice/brain-context.ts`

```ts
export async function buildBrainClaudeMd(deps: {
  soul: string;           // SOUL.md content
  tools: string[];        // available MCP tool names + descriptions
  recentMemories: string; // top-k from pgvector
  userName: string;
}): Promise<string>;
```

The generated CLAUDE.md should contain:
1. SOUL.md verbatim
2. Voice mode rules: "Your replies will be spoken aloud via TTS. Be conversational, concise, no markdown, no code blocks. Use tools before guessing."
3. Tool usage rules: "You have access to bash. ALWAYS run `date` for time questions. ALWAYS use web search or fetch for factual questions. Check your memory before starting any task."
4. MCP tool summary: list every nchinda_* tool with a one-line description
5. Recent memories: top-5 relevant memories from pgvector
6. User profile: name, preferences from SOUL.md §What you know about Cedric

### Agent 4: Response Capture + Parse
Capture the brain session's response from tmux and extract clean text for TTS.

**Files**: `src/voice/pane-capture.ts`

```ts
export async function captureResponse(
  sessionName: string,
  sentText: string,
  timeoutMs?: number,
): Promise<string>;
```

Algorithm:
- After sending text via send-keys, poll `tmux capture-pane -p -t <session>` every 500ms
- Look for the Claude Code prompt marker (❯ or the ready indicator)
- Extract text between the sent message and the prompt marker
- Strip ANSI escape codes, tool-use formatting, thinking tags
- Return clean text suitable for TTS
- Timeout at 2 minutes

### Agent 5: Voice Pipeline Rewire
Rewire the voice orchestrator's `onTask` to use the BrainSession instead of `claude -p`.

**Files**: edits to `src/controller/cortex.ts`, `src/voice/voice-orchestrator.ts`

Replace the `claude -p` spawn logic with:
```ts
const onTask = async (transcript, narrate) => {
  // Send to persistent brain session
  const reply = await brainSession.send(transcript);
  return reply;
};
```

Also:
- Boot the brain session in `CortexController.initialize()`
- Shut it down in `shutdown()`
- If the brain session dies, auto-restart it
- Wire the narration: subscribe to bus events and narrate agent completions during long tasks

### Agent 6: Integration + Memory Loop Closure
Wire the learning loop so voice interactions persist to pgvector and future sessions benefit from past conversations.

**Files**: edits to `src/controller/cortex.ts`, `src/voice/voice-orchestrator.ts`

After every voice interaction:
1. Store the transcript + reply in pgvector: `vectorStore.storeMemory({agentRole: 'nchinda-voice', taskType: 'voice_interaction', content: "Q: <transcript> A: <reply>", outcome: 'success', tags: ['voice', sessionLabel]})`
2. On next brain session boot, recall top-5 recent voice interactions and inject into the CLAUDE.md
3. If the reply was bad (user interrupts, says "no that's wrong", etc.), store with `outcome: 'fail'` and tag as anti-pattern

This closes the learning loop: voice interactions → memory → future context → better replies.

## Testing — 3 Agents

### Tester 1: Integration
- Boot cortexOS, verify brain session spawns in tmux
- Send a transcript via BrainSession.send(), verify response captured
- Verify CLAUDE.md in brain working dir contains SOUL.md + tools + memories
- Verify echo gate suppresses TTS during playback

### Tester 2: End-to-End Voice Flow
- Full wake → listen → transcribe → brain session → reply → TTS
- "What time is it?" → should use `date` command, not guess
- "Search for the latest Claude model" → should use web search
- Verify no echo in logs (no TTS output logged as [Cedric])

### Tester 3: Memory + Learning
- Complete a voice interaction → verify it's stored in pgvector
- Boot a new brain session → verify recent interactions are in CLAUDE.md
- Send a similar question → verify the reply references prior context
