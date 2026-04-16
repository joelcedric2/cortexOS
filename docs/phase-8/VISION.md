# Phase 8+ — Perception & Embodiment

> After Phase 7, Nchinda can *think*, *plan*, *act*, *remember*, *speak*, and *learn*.
> Phase 8+ gives it **eyes** (screen + camera), **hands** (window control, typing, app automation), and the **instinct** to volunteer observations the way a colleague would.

---

## 1. What the Omi reels show (ground truth)

Extracted frames from `IMG_2794.PNG` + `9f511a6e… (1m58s POV)` + `278b65d… (43s promo)`. Inferred features:

### 1.1 From the screenshot (Omi for macOS marketing — from `omidotme` Instagram)
- Positioning: "someone just built what feels like Rewind, Granola, Cluely, Wispr, and ChatGPT in one Mac app"
- Capabilities list:
  - **understand what you're looking at**
  - **figure out the next step**
  - **draft, summarize, and answer**
  - **handle tasks across apps**
  - **turn your screen into action**

### 1.2 From the POV demo reel (the 1m58s video)
A first-person, AR-style HUD overlays the user's environment. The frames show:

| Scene | HUD element observed | Implied capability |
|---|---|---|
| Watching a video of a news clip | `TIP: That's not actually Epstein.` + `EVIDENCE: Is Jeffrey Epstein Alive / Viral highway footage debunked` (with sources) | Real-time **fact-check while viewing video content**; pulls + cites evidence |
| Same scene | `FOCUS: Get back to emailing your boss` | **Intent tracking** — remembers what the user should be doing and nudges back on task |
| Email composer open ("Hi Mark,… Compensation Follow Up") | `TIP: Don't apologize` | **Real-time writing coach** — sees draft content + suggests edits live |
| Incoming FaceTime from "Maya <3" | FaceTime mini-PiP appears on the HUD (Sidebar / Camera / Mute / Share / End buttons) | **Overlay notifications** + integrated call controls |
| On FaceTime showing a painting | (waveform listening indicator stays visible) | **Always-on ambient listening** during calls |
| Talking to Maya | `ACTION: Ordering Thai Food for Maya` + `TIP: Should I order for 2 people?` | **Intent extraction from conversation** → proactively offers to execute; asks clarifying questions |
| Full promo | `"omi — For macOS. It sees everything."` | Tagline |

### 1.3 From the 43s creator promo (Kodjima)
- Talking head introducing "omi — for MacOs" as a single product
- Key phrases visible: "takes pictures", "now imagine that", "will look behind", "to make a mistake"
- Implies: screenshot-based perception + proactive error catching ("about to make a mistake")

---

## 2. Gap analysis — what Nchinda is missing today

Mapped against Phases 1–7:

| Omi-demonstrated capability | Nchinda today | Gap |
|---|---|---|
| Always-on screen capture + understanding | `screen_context` sensor **stubbed** in Phase 5.5 (off by default) | Real implementation missing: capture loop, vision call, accessibility tree parse |
| Camera capture on voice request ("what am I looking at?") | Not implemented | Need AVFoundation capture pipeline + vision call |
| Fact-check video content in real time | Not implemented | Audio transcription from active app + claims extraction + source search |
| Draft-aware writing coach ("don't apologize") | Not implemented | Needs accessibility-tree text-field watching + streaming suggestion model |
| Intent tracking across minutes ("get back to emailing your boss") | Partial — `focus-violation` sensor exists but doesn't cross-reference user-declared goals | Need explicit "current focus" state machine + cross-source linking |
| Offer-to-execute on conversational intent ("order Thai for Maya") | `social_send` exists but no intent extraction from voice/conversation | Need conversation intent-classifier + action mapper |
| Desktop app automation at scale (Mail compose, FaceTime controls, Safari tabs) | `cdp_*` (Chrome only) + `social` drivers + iMessage AppleScript | Need native app MCP driver suite (Mail, Messages, Calendar, Safari, Finder, Notes, Music, Reminders) |
| Screen/window organization ("organize terminals, move between screens") | Orchestrator spawns tmux but doesn't position windows | Need macOS window manager bridge (yabai or direct Accessibility/CoreGraphics) |
| "Take over and keep working" | Autonomy loop exists but doesn't chain to screen actions | Need screen-vision → action → verify loop |

---

## 3. Open-source building blocks to fuse

Each repo listed with star count (Apr 2026) + what we take.

