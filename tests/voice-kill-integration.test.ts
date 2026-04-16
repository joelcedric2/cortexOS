import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AudioStateMachine } from "../src/voice/audio-state.js";
import { WakeWordDetector } from "../src/voice/wake-word.js";
import { SpeechToText } from "../src/voice/stt.js";
import { TextToSpeech } from "../src/voice/tts.js";
import { VoiceOrchestrator } from "../src/voice/voice-orchestrator.js";
import { createEventBus, type AgentEvent } from "../src/ipc/event-bus.js";
import {
  PerceptionKillSwitch,
} from "../src/perception/kill-switch.js";
import { AuditLog } from "../src/proactivity/audit.js";
import {
  ScreenCapturer,
  ephemeralStorageDir,
  type CaptureScheduler,
} from "../src/perception/screen-capture.js";
import type { VisionBridge } from "../src/perception/native-bridge.js";
import type { PaneOrnamentManager } from "../src/window-manager/pane-ornaments.js";

function manualScheduler(): CaptureScheduler {
  return { start() {}, stop() {} };
}

function fakeBridge(): VisionBridge {
  return {
    async capture({ outPath }) {
      return {
        out_path: outPath,
        ts: Date.now(),
        active_app: "Test",
        active_bundle: "com.example",
        window_title: "t",
        width: 1,
        height: 1,
      };
    },
    async ocr() {
      return { text: "", blocks: [], duration_ms: 0 };
    },
    async probe() {
      return { ok: true };
    },
  };
}

function fakePanes(): { clearAllCalls: number; clearAll(): Promise<void> } {
  const fake = {
    clearAllCalls: 0,
    async clearAll() {
      fake.clearAllCalls++;
    },
  };
  return fake;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("VoiceOrchestrator × PerceptionKillSwitch", () => {
  let tmpDir: string;
  let auditPath: string;
  let audit: AuditLog;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cortex-voice-kill-"));
    auditPath = join(tmpDir, "audit.ndjson");
    audit = new AuditLog(auditPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wake → transcript 'stop' → killswitch fires + tts stopped + no onTask dispatch", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = new TextToSpeech({});
    const bus = createEventBus();
    const events: AgentEvent[] = [];
    bus.subscribe({}, (e) => events.push(e));

    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler: manualScheduler(),
      storageDir: ephemeralStorageDir(),
    });
    await capturer.start();

    const panes = fakePanes();
    const killSwitch = new PerceptionKillSwitch({
      capturer,
      paneOrnaments: panes as unknown as PaneOrnamentManager,
      bus,
      audit,
    });

    let onTaskCalled = 0;
    let ttsStopped = 0;
    const ttsStopOriginal = tts.stop.bind(tts);
    tts.stop = () => {
      ttsStopped++;
      ttsStopOriginal();
    };

    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async (t) => {
        onTaskCalled++;
        return `echo: ${t}`;
      },
      killSwitch,
      audit,
    });

    // Prime STT to return "stop" on the next stopRecording() call.
    stt._resolveWith("stop");

    // Kick off the private flow by calling the same method the wake-word
    // handler calls. We intentionally avoid orchestrator.start() so the test
    // does not touch real audio devices.
    // Bump generation by faking a wake cycle:
    sm.transition("listening");
    // @ts-expect-error private — deliberate test seam
    await orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );

    // onTask must NOT be called for a kill intent.
    assert.equal(onTaskCalled, 0, "onTask must not dispatch on kill intent");
    // TTS must have been told to stop (even though nothing was playing, we
    // still require the call so interruption-during-speak works).
    assert.equal(ttsStopped, 1, "tts.stop() called once");

    // Kill-switch fired and capturer is off.
    assert.equal(killSwitch.hasFired(), true);
    assert.equal(capturer.isRunning(), false);
    assert.equal(panes.clearAllCalls, 1);

    // Audit: expect at least a `voice_intent` line AND a `perception_killed`
    // line. Order may vary per impl but both must be present.
    const lines = readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { action: string; detail: string });

    const actions = lines.map((l) => l.action);
    assert.ok(
      actions.includes("voice_intent"),
      `voice_intent in ${actions.join(",")}`,
    );
    assert.ok(
      actions.includes("perception_killed"),
      `perception_killed in ${actions.join(",")}`,
    );

    const voiceLine = lines.find((l) => l.action === "voice_intent");
    assert.ok(voiceLine?.detail.includes("intent=kill"));

    const killLine = lines.find((l) => l.action === "perception_killed");
    assert.equal(killLine?.detail, "source=voice");

    // State machine should have wound down to idle without hitting thinking
    // / speaking.
    assert.equal(sm.getState(), "idle");
  });

  it("non-kill transcripts fall through to onTask normally", async () => {
    const sm = new AudioStateMachine();
    const wake = new WakeWordDetector({ onWake: () => {} });
    const stt = new SpeechToText({});
    const tts = new TextToSpeech({});
    const bus = createEventBus();

    const capturer = new ScreenCapturer({
      bridge: fakeBridge(),
      scheduler: manualScheduler(),
      storageDir: ephemeralStorageDir(),
    });
    await capturer.start();

    const killSwitch = new PerceptionKillSwitch({ capturer, audit });

    let onTaskCalled = 0;
    // Arm TTS test promise so speak() is a no-op we control.
    tts._armTestPromise();
    tts._resolveSpeak();

    const orchestrator = new VoiceOrchestrator({
      wakeWord: wake,
      stt,
      tts,
      stateMachine: sm,
      bus,
      onTask: async (t) => {
        onTaskCalled++;
        return `echo: ${t}`;
      },
      killSwitch,
      audit,
    });

    stt._resolveWith("summarize my inbox");
    sm.transition("listening");
    // @ts-expect-error private test seam
    await orchestrator["processVoiceInteraction"](
      // @ts-expect-error private
      orchestrator["generation"],
    );

    assert.equal(onTaskCalled, 1);
    assert.equal(killSwitch.hasFired(), false);
    assert.equal(capturer.isRunning(), true);
  });
});
