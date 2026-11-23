// RkEdits: what can be edited on the page and the unsaved edits. No DOM, no MIDI: the page sends what these return.
//   FIELDS          program fields changed live in the keytar's edit buffer (PARAMETER CHANGE, func 41)
//   GLOBAL_FIELDS   global settings: no Parameter Change, so edits wait until SAVE GLOBAL writes the whole global dump
//   ProgramEdits    unsaved edit-buffer changes of one program; what a dropdown sends; edits made on the keytar
//   GlobalEdits     unsaved global changes
// Programs here are decodeProgram() results; global data is decodeGlobal() results.
// Loaded as a classic script (window.RkEdits) or with require() in Node (tests). No class fields: iOS 15 WebKit.
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const R = isNode ? (require('./rk-sysex.js'), globalThis.RkSysEx) : window.RkSysEx;

  // ------------------------------------------------------------ value texts
  const noteText = (n) => `${R.KEYS[n % 12]}${Math.floor(n / 12) - 1}`; // 0 = C-1, 60 = C4
  const ccText = (n) => `CC#${String(n).padStart(2, '0')}`;
  const signedText = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const rangeText = (n) => (n < 0 ? `${-n} Octave (Rev)` : `${n} Octave`);
  // Long Ribbon scale key: -12..+12 semitones around C ("downC ~ C ~ upC").
  const ribbonKeyText = (n) => {
    const name = R.KEYS[((n % 12) + 12) % 12];
    return n < 0 ? `${name} (down)` : n === 12 ? `${name} (up)` : name;
  };
  const transposeText = (n) => (n > 0 ? `+${n}` : String(n));
  const chText = (v) => (v >= 16 ? 'Global' : String(v + 1));

  // ------------------------------------------------------------ program fields
  const octaves = Array.from({ length: 17 }, (_, k) => k - 8).map((n) => [n, rangeText(n)]);
  const onOff = [[0, 'Off'], [1, 'On']];
  // Arpeggiator as one value: -1 = off, 0..5 = on with that type.
  const arpValue = (p) => (p.arpOn ? p.arpType : -1);

  // Each field: label, options [[value, text]], and either param (one Parameter Change) or messages(v, p).
  // Optional: text(v) for a stored value the options don't list; enabled(p) when it only matters in some modes;
  // keys(p) when the edit is kept under other names than the field's own.
  const FIELDS = {
    arp: {
      label: 'Arpeggiator',
      options: [[-1, 'Off'], ...R.ARP_TYPES.map((n, v) => [v, n])],
      // Off only switches it off (the stored type stays). A type sets the type, then switches it on.
      messages: (v) => (v < 0 ? [[...R.PARAM.ARP_ON, 0]] : [[...R.PARAM.ARP_TYPE, v], [...R.PARAM.ARP_ON, 1]]),
    },
    // 0~127 = C-1~G9. Only used in Split mode.
    centerKey: { label: 'Split key', param: R.PARAM.CENTER_KEY, options: Array.from({ length: 128 }, (_, v) => [v, noteText(v)]),
      enabled: (p) => p.voiceMode === 2 },
    // 0~15 = ch 1~16, 16+ = Global. Only used in Multi mode.
    timbre2Ch: { label: 'Timbre 2 MIDI channel', param: R.PARAM.TIMBRE2_MIDI_CH,
      options: [...Array.from({ length: 16 }, (_, v) => [v, String(v + 1)]), [16, 'Global']], text: chText,
      enabled: (p) => p.voiceMode === 3 },
    keySync: { label: 'Arpeggiator key sync', param: R.PARAM.ARP_KEY_SYNC, options: onOff },
    arpLatch: { label: 'Arpeggiator latch', param: R.PARAM.ARP_LATCH, options: onOff },
    t1Wave: { label: 'Timbre 1 wave', param: R.PARAM.T1_OSC1_WAVE, options: R.OSC1_WAVES.map((n, v) => [v, n]) },
    t1PcmWave: { label: 'Timbre 1 wave select', param: R.PARAM.T1_OSC1_PCM_WAVE, options: R.PCM_WAVES.map((n, v) => [v, n]),
      enabled: (p) => p.t1Wave === 6 }, // only for PCM/DWGS
    arpResolution: { label: 'Arpeggiator resolution', param: R.PARAM.ARP_RESOLUTION, options: R.ARP_RESOLUTIONS.map((n, v) => [v, n]) },
    arpLastStep: { label: 'Arpeggiator last step', param: R.PARAM.ARP_LAST_STEP, options: [0, 1, 2, 3, 4, 5, 6, 7].map((v) => [v, String(v + 1)]) },
    arpOctRange: { label: 'Arpeggiator octave range', param: R.PARAM.ARP_OCTAVE_RANGE, options: [0, 1, 2, 3].map((v) => [v, String(v + 1)]) },
    // Step 1~8 on/off (the STEP EDIT buttons).
    ...Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`arpStep${k}`,
      { label: `Arpeggiator step ${k + 1}`, param: R.PARAM.ARP_STEP(k), options: onOff }])),
    arpTimbre: { label: 'Arp timbre', param: R.PARAM.ARP_TIMBRE, options: R.TIMBRE_SELECT.map((n, v) => [v, n]) },
    voiceMode: { label: 'Voice mode', param: R.PARAM.VOICE_MODE, options: R.VOICE_MODES.map((n, v) => [v, n]) },
    scaleType: { label: 'Scale', param: R.PARAM.SCALE_TYPE, options: R.SCALE_TYPES.map((n, v) => [v, n]) },
    scaleKey: { label: 'Scale key', param: R.PARAM.SCALE_KEY, options: R.KEYS.map((n, v) => [v, n]) },
    ribbonScaleType: { label: 'Long Ribbon scale type', param: R.PARAM.LONG_RIBBON_SCALE_TYPE, options: R.RIBBON_SCALES.map((n, v) => [v, n]) },
    ribbonScaleRange: { label: 'Long Ribbon scale range', param: R.PARAM.LONG_RIBBON_SCALE_RANGE, options: octaves },
    ribbonPitchRange: { label: 'Long Ribbon (pitch) range', param: R.PARAM.LONG_RIBBON_PITCH_RANGE, options: octaves },
    shortRibbonAssign: { label: 'Short Ribbon modulation assign', param: R.PARAM.SHORT_RIBBON_ASSIGN, options: Array.from({ length: 128 }, (_, v) => [v, ccText(v)]) },
    // A timbre parameter: sent to the timbre the Long Ribbon controls (both for Timbre 1+2). The edit is kept per
    // timbre (t1FilterInt / t2FilterInt), so changing TIMBRE SELECT afterwards shows the right timbre's value.
    filterInt: {
      label: 'Long Ribbon filter intensity',
      options: Array.from({ length: 127 }, (_, k) => k - 63).map((n) => [n, signedText(n)]),
      keys: (p) => [...(p.ribbonTimbre !== 1 ? ['t1FilterInt'] : []), ...(p.ribbonTimbre !== 0 ? ['t2FilterInt'] : [])],
      messages: (v, p) => FIELDS.filterInt.keys(p).map((k) => [...(k === 't1FilterInt' ? R.PARAM.T1_LONG_RIBBON_FILTER_INT : R.PARAM.T2_LONG_RIBBON_FILTER_INT), v]),
    },
    ribbonTimbre: { label: 'Long Ribbon timbre select', param: R.PARAM.LONG_RIBBON_TIMBRE, options: R.TIMBRE_SELECT.map((n, v) => [v, n]) },
    // The keytar allows -12..+12 (down C .. up C); the dropdown offers the 12 notes C..B.
    ribbonScaleKey: { label: 'Long Ribbon scale key', param: R.PARAM.LONG_RIBBON_SCALE_KEY, options: R.KEYS.map((n, v) => [v, n]), text: ribbonKeyText },
    shortRibbonLock: { label: 'Short Ribbon modulation lock', param: R.PARAM.SHORT_RIBBON_LOCK, options: [[0, 'Lock Off'], [1, 'Lock On']] },
    shortRibbonSetting: { label: 'Short Ribbon setting', param: R.PARAM.SHORT_RIBBON_SETTING, options: [[0, 'Pitch'], [1, 'Modulation']] },
  };

  // The label of an edit key (the filter intensity is kept per timbre).
  const editLabel = (k) => (k === 't1FilterInt' || k === 't2FilterInt' ? FIELDS.filterInt.label : FIELDS[k].label);

  // The stored value of an edit key (the arpeggiator is one value made of two).
  const storedValue = (p, k) => (k === 'arp' ? arpValue(p) : p[k]);

  // Stored program with edits applied. filterInt follows the (possibly edited) ribbon timbre.
  function withEdits(stored, edits) {
    const p = { ...stored, arp: arpValue(stored), ...edits };
    p.filterInt = p.ribbonTimbre === 1 ? p.t2FilterInt : p.t1FilterInt;
    return p;
  }

  // The edit keys in edits that program p (read back after a save) doesn't have.
  const missingEdits = (edits, p) => Object.keys(edits).filter((k) => storedValue(p, k) !== edits[k]);

  // Rotate the arpeggiator steps up to the last step, d = -1 (left) or 1 (right). Returns the [key, value] that change.
  function rotateSteps(p, d) {
    const n = p.arpLastStep + 1;
    const cur = Array.from({ length: n }, (_, k) => p[`arpStep${k}`]);
    return cur.map((_, k) => cur[(k - d + n) % n])
      .map((v, k) => [`arpStep${k}`, v])
      .filter(([, v], k) => v !== cur[k]);
  }

  // ------------------------------------------------------------ program edits
  // The unsaved changes in the keytar's edit buffer. They belong to one program: like turning a knob on the keytar,
  // they're lost on the next program change unless saved.
  class ProgramEdits {
    constructor() { this.prog = null; this.values = {}; }

    clear() { this.prog = null; this.values = {}; }
    // The edits of program i ({} if it has none).
    of(i) { return this.prog === i ? this.values : {}; }
    // Program i as it is in the edit buffer.
    view(i, stored) { return withEdits(stored, this.of(i)); }
    any(i) { return Object.keys(this.of(i)).length > 0; }
    // Whether a field shows as changed (the filter intensity: either timbre it applies to).
    modified(i, key, p) {
      const f = FIELDS[key], e = this.of(i);
      return f && f.keys ? f.keys(p).some((k) => k in e) : key in e;
    }

    // Remember an edit, or forget it when it's back to the stored value.
    note(i, stored, key, v) {
      if (this.prog !== i) { this.prog = i; this.values = {}; }
      if (v === storedValue(stored, key)) delete this.values[key]; else this.values[key] = v;
    }

    // Set a field of program i (its stored data: stored) from the page. Returns the [id, sub, value] Parameter
    // Changes to send.
    change(i, stored, key, v) {
      const f = FIELDS[key];
      const p = this.view(i, stored);
      const msgs = f.messages ? f.messages(v, p) : [[...f.param, v]];
      (f.keys ? f.keys(p) : [key]).forEach((k) => this.note(i, stored, k, v));
      return msgs;
    }

    // A Parameter Change from the keytar (a knob or button on it) while program i is selected.
    // Returns true when it's a field the page shows.
    fromKeytar(i, stored, m) {
      const is = ([id, sub]) => m.id === id && m.sub === sub;
      const e = this.of(i);
      const arpNow = 'arp' in e ? e.arp : arpValue(stored);
      if (is(R.PARAM.ARP_ON)) {
        // ARP button: on restores the last known type.
        this.note(i, stored, 'arp', m.value ? (arpNow >= 0 ? arpNow : stored.arpType) : -1);
      } else if (is(R.PARAM.ARP_TYPE)) {
        if (arpNow >= 0) this.note(i, stored, 'arp', m.value); // while off, the type shows when it's switched on
      } else if (is(R.PARAM.T1_LONG_RIBBON_FILTER_INT)) {
        this.note(i, stored, 't1FilterInt', m.value);
      } else if (is(R.PARAM.T2_LONG_RIBBON_FILTER_INT)) {
        this.note(i, stored, 't2FilterInt', m.value);
      } else {
        const key = Object.keys(FIELDS).find((k) => FIELDS[k].param && is(FIELDS[k].param));
        if (!key) return false;
        this.note(i, stored, key, m.value);
      }
      return true;
    }
  }

  // ------------------------------------------------------------ global fields and edits
  const GLOBAL_FIELDS = {
    transpose: { label: 'Transpose', options: Array.from({ length: 25 }, (_, k) => k - 12).map((n) => [n, transposeText(n)]) },
    // Text field in Hz: only 430.0~450.0 (one decimal) is accepted; stored as (Hz - 440) x 10.
    masterTune: { label: 'Master tune', input: true, text: (v) => (440 + v / 10).toFixed(1),
      parse: (t) => {
        if (!/^\s*\d{3}(\.\d?)?\s*$/.test(t)) return null;
        const hz = parseFloat(t);
        return hz >= 430 && hz <= 450 ? Math.round((hz - 440) * 10) : null;
      } },
    velCurve: { label: 'Velocity curve', options: [...Array.from({ length: 8 }, (_, v) => [v, `Curve ${v + 1}`]), [8, 'Constant']] },
    ribbonMidiCh: { label: 'Long Ribbon MIDI channel', options: [...Array.from({ length: 16 }, (_, v) => [v, String(v + 1)]), [16, 'Global']], text: chText },
    ...Object.fromEntries(R.CC_MAP_NAMES.map((n, k) => [`ccMap${k}`,
      { label: `CC# map: ${n}`, options: R.CC_MAP_VALUES.map((v) => [v, v < 0 ? 'Off' : ccText(v)]), text: (v) => (v < 0 ? 'Off' : ccText(v)) }])),
    ...Object.fromEntries(R.KEYS.map((n, k) => [`userScale${k}`,
      { label: `User scale ${n}`, options: Array.from({ length: 127 }, (_, j) => j - 63).map((c) => [c, String(c)]) }])),
  };

  // Unsaved global changes {field: value}. g = decodeGlobal() of the stored data.
  class GlobalEdits {
    constructor() { this.values = {}; }
    get any() { return Object.keys(this.values).length > 0; }
    has(key) { return key in this.values; }
    view(g) { return { ...g, ...this.values }; }
    // Remember an edit, or forget it when it's back to the stored value.
    set(g, key, v) { if (v === g[key]) delete this.values[key]; else this.values[key] = v; }
    // Forget edits the stored data now has anyway (after a save or a fresh global dump). Returns the ones left.
    prune(g) {
      for (const k of Object.keys(this.values)) if (this.values[k] === g[k]) delete this.values[k];
      return Object.keys(this.values);
    }
  }

  const RkEdits = {
    FIELDS, GLOBAL_FIELDS, ProgramEdits, GlobalEdits,
    arpValue, withEdits, editLabel, missingEdits, rotateSteps,
  };
  if (isNode) module.exports = RkEdits; else window.RkEdits = RkEdits;
})();