### 3.1 Screen + audio observation
- **`BasedHardware/omi`** (8.8k ★) — the Omi itself. Apache-2.0ish. Ships a `desktop/` Tauri app + `mcp/` server. **We can ship their MCP server as a native skill** inside cortexOS and reuse their prompts/events until we re-implement.
- **`mediar-ai/screenpipe`** (18.2k ★) — Rust-based always-on screen + mic recorder with local embedding + search. Apache-2.0. Mature. **Port its capture loop** (ScreenCaptureKit on macOS) as the `screen_context` sensor implementation. Swap its UI for our Mission Control.

### 3.2 Computer-use agents (screen→action loops)
- **`trycua/cua`** (13.5k ★) — infrastructure for computer-use agents with sandboxes + SDKs. Excellent Mac sandbox story.
- **`simular-ai/Agent-S`** (10.9k ★) — agentic framework that uses computers like a human. Uses accessibility tree + vision.
- **`bytebot-ai/bytebot`** (10.8k ★) — self-hosted AI desktop agent with a visual VM.
- **`OthersideAI/self-operating-computer`** (10.2k ★) — multimodal model → computer operation.
- **`microsoft/fara`** (4.9k ★) — Fara-7B efficient agentic model purpose-built for computer use.
- **`deedy/mac_computer_use`** (864 ★) — direct Mac fork of Anthropic's Computer Use demo.
- **`e2b-dev/open-computer-use`** (1.9k ★) — computer-use in E2B sandbox.

**Decision**: don't fuse the whole framework. Take **mac_computer_use** as a reference for mac-native `cliclick`/`pyautogui`+accessibility patterns, then package our own `computer_use.*` MCP tool suite that plugs into the existing AutonomyLoop. CUA's sandbox is for sacrificial runs (skill creation + evolution §3.7).

### 3.3 Window management
- **`koekeishiya/yabai`** (28.7k ★) — tiling WM for macOS. Scriptable via `yabai -m`. We **wrap its CLI** in an MCP driver; users who don't have it installed get a graceful fallback to AppleScript + Accessibility API.
- **`AdamWagner/stackline`** (1k ★) — window-stack visualizer; overlap with yabai but useful signal.
- **`FelixKratz/JankyBorders`** (3.4k ★) — lightweight border highlighter. Nchinda can draw a copper border around the agent pane currently "speaking" — design continuity with the waveform.

### 3.4 App-specific drivers
- Native `osascript` + AppleScript already used for iMessage in Phase 4. Extend to Mail (compose, reply, archive), Messages, Calendar, Safari (tabs, reader), Finder (open, tag), Notes (append), Reminders (create, complete), Music (play).
- Accessibility API (via `@shopify/react-native-accessibility` pattern or direct via native helper) for text-field watching.

### 3.5 Meeting / conversation capture
- No standout open-source for Granola-style meeting notes on Mac right now. Roll our own on top of `screenpipe` audio pipeline + our existing `stt.ts` (whisper).

---

## 4. New Phases (additions to the master plan)

### Phase 8 — Screen perception (the eyes)
**Goal**: Nchinda can see your screen when it needs to — never continuously, never in the background — and compress what it sees into durable semantic memory.

**Two capture modes, both explicitly scoped — never always-on**:
- **On-demand**: you ask ("what's on my screen?"); Nchinda captures 1–N frames, answers, stops.
- **Active-task**: you give Nchinda a task that needs screen context ("finish this email"); the capturer starts at 2 fps for the duration of that task, stops the instant the task completes or you say "stop".

**Target usage envelope** (not a hard cap — Nchinda can override via policy): ~30–60 min of active-task capture per day at 2 fps, with aggressive perceptual-hash dedup (typical survival rate 10–30% of captured frames on text-heavy screens).

1. **`src/perception/screen-capture.ts`** — ScreenCaptureKit capturer with two modes. Parameters are **policy-driven, not hardcoded**: the AutonomyLoop's Policy engine chooses capture rate, mode, and dedup threshold per task. Defaults: 2 fps in active-task mode, auto-scale down if dedup rate > 80%. Active-window detection via Swift helper. Frames persist locally only.
2. **`src/perception/ocr.ts`** — local OCR (Apple Vision `VNRecognizeTextRequest` via a small Swift helper binary). No cloud round-trip for text extraction.
3. **`src/perception/vision-brief.ts`** — wraps a screenshot → compact structured brief: `{activeApp, windowTitle, visibleText, uiElements[], sentiment?: "focused"|"idle"|"confused"|"consuming"|"composing", label: string}`. `label` is a 1-sentence semantic caption generated at capture time so later searches can match without decompressing the frame. Local-only mode uses heuristics; `llm` mode adds one Haiku vision call.
4. **`screen_context` sensor** (Phase 5.5 placeholder) — ship for real. Fires an observation when active-app changes, when the user has been idle on the same screen > 5 min (possible stuck signal), or when a text-field draft sits > 5 min unsent (links to existing `unsent-drafts` sensor). The sensor **does not drive capture** — it only observes metadata (active-app, window title) which is free.
5. **`nchinda_see()` MCP tool** — any agent can ask for the current screen brief. Under active-task mode, this is served from the rolling buffer; under on-demand it triggers a fresh capture.
6. **Kill-switch (two paths, both wired)**:
   - Global hotkey **⌘⇧Esc** — stops any in-flight capture, purges the rolling buffer, logs the event to the audit ndjson.
   - Spoken word **"Stop"** — routed through the existing VoiceOrchestrator intent extractor; same effect as the hotkey.
