import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WakeWordDetector } from '../src/voice/wake-word.js';

describe('WakeWordDetector', () => {
  test('starts not listening', () => {
    const detector = new WakeWordDetector({ onWake: () => {} });
    assert.equal(detector.isListening(), false);
  });

  test('defaults to "cortex" keyword', () => {
    const detector = new WakeWordDetector({ onWake: () => {} });
    assert.equal(detector.keyword, 'cortex');
  });

  test('accepts custom keyword', () => {
    const detector = new WakeWordDetector({ keyword: 'jarvis', onWake: () => {} });
    assert.equal(detector.keyword, 'jarvis');
  });

  test('stop sets listening to false', () => {
    const detector = new WakeWordDetector({ onWake: () => {} });
    // @ts-expect-error accessing private for test
    detector.listening = true;
    detector.stop();
    assert.equal(detector.isListening(), false);
  });

  test('setOnWake replaces callback', () => {
    let count = 0;
    const detector = new WakeWordDetector({ onWake: () => { count += 10; } });
    detector.setOnWake(() => { count += 1; });
    detector._simulateWake();
    assert.equal(count, 1);
  });

  test('_simulateWake fires onWake', () => {
    let woke = false;
    const detector = new WakeWordDetector({ onWake: () => { woke = true; } });
    detector._simulateWake();
    assert.equal(woke, true);
  });
});
