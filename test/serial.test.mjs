// Verifies the UART waveform encoder in serial.js by decoding its output back
// into bytes, independently of how it was generated.
//
// Encoder contract:
//   - 31,250 baud, 8 data bits, no parity, 1 stop bit (8N1)
//   - data sent least significant bit first
//   - "asserted" means line current ON, which is UART logical 0 (space)
//   - rendered as a stereo differential: Type A = right positive / left negative
//     for current-on bits, Type B reverses the pair
//
// Run with: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { MidiSerial } from '../serial.js';

const RATE = 96000;
const SPB = RATE / 31250; // samples per bit = 3.072 at 96 kHz

function waveform(bytes, { reverse = false, amplitude = 1 } = {}) {
  const enc = new MidiSerial(RATE);
  enc.enqueue(bytes);
  const n = Math.ceil(bytes.length * 10 * SPB) + 64;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  enc.fill(left, right, amplitude, reverse);
  return { left, right };
}

// A sample carries line current when either channel is non-zero.
const asserted = (l) => Array.from(l, (v) => (Math.abs(v) > 1e-9 ? 1 : 0));

// Decode by walking the line frame by frame.
//
// The cursor advances on the *ideal* frame grid (10 bit slots = 30.72 samples)
// rather than from the detected start sample, so one sample of quantisation
// never accumulates into drift. Each bit is read at the middle of its slot.
function decode(bytes) {
  const line = asserted(waveform(bytes).left);
  const frames = [];
  let cursor = 0;
  while (true) {
    // The start bit is the next current-carrying sample at or after the cursor.
    let start = Math.round(cursor);
    while (start < line.length && !line[start]) start++;
    if (start >= line.length) break;
    if (start > Math.round(cursor) + 2) cursor = start; // real gap: resynchronise
    const at = (k) => line[Math.round(start + (k + 0.5) * SPB)] ?? 0;
    if (!at(0)) {
      cursor += 1;
      continue;
    }
    let value = 0;
    for (let k = 1; k <= 8; k++) if (!at(k)) value |= 1 << (k - 1); // current on = bit 0
    frames.push({ value, stop: at(9) === 0 });
    cursor += 10 * SPB;
  }
  return frames;
}

test('every byte value survives a round trip', () => {
  for (let b = 0; b < 256; b++) {
    const frames = decode([b]);
    assert.equal(frames.length, 1, `byte 0x${b.toString(16)} produced no frame`);
    assert.equal(frames[0].value, b, `byte 0x${b.toString(16)} decoded wrong`);
    assert.ok(frames[0].stop, `byte 0x${b.toString(16)} has a low stop bit`);
  }
});

test('complete MIDI messages survive a round trip', () => {
  const messages = [
    [0x90, 60, 100], // note on
    [0x80, 60, 0], // note off
    [0xe0, 0x00, 0x40], // pitch bend, centred
    [0xb0, 123, 0], // all notes off
    [0xb0, 101, 0, 0xb0, 100, 6, 0xb0, 6, 15], // RPN sequence
    [0xf8], // clock
  ];
  for (const message of messages) {
    const frames = decode(message);
    assert.deepEqual(
      frames.map((f) => f.value),
      message,
      `message ${message.map((b) => b.toString(16)).join(' ')} decoded wrong`,
    );
    assert.ok(frames.every((f) => f.stop));
  }
});

test('bit timing holds across a long run without drifting', () => {
  const bytes = Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff);
  const frames = decode(bytes);
  assert.deepEqual(frames.map((f) => f.value), bytes);
});

test('frames are one tenth of 31,250 baud each', () => {
  // 10 bit slots per character, 31,250 bits/s => 3125 characters per second.
  const frameSamples = 10 * SPB;
  assert.equal(frameSamples.toFixed(3), '30.720');
  assert.equal(((10 * 10) / 31250).toFixed(4), '0.0032'); // seconds per frame
});

test('Type A polarity drives right positive and left negative', () => {
  const { left, right } = waveform([0x90, 60, 100]);
  let differential = 0;
  let inverted = 0;
  for (let i = 0; i < left.length; i++) {
    if (!left[i] && !right[i]) continue;
    if (right[i] > 0 && left[i] < 0) differential++;
    else if (right[i] < 0 && left[i] > 0) inverted++;
  }
  assert.ok(differential > 0, 'expected current-carrying samples');
  assert.equal(inverted, 0, 'Type A must never invert the pair');
});

test('Type B reverses the pair', () => {
  // Silence is 0 on both channels; negating it would give -0, so normalise.
  const signed = (a) => Array.from(a, (v) => (v === 0 ? 0 : v));
  const a = waveform([0x90], { reverse: false });
  const b = waveform([0x90], { reverse: true });
  const flipped = (src) => Array.from(src, (v) => (v === 0 ? 0 : -v));
  assert.deepEqual(signed(b.left), flipped(a.left));
  assert.deepEqual(signed(b.right), flipped(a.right));
});

test('silence between and after messages is exactly zero', () => {
  const { left, right } = waveform([0x90]);
  const quiet = left.reduce((acc, v, i) => acc + (!v && !right[i] ? 1 : 0), 0);
  assert.ok(quiet > 0, 'the line must idle after the message');
  for (let i = 0; i < left.length; i++) {
    if (!left[i]) assert.equal(right[i], 0, 'both channels are silent together');
  }
});

test('amplitude scales the waveform without changing its shape', () => {
  const loud = asserted(waveform([0x90, 60], { amplitude: 0.9 }).left);
  const soft = asserted(waveform([0x90, 60], { amplitude: 0.05 }).left);
  assert.deepEqual(soft, loud);
});

test('rejects bytes that cannot be sent', () => {
  const enc = new MidiSerial(RATE);
  for (const bad of [-1, 256, 12.5, 'x']) {
    assert.throws(() => enc.enqueue([bad]), /Invalid MIDI byte/);
  }
});

test('clear() drops queued bytes', () => {
  const enc = new MidiSerial(RATE);
  enc.enqueue([0x90, 60, 100]);
  enc.clear();
  const left = new Float32Array(400);
  const right = new Float32Array(400);
  enc.fill(left, right, 1, false);
  assert.equal(left.every((v) => v === 0), true);
});

test('idle line stays at mark level', () => {
  const enc = new MidiSerial(RATE);
  const left = new Float32Array(100);
  const right = new Float32Array(100);
  enc.fill(left, right, 1, false);
  assert.equal(left.every((v) => v === 0), true);
  assert.equal(right.every((v) => v === 0), true);
});