7. **Audit log** — every capture, OCR call, vision LLM call, and kill-switch event appended to `~/.cortexos/audit.ndjson` (reuses Phase 5.5 `AuditLog`).
8. **Tests**: mock ScreenCaptureKit with fixture PNGs, assert brief shape; OCR fallback when Vision unavailable; sensor debounce; kill-switch paths.

### Phase 8.5 — Retention pipeline + adaptive capture + audit (storage bounded on consumer hardware)
**Goal**: Nchinda's screen memory stays useful forever on a 250 GB disk + 8 GB RAM box. No cloud, no surveillance, no surprise disk bloat.

**The storage contract**:
- Every captured frame becomes, at capture time: `{webp_path, embedding_int8 (512-d CLIP), ocr_text_zstd, label_caption, phash64, active_app, window_title, ts}` — stored together as one SQLite row per frame + one WebP on disk.
- WebPs live **7 days**, then the nightly consolidation worker (Phase 7 — already shipped) drops the WebP file and keeps the rest of the row forever. Query by embedding / label / OCR text still works; you just can't show back the pixels.
- Typical footprint at 30–60 min/day of active capture: **3–13 GB sustained total** (WebP rolling window + year of embeddings).

**1. `src/perception/webp-encoder.ts`** — WebP q=75 encode at capture time via the Swift helper (libwebp is built into macOS). Thumbnail-first strategy: encode at 1280px max width, ~50–150 KB typical for text screens.

**2. `src/perception/phash.ts`** — 64-bit perceptual hash (8 bytes) computed at capture. Dedup rule: if current frame's phash is within Hamming distance 4 of the previous frame's AND OCR text similarity > 98%, skip. Exposed as a function so the capturer's **adaptive rate-control** can query recent dedup stats to auto-scale frame rate (drop to 0.5 fps when dedup > 80%, back to 2 fps when it drops below 40%).

**3. `src/perception/retention.ts`** — the 7-day downgrader. Runs via the existing nightly consolidation worker. For each frame row older than 7 days: delete `webp_path`, clear the file-path column, leave everything else. Idempotent (re-running is a no-op). Logs bytes reclaimed.

**4. Daily disk-budget check** — in `screen-capture.ts`, before writing a frame, query the running 24-hour total of WebP bytes. If above `captureBudgetDailyBytes` (default 400 MB; policy-tunable per §7.1), refuse the write + emit an `error` event + surface a Pending Surface item suggesting "Nchinda hit its capture budget — clear old frames or raise the limit?" Nchinda **asks the user**, never silently drops data or exceeds the budget.

**5. `screen_memories` table** in `~/.cortexos/registry.db`:
```sql
CREATE TABLE screen_memories (
  id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  webp_path TEXT,              -- nulled after 7-day retention
  phash INTEGER NOT NULL,      -- 64-bit perceptual hash
  active_app TEXT,
  window_title TEXT,
  ocr_text_zstd BLOB,          -- zstd-compressed OCR
  label TEXT,                  -- 1-sentence semantic caption
  embedding BLOB NOT NULL,     -- 512-dim int8 CLIP
  task_id TEXT,                -- links capture to the task that triggered it
  session_id TEXT,             -- groups frames of one active-task session
  bytes INTEGER NOT NULL       -- for budget accounting
);
CREATE INDEX idx_sm_task ON screen_memories(task_id);
CREATE INDEX idx_sm_captured ON screen_memories(captured_at);
CREATE INDEX idx_sm_phash ON screen_memories(phash);
```

**6. Audit wiring** — every capture, OCR, vision-LLM call, and kill-switch event appended to `~/.cortexos/audit.ndjson` (existing Phase 5.5 `AuditLog`). Closes T2's REVIEW blocker P-1.

