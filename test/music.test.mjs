// Verifies the musical maths in music.js: grid geometry, tuning steps, note
// names, scale membership and MIDI pitch/bend resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mod,
  NOTE_NAMES,
  LAYOUTS,
  intervals,
  stepAt,
  pitchForStep,
  frequency,
  noteName,
  labelForStep,
  inScale,
  midiPitch,
  bendRangeMessages,
  toHexPoint,
  fromHexPoint,
} from '../music.js';

const state = (over = {}) => ({
  layout: 'wicki',
  edo: 12,
  root: 0,
  scale: 'major',
  octave: 0,
  labels: 'notes',
  axisA: 2,
  axisB: 7,
  ...over,
});

test('mod is always positive', () => {
  assert.equal(mod(-1, 12), 11);
  assert.equal(mod(-12, 12), 0);
  assert.equal(mod(13, 12), 1);
});

test('note names cover one octave in order', () => {
  assert.equal(NOTE_NAMES.length, 12);
  assert.equal(NOTE_NAMES[0], 'C');
});

test('each layout defines both grid axes', () => {
  for (const [key, layout] of Object.entries(LAYOUTS)) {
    assert.equal(typeof layout.name, 'string', key);
    assert.equal(typeof layout.a, 'number', key);
    assert.equal(typeof layout.b, 'number', key);
    assert.ok(layout.description.length > 0, key);
  }
});

test('Wicki–Hayden puts whole tones across and fifths on the diagonal', () => {
  assert.deepEqual(intervals(state()), [2, 7]);
});

test('layouts rescale to the chosen tuning', () => {
  assert.deepEqual(intervals(state({ layout: 'sonome' })), [4, 7]);
  assert.deepEqual(intervals(state({ layout: 'chromatic' })), [1, 5]);
  // 19 EDO stretches the same shape proportionally.
  assert.deepEqual(intervals(state({ edo: 19, layout: 'wicki' })), [3, 11]);
  assert.deepEqual(intervals(state({ edo: 31, layout: 'wicki' })), [5, 18]);
});

test('custom layout uses the axis values verbatim', () => {
  assert.deepEqual(intervals(state({ layout: 'custom', axisA: 3, axisB: -4 })), [3, -4]);
});

test('a step is the sum of both axes plus the octave', () => {
  // Wicki: across = +2 steps, up-right = +7 steps, octave = +12.
  assert.equal(stepAt(0, 0, state()), 0);
  assert.equal(stepAt(1, 0, state()), 2);
  assert.equal(stepAt(0, 1, state()), 7);
  assert.equal(stepAt(1, 0, state({ octave: 1 })), 14);
});

test('the same key shape holds in every tuning', () => {
  // The layout keeps its shape: one cell across is +2/12 of an octave in any
  // EDO, rounded to the nearest whole step of that tuning.
  for (const edo of [12, 19, 22, 24, 31, 53]) {
    const s = state({ edo });
    const delta = stepAt(1, 0, s) - stepAt(0, 0, s);
    const ideal = (2 / 12) * edo;
    assert.ok(
      Math.abs(delta - ideal) <= 0.5,
      `EDO ${edo}: across = ${delta} steps, ideally ${ideal.toFixed(3)}`,
    );
  }
});

test('pitch 60 is middle C and A4 is 440 Hz', () => {
  assert.equal(frequency(69), 440);
  assert.equal(frequency(57), 220);
  assert.equal(frequency(81), 880);
});

test('step to pitch is exact in 12 EDO', () => {
  assert.equal(pitchForStep(0, state()), 60);
  assert.equal(pitchForStep(12, state()), 72); // one octave
  assert.equal(noteName(pitchForStep(7, state())), 'G4');
});

test('alternate tunings still land on the octave', () => {
  for (const edo of [19, 22, 24, 31, 53]) {
    const s = state({ edo });
    assert.equal(pitchForStep(edo, s) - pitchForStep(0, s), 12, `EDO ${edo}`);
  }
});

test('labels adapt to tuning and label mode', () => {
  assert.equal(labelForStep(0, state()), 'C');
  assert.equal(labelForStep(2, state()), 'D');
  assert.equal(labelForStep(0, state({ labels: 'degrees' })), '1');
  assert.equal(labelForStep(1, state({ labels: 'degrees' })), '2');
  // Non-12 tunings label by step number, marking the root.
  assert.equal(labelForStep(1, state({ edo: 19 })), '1');
  assert.equal(labelForStep(0, state({ edo: 19 })), '0 · C');
});

