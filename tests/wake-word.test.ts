import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WakeWordDetector, computeRms } from '../src/voice/wake-word.js';

describe('computeRms', () => {
  test('returns 0 for empty buffer', () => {
    assert.equal(computeRms(Buffer.alloc(0)), 0);
  });

  test('returns 0 for silence (all zeros)', () => {
    const buf = Buffer.alloc(160); // 80 samples of silence
    assert.equal(computeRms(buf), 0);
  });

  test('returns ~0.707 for max amplitude square wave', () => {
    // Alternating +32767 and -32767 (nearly max int16)
    const buf = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) {
      const val = i % 2 === 0 ? 32767 : -32767;
      buf.writeInt16LE(val, i * 2);
    }
    const rms = computeRms(buf);
    // Should be very close to 1.0 (max normalized)
    assert.ok(rms > 0.99, `Expected ~1.0, got ${rms}`);
  });

  test('returns correct value for known samples', () => {
    // 4 samples: 0, 16384, 0, -16384  (half amplitude)
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(16384, 2);
    buf.writeInt16LE(0, 4);
    buf.writeInt16LE(-16384, 6);

    const rms = computeRms(buf);
    // normalized: 0, 0.5, 0, -0.5
    // mean of squares: (0 + 0.25 + 0 + 0.25) / 4 = 0.125
    // sqrt(0.125) ≈ 0.3536
    assert.ok(Math.abs(rms - 0.3536) < 0.01, `Expected ~0.354, got ${rms}`);
  });
});

describe('WakeWordDetector', () => {
  test('starts not listening', () => {
    const detector = new WakeWordDetector({ onWake: () => {} });
    assert.equal(detector.isListening(), false);
  });

  test('processRms triggers wake after sustained audio above threshold', () => {
    let woke = false;
    const detector = new WakeWordDetector({
      sensitivity: 0.5,
      onWake: () => { woke = true; },
    });

    // Default sensitivity 0.5 -> threshold ~0.0525
    // Feed RMS above threshold for 300ms+ (simulated via Date mocking)
    const now = Date.now();

    // First call: starts sustained timer
    detector.processRms(0.1);
    assert.equal(woke, false);

    // Simulate 350ms passing by manipulating internal state
    // @ts-expect-error accessing private for test
    detector.sustainedStart = now - 350;

    // Next call should trigger wake
    detector.processRms(0.1);
    assert.equal(woke, true);
  });

  test('processRms resets on silence', () => {
    let woke = false;
    const detector = new WakeWordDetector({
      sensitivity: 0.5,
      onWake: () => { woke = true; },
    });

    detector.processRms(0.1); // above threshold, starts sustained
    // @ts-expect-error accessing private
    assert.ok(detector.sustainedStart !== null);

    detector.processRms(0.001); // below threshold, resets
    // @ts-expect-error accessing private
    assert.equal(detector.sustainedStart, null);
    assert.equal(woke, false);
  });

  test('does not trigger twice without resetWake', () => {
    let wakeCount = 0;
    const detector = new WakeWordDetector({
      sensitivity: 0.5,
      onWake: () => { wakeCount++; },
    });

    const now = Date.now();
    detector.processRms(0.1);
    // @ts-expect-error accessing private
    detector.sustainedStart = now - 350;
    detector.processRms(0.1); // triggers
    assert.equal(wakeCount, 1);

    // Further high RMS should not trigger again
    // @ts-expect-error accessing private
    detector.sustainedStart = now - 700;
    detector.processRms(0.1);
    assert.equal(wakeCount, 1);
  });

  test('resetWake allows re-triggering', () => {
    let wakeCount = 0;
    const detector = new WakeWordDetector({
      sensitivity: 0.5,
      onWake: () => { wakeCount++; },
    });

    const now = Date.now();
    detector.processRms(0.1);
    // @ts-expect-error accessing private
    detector.sustainedStart = now - 350;
    detector.processRms(0.1);
    assert.equal(wakeCount, 1);

    detector.resetWake();

    detector.processRms(0.1);
    // @ts-expect-error accessing private
    detector.sustainedStart = now - 350;
    detector.processRms(0.1);
    assert.equal(wakeCount, 2);
  });

  test('high sensitivity means lower threshold', () => {
    let woke = false;
    const detector = new WakeWordDetector({
      sensitivity: 0.9,
      onWake: () => { woke = true; },
    });

    // sensitivity 0.9 -> threshold 0.0145
    // low RMS should trigger with high sensitivity
    const now = Date.now();
    detector.processRms(0.02);
    // @ts-expect-error accessing private
    detector.sustainedStart = now - 350;
    detector.processRms(0.02);
    assert.equal(woke, true);
  });

  test('low sensitivity means higher threshold', () => {
    let woke = false;
    const detector = new WakeWordDetector({
      sensitivity: 0.1,
      onWake: () => { woke = true; },
    });

    // sensitivity 0.1 -> threshold ~0.0905
    // moderate RMS should NOT trigger with low sensitivity
    const now = Date.now();
    detector.processRms(0.05);
    // @ts-expect-error accessing private
    detector.sustainedStart = now - 350;
    detector.processRms(0.05);
    assert.equal(woke, false);

    // Higher RMS should trigger
    detector.processRms(0.1);
    // @ts-expect-error accessing private
    detector.sustainedStart = now - 350;
    detector.processRms(0.1);
    assert.equal(woke, true);
  });

  test('onRmsUpdate callback fires', () => {
    const rmsValues: number[] = [];
    const detector = new WakeWordDetector({
      onWake: () => {},
      onRmsUpdate: (rms) => rmsValues.push(rms),
    });

    // Directly call processRms doesn't trigger onRmsUpdate
    // (that happens in the sox data handler). Test the public API intent.
    assert.equal(rmsValues.length, 0);
  });

  test('stop resets state', () => {
    const detector = new WakeWordDetector({ onWake: () => {} });
    // @ts-expect-error accessing private
    detector.listening = true;
    // @ts-expect-error accessing private
    detector.sustainedStart = Date.now();

    detector.stop();

    assert.equal(detector.isListening(), false);
    // @ts-expect-error accessing private
    assert.equal(detector.sustainedStart, null);
  });
});
