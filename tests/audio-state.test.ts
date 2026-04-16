import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AudioStateMachine } from '../src/voice/audio-state.js';
import type { AudioState, AudioStateEvent } from '../src/voice/audio-state.js';

describe('AudioStateMachine', () => {
  test('starts in idle state with zero RMS', () => {
    const sm = new AudioStateMachine();
    assert.equal(sm.getState(), 'idle');
    assert.equal(sm.getRms(), 0);
  });

  test('valid transition: idle -> listening', () => {
    const sm = new AudioStateMachine();
    sm.transition('listening', 0.3);
    assert.equal(sm.getState(), 'listening');
    assert.equal(sm.getRms(), 0.3);
  });

  test('full happy path: idle -> listening -> thinking -> speaking -> idle', () => {
    const sm = new AudioStateMachine();
    sm.transition('listening');
    sm.transition('thinking');
    sm.transition('speaking');
    sm.transition('idle');
    assert.equal(sm.getState(), 'idle');
  });

  test('allows idle -> speaking (greeting path)', () => {
    const sm = new AudioStateMachine();
    sm.transition('speaking');
    assert.equal(sm.getState(), 'speaking');
  });

  test('throws on invalid transition: listening -> speaking', () => {
    const sm = new AudioStateMachine();
    sm.transition('listening');
    assert.throws(
      () => sm.transition('speaking'),
      /Invalid audio state transition: listening -> speaking/,
    );
  });

  test('error state reachable from any non-error state', () => {
    const states: AudioState[] = ['idle', 'listening', 'thinking', 'speaking'];
    for (const from of states) {
      const sm = new AudioStateMachine();
      // Navigate to the target state
      if (from === 'listening') sm.transition('listening');
      if (from === 'thinking') { sm.transition('listening'); sm.transition('thinking'); }
      if (from === 'speaking') { sm.transition('listening'); sm.transition('thinking'); sm.transition('speaking'); }
      sm.transition('error');
      assert.equal(sm.getState(), 'error');
    }
  });

  test('error state can only go to idle', () => {
    const sm = new AudioStateMachine();
    sm.transition('error');
    assert.throws(() => sm.transition('listening'));
    sm.transition('idle');
    assert.equal(sm.getState(), 'idle');
  });

  test('listener receives state change events', () => {
    const sm = new AudioStateMachine();
    const events: AudioStateEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    sm.transition('listening', 0.5, 'wake detected');
    assert.equal(events.length, 1);
    assert.equal(events[0].state, 'listening');
    assert.equal(events[0].rms, 0.5);
    assert.equal(events[0].caption, 'wake detected');
    assert.ok(events[0].ts instanceof Date);
  });

  test('multiple listeners all receive events', () => {
    const sm = new AudioStateMachine();
    let count1 = 0;
    let count2 = 0;
    sm.onStateChange(() => { count1++; });
    sm.onStateChange(() => { count2++; });

    sm.transition('listening');
    assert.equal(count1, 1);
    assert.equal(count2, 1);
  });

  test('unsubscribe removes listener', () => {
    const sm = new AudioStateMachine();
    let count = 0;
    const unsub = sm.onStateChange(() => { count++; });

    sm.transition('listening');
    assert.equal(count, 1);

    unsub();
    sm.transition('thinking');
    assert.equal(count, 1); // no additional call
  });

  test('RMS defaults to 0 when not provided', () => {
    const sm = new AudioStateMachine();
    sm.transition('listening');
    assert.equal(sm.getRms(), 0);
  });

  test('caption is optional and propagated correctly', () => {
    const sm = new AudioStateMachine();
    const events: AudioStateEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    sm.transition('listening');
    assert.equal(events[0].caption, undefined);

    sm.transition('thinking', 0, 'processing...');
    assert.equal(events[1].caption, 'processing...');
  });
});