**7. Tests** — retention round-trip (seed 10 rows, advance clock 8 days, run downgrader, assert WebPs gone + embeddings retained); budget-check refuses to write when over; adaptive rate-control scales correctly based on synthetic dedup stream; audit entries match capture events 1:1.

### Phase 9 — Camera perception
**Goal**: "Nchinda, what am I looking at?" → it uses the webcam or Continuity Camera (iPhone) to capture and describe.

1. **`src/perception/camera-capture.ts`** — AVFoundation one-shot capture (no always-on by default; requires Camera permission). Continuity Camera (iPhone as webcam) is supported automatically by AVFoundation.
2. **`nchinda_look()` MCP tool** — captures a still, sends to Sonnet vision, returns the description + any OCR text.
3. **Voice integration**: `"look at this"`, `"what am I looking at"`, `"is this Epstein"` routes through VoiceOrchestrator → camera brief → TTS response with any fact-check overlay.

### Phase 10 — Computer-use (the hands)
**Goal**: Nchinda can take over mouse + keyboard when told.

1. **`src/computer-use/actuator.ts`** — low-level primitives via CoreGraphics (via a small Swift helper) + `cliclick` fallback. Methods: `moveTo(x,y)`, `click`, `type(text)`, `scroll`, `dragTo`, `screenshot`.
2. **`src/computer-use/accessibility.ts`** — AXUIElement queries to find buttons/text fields by role + label. Preferred over pixel-based approaches.
3. **`src/computer-use/agent-loop.ts`** — see→plan→act→verify inner loop wrapped by the existing AutonomyLoop. Max 20 action steps per task, mandatory confirmation for irreversible actions (same rules as Phase 2.2).
4. **MCP tools**: `cu_click`, `cu_type`, `cu_screenshot`, `cu_find_element`, `cu_scroll`.
5. **"Take over"** voice intent → switches the session into computer-use mode; every action is announced in the Activity Journal.

### Phase 11 — Window + workspace management
**Goal**: Spawned tmux/terminal panes auto-organize on the screen. Agents get their own tiled region.

1. **`src/window-manager/yabai-bridge.ts`** — detect yabai; if present, wrap its CLI. Fallback driver uses AppleScript + Accessibility API.
2. **Layouts**: preset grids for N agents (1-pane full, 2-pane vsplit, 3/4 columns, 5+ grid) mapped to spaces / displays.
3. **`src/window-manager/pane-ornaments.ts`** — JankyBorders-style accent border per agent color (cyan researcher, blue coder, …) so the user instantly sees which pane is which — extends the Mission Control color palette into the OS.
4. **`WorktreeManager` integration**: each agent's tmux session also gets a window slot.
5. **MCP tools**: `wm_move_window`, `wm_tile`, `wm_focus`, `wm_space_switch`.

### Phase 12 — Native app drivers (Mail, Messages, Calendar, Safari, Notes, Reminders, Music, Finder)
**Goal**: "send an email to Mark" → Nchinda opens Mail, composes, confirms, sends.

1. Driver interface per app, mirroring `SocialDriver` from Phase 4. Each exports:
   - `open()`, `query(...)`, `compose(...)`, `send(...)`, `read(...)`.
2. **Ship order** (by user frequency):
   1. Mail (compose, reply, search, archive, flag)
   2. Calendar (create event, find gap, decline)
   3. Messages (extend iMessage driver — group chats, reactions, attachments)
   4. Safari (open tab, read page, bookmarks, history)
   5. Notes (append, create, search)
   6. Reminders (add with due date, complete)
   7. Music (play, queue, skip)
   8. Finder (reveal, move, rename, tag)
3. All send/compose flows trigger escalation confirmation per Phase 2.2 before firing.
4. **MCP tools**: `mail_compose`, `mail_send`, `calendar_create`, `messages_send`, `safari_read`, `notes_append`, `reminders_add`, `music_play`, `finder_reveal`, …

### Phase 13 — Real-time writing coach
**Goal**: When you're drafting anything (email, message, comment), Nchinda watches, suggests, nudges.

1. **Accessibility field-watch**: subscribe to `kAXValueChangedNotification` on text fields in the focused app. Throttled to every 3s on content change.
2. **Suggestion model**: short prompt via Haiku: "Is this draft improvable in ONE specific way? One sentence or 'no-op'."
3. **Surface path**: HUD overlay on mission-control (when open) OR voice whisper if user has `anticipatory` proactivity mode on.
4. **Opt-in per app** (e.g. watch Mail, not Terminal by default).

### Phase 14 — Conversation-intent → action
**Goal**: Nchinda overhears you say "I should order Thai for Maya" → offers to do it.