test('scale membership follows the chosen scale', () => {
  const major = state();
  assert.equal(inScale(0, major), true);
  assert.equal(inScale(1, major), false);
  assert.equal(inScale(2, major), true);
  assert.equal(inScale(11, major), true);

  const minor = state({ scale: 'minor' });
  assert.equal(inScale(3, minor), true);
  assert.equal(inScale(4, minor), false);

  const pentatonic = state({ scale: 'pentatonic' });
  assert.equal(inScale(4, pentatonic), true);
  assert.equal(inScale(5, pentatonic), false);

  // 'all' highlights everything.
  for (let step = -12; step <= 12; step++) {
    assert.equal(inScale(step, state({ scale: 'all' })), true);
  }
});

test('scale membership is defined relative to the octave, not the root', () => {
  assert.equal(inScale(2, state()), inScale(14, state()));
  assert.equal(inScale(2, state()), inScale(-10, state()));
});

test('integer pitches need no pitch bend', () => {
  assert.deepEqual(midiPitch(60), { note: 60, bend: 8192 });
  assert.deepEqual(midiPitch(69), { note: 69, bend: 8192 });
});

test('fractional pitches become note plus bend', () => {
  // Just above a note: snapped to that note, bent upward.
  const up = midiPitch(60.25);
  assert.equal(up.note, 60);
  assert.ok(up.bend > 8192, 'bend must rise above centre');

  // Just below a note: snapped up to it, bent downward.
  const down = midiPitch(59.75);
  assert.equal(down.note, 60);
  assert.ok(down.bend < 8192, 'bend must fall below centre');

  // Math.round rounds .5 upward, so a half step lands on the note above and
  // bends down to reach the pitch.
  const half = midiPitch(60.5);
  assert.equal(half.note, 61);
  assert.ok(half.bend < 8192);
});

test('pitch bend stays inside the 14-bit range', () => {
  for (const pitch of [-5, 0, 63.9, 64.1, 126, 127, 200]) {
    const { note, bend } = midiPitch(pitch);
    assert.ok(note >= 0 && note <= 127, `note for ${pitch}`);
    assert.ok(bend >= 0 && bend <= 16383, `bend for ${pitch}`);
  }
});

test('bend range is declared as a six-message RPN', () => {
  const messages = bendRangeMessages(1, 48);
  assert.equal(messages.length, 6);
  assert.ok(messages.every((m) => m.length === 3));
  assert.ok(messages.every((m) => (m[0] & 0xf0) === 0xb0), 'all are control changes');
  assert.ok(messages.every((m) => (m[0] & 0x0f) === 1), 'all target the given channel');
  assert.equal(messages[2][2], 48, 'range value is carried in data entry');
});

test('hex grid geometry round-trips', () => {
  const radius = 38;
  const cx = 500;
  const cy = 300;
  for (let q = -6; q <= 6; q++) {
    for (let r = -6; r <= 6; r++) {
      const { x, y } = toHexPoint(q, r, radius, cx, cy);
      const back = fromHexPoint(x, y, radius, cx, cy);
      assert.deepEqual(back, { q, r }, `cell ${q},${r}`);
    }
  }
});

test('neighbouring cells are one radius apart', () => {
  const radius = 38;
  const a = toHexPoint(0, 0, radius, 0, 0);
  const b = toHexPoint(1, 0, radius, 0, 0);
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  assert.equal(distance.toFixed(6), (Math.sqrt(3) * radius).toFixed(6));
});

test('touching between cells snaps to the nearest cell', () => {
  const radius = 38;
  const centre = toHexPoint(0, 0, radius, 0, 0);
  const right = toHexPoint(1, 0, radius, 0, 0);
  // A point 80% of the way to the neighbour resolves to that neighbour.
  const near = {
    x: centre.x + (right.x - centre.x) * 0.8,
    y: centre.y + (right.y - centre.y) * 0.8,
  };
  assert.deepEqual(fromHexPoint(near.x, near.y, radius, 0, 0), { q: 1, r: 0 });
});
