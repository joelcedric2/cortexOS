import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { AudioStateMachine } from "../src/voice/audio-state.js";
import { VoiceWSBridge, type NchindaWaveState } from "../src/voice/ws-bridge.js";

/** Connect a WS client and wait for the first message. */
function connectAndReceive(port: number): Promise<NchindaWaveState> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/audio`);
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString()) as NchindaWaveState;
      ws.close();
      resolve(parsed);
    });
    ws.on("error", reject);
  });
}

/** Collect N messages from a WS connection. */
function collectMessages(
  port: number,
  count: number,
): Promise<{ messages: NchindaWaveState[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/audio`);
    const messages: NchindaWaveState[] = [];
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as NchindaWaveState);
      if (messages.length >= count) {
        resolve({ messages, ws });
      }
    });
    ws.on("error", reject);
  });
}

describe("VoiceWSBridge", () => {
  let bridge: VoiceWSBridge | null = null;

  afterEach(async () => {
    if (bridge) {
      await bridge.stop();
      bridge = null;
    }
  });

  test("broadcasts initial state frame on client connect", async () => {
    const sm = new AudioStateMachine();
    bridge = new VoiceWSBridge({ port: 3199, stateMachine: sm, publishRateHz: 10 });
    await bridge.start();

    const frame = await connectAndReceive(3199);
    assert.equal(frame.state, "idle");
    assert.equal(frame.rms, 0);
    assert.ok(frame.lastEventAt);
  });

  test("reflects state changes to connected clients", async () => {
    const sm = new AudioStateMachine();
    bridge = new VoiceWSBridge({ port: 3200, stateMachine: sm, publishRateHz: 60 });
    await bridge.start();

    // Transition the state machine before collecting.
    sm.transition("listening", 0.75, "wake detected");

    // Collect 2 messages (initial + at least one broadcast tick).
    const { messages, ws } = await collectMessages(3200, 2);
    ws.close();

    // At least one frame should reflect 'listening'.
    const listeningFrame = messages.find((m) => m.state === "listening");
    assert.ok(listeningFrame, "Expected a frame with state 'listening'");
    assert.equal(listeningFrame.rms, 0.75);
  });

  test("tracks client count", async () => {
    const sm = new AudioStateMachine();
    bridge = new VoiceWSBridge({ port: 3201, stateMachine: sm, publishRateHz: 10 });
    await bridge.start();

    assert.equal(bridge.clientCount(), 0);

    const ws1 = new WebSocket("ws://localhost:3201/audio");
    await new Promise<void>((resolve) => ws1.on("open", resolve));
    assert.equal(bridge.clientCount(), 1);

    const ws2 = new WebSocket("ws://localhost:3201/audio");
    await new Promise<void>((resolve) => ws2.on("open", resolve));
    assert.equal(bridge.clientCount(), 2);

    ws1.close();
    // Allow close to propagate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bridge.clientCount(), 1);

    ws2.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(bridge.clientCount(), 0);
  });

  test("graceful shutdown closes all connections", async () => {
    const sm = new AudioStateMachine();
    bridge = new VoiceWSBridge({ port: 3202, stateMachine: sm, publishRateHz: 10 });
    await bridge.start();

    const ws = new WebSocket("ws://localhost:3202/audio");
    const closed = new Promise<number>((resolve) => {
      ws.on("close", (code: number) => resolve(code));
    });
    await new Promise<void>((resolve) => ws.on("open", resolve));

    await bridge.stop();
    bridge = null;

    const code = await closed;
    assert.equal(code, 1001, "Expected close code 1001 (going away)");
  });

  test("heartbeat frames sent even without state changes", async () => {
    const sm = new AudioStateMachine();
    bridge = new VoiceWSBridge({ port: 3203, stateMachine: sm, publishRateHz: 60 });
    await bridge.start();

    // Collect 3 frames — all should be idle heartbeats.
    const { messages, ws } = await collectMessages(3203, 3);
    ws.close();

    for (const msg of messages) {
      assert.equal(msg.state, "idle");
      assert.equal(typeof msg.rms, "number");
    }
  });
});