1. Runs on the existing STT pipeline + a new `intent-extractor.ts` that classifies each utterance as `stated-intent | question | idle-chat | direct-command`.
2. On `stated-intent`, compose an `ACTION:` surface in the proactivity Pending Surface with pre-filled details.
3. Requires explicit confirmation — never auto-executes even in `autonomous` mode when the intent wasn't addressed to Nchinda directly.

### Phase 15 — Retroactive "Rewind"-style query
**Goal**: "Nchinda, what was that article I was reading 40 minutes ago?"

1. Uses the Phase 8 screen ring-buffer + OCR'd text + active-app timeline.
2. Natural-language query → timestamp-range search over the local text index.
3. Returns a brief + optional screenshot thumbnail in Mission Control.

---

## 5. Dependencies + sequencing

```
                     ┌─── Phase 8 (screen eyes) ─────┐
                     │                                ▼
                     │                            Phase 10 (hands)
Phase 0–7 (shipped) ─┤                                │
                     │                                ▼
                     ├─── Phase 9 (camera) ──────── Phase 14 (conv intent)
                     │                                │
                     └─── Phase 11 (windows) ───── Phase 12 (app drivers)
                                                      │
                                                      ▼
                                                  Phase 13 (writing coach)
                                                      │
                                                      ▼
                                                  Phase 15 (rewind)
```

Phases 8, 9, 11 are **parallelizable** — independent subsystems, different native APIs.
Phase 10 depends on 8 (sees before it acts).
Phase 12 can start anytime (pure AppleScript + existing driver pattern).
Phases 13, 14, 15 require 8 + 10 + 12.

---

## 6. New MCP tool surface summary

```
nchinda_see(), nchinda_look()                    — perception one-shots
cu_click, cu_type, cu_screenshot, cu_find_element, cu_scroll  — hands
wm_move_window, wm_tile, wm_focus, wm_space_switch            — windows
mail_compose, mail_send, mail_search
calendar_create, calendar_find_gap
messages_send (extended)
safari_open_tab, safari_read_page, safari_bookmarks
notes_append, notes_search
reminders_add, reminders_complete
music_play, music_queue
finder_reveal, finder_move, finder_tag
rewind_search(query, time_range?)
watch_draft(enable: boolean, app?: string)
```

All follow the existing pattern: zod-validated inputs, native execFile (no shell), sandboxed where possible, escalation-on-irreversible.

---

## 7.0 "Not hardcoded" — a design principle

Every numeric threshold in this plan (capture rate, dedup threshold, retention days, daily byte budget, sensor intervals, etc.) is a **default value set by the Policy engine**, not a compile-time constant. Nchinda can change any of them at runtime when it has reason to: it sees the user is working in a different mode, disk is low, a task needs more frames, the user said "capture more". The agent should read the environment, consider memory, consult past briefs, and adjust — not follow rules blindly.

Hardcoded constants in code are a smell. Policy-driven defaults with explainable overrides are the pattern.

## 7. Privacy posture (non-negotiable)

The Omi positioning "it sees everything" is the hook and the risk. Our answer:

1. **Screen/camera capture is opt-in per sensor + per app.** Default: off.
2. **No frames leave the Mac** unless the user explicitly requests an LLM action on them (the same model as Phase 5.7.5 — consent at use, not at install).
3. **Local OCR first** (Apple Vision), cloud vision second, only when needed.
4. **Kill-switch**: ⌘⇧Escape globally disables all perception for the rest of the session.
5. **Audit log** (Phase 5.5): every frame sample, every vision call, every actuator action — appended to `~/.cortexos/audit.ndjson`.
6. **Visible state**: the Nchinda Waveform gets a new eye icon that glows when screen-watching is active + a camera dot when the webcam is capturing.
7. **Workspace boundaries**: "private apps" allowlist — 1Password, banking sites, disk-encryption fields — never sampled.

---

## 8. Immediate next action

**Today**:
1. Spawn Phase 8 builders (screen capture + OCR + brief) and Phase 11 builders (yabai bridge + tiling) in parallel — disjoint lanes, both high-leverage.
2. After those land, Phase 9 (camera) + Phase 12 (native app drivers) — also parallel.
3. Defer Phase 10 (computer-use) until 8 is green — it depends on reliable perception.

Each phase follows the established pattern: 2-4 coder agents in parallel with tight scope + commit-every-15min mandate, followed by 2 test agents (integration + review). Same discipline that shipped Phases 1–7.

No code changes in this commit — just the plan. Ready to deploy on your word.
