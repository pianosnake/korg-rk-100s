// RK-100S protocol + data model (per the official KORG RK-100S MIDI Implementation).
// Plain script (no modules) so the page also works when opened straight from disk.
(function (global) {
  'use strict';

  const PROGRAM_SIZE = 352;          // decoded program bytes (TABLE 1)
  const GLOBAL_SIZE = 164;           // decoded global bytes (TABLE 7)
  const NUM_PROGRAMS = 200;

  const FUNC = {
    CURRENT_PROGRAM_DUMP_REQUEST: 0x10,
    PROGRAM_DUMP_REQUEST: 0x1C,
    GLOBAL_DUMP_REQUEST: 0x0E,
    PROGRAM_WRITE_REQUEST: 0x11,
    CURRENT_PROGRAM_DUMP: 0x40,
    PROGRAM_DUMP: 0x4C,
    GLOBAL_DUMP: 0x51,
    PARAMETER_CHANGE: 0x41,
    DATA_FORMAT_ERROR: 0x26,
    DATA_LOAD_COMPLETED: 0x23,
    DATA_LOAD_ERROR: 0x24,
    WRITE_COMPLETED: 0x21,
    WRITE_ERROR: 0x22,
  };

  // Label lists taken from the Sound Editor's own parameter tables.
  const CATEGORIES = [
    'Synth Hard', 'Synth Soft', 'Synth Brass', 'Strings/Pad', 'Motion', 'Bass',
    'Lead', 'Keyboard', 'Bell/Decay', 'Hit/Drum', 'S.E', 'Arp/Seq', 'Split',
    'Simple Wave', 'Vocoder', 'User',
  ];
  const VOICE_MODES = ['Single', 'Layer', 'Split', 'Multi'];
  const TIMBRE_SELECT = ['Timbre 1', 'Timbre 2', 'Timbre 1+2'];
  const SCALE_TYPES = [
    'Equal Temp', 'Pure Major', 'Pure Minor', 'Arabic', 'Pythagorean',
    'Werckmeister', 'Kirnberger', 'Slendro', 'Pelog', 'User Scale',
  ];
  const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const RIBBON_SCALES = [
    '"Scale Off"', 'Chromatic', 'Ionian', 'Dorian', 'Phrygian', 'Lydian',
    'Mixolydian', 'Aeolian', 'Locrian', 'Harmonic minor', 'Melodic minor',
    'Major Blues', 'minor Blues', 'Diminished', 'Combination Diminished',
    'Major Pentatonic', 'minor Pentatonic', 'Raga Bhairav', 'Raga Gamanasrama',
    'Raga Todi', 'Arabic', 'Spanish', 'Gypsy', 'Egyptian', 'Hawaiian',
    'Bali Island Pelog', 'Japanese Miyakobushi', 'Ryukyu', 'Chinese', 'Bass Line',
    'Whole Tone', 'minor 3rd Interval', '3rd Interval', '4th Interval',
    '5th Interval', 'Octave',
  ];
  // Parameter ID:Sub ID pairs from TABLE 1 (only the ones this app sends).
  const PARAM = {
    LONG_RIBBON_SCALE_TYPE: [0x70, 0x00],  // 0~35, see RIBBON_SCALES
    LONG_RIBBON_SCALE_RANGE: [0x70, 0x01], // -8~+8 octaves (plain signed value, no +64 offset)
    LONG_RIBBON_PITCH_RANGE: [0x70, 0x02], // -8~+8 octaves
  };
  const ARP_TYPES = ['Up', 'Down', 'Alt1', 'Alt2', 'Random', 'Trigger'];

  // ---- 8-bit <-> 7-bit dump conversion (NOTE 3) --------------------------
  function unpack7(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 8) {
      const hi = bytes[i];
      for (let j = 0; j < 7 && i + 1 + j < bytes.length; j++) {
        out.push(bytes[i + 1 + j] | (((hi >> j) & 1) << 7));
      }
    }
    return Uint8Array.from(out);
  }

  function pack7(data) {
    const out = [];
    for (let i = 0; i < data.length; i += 7) {
      const group = data.slice(i, i + 7);
      let hi = 0;
      group.forEach((b, j) => { if (b & 0x80) hi |= 1 << j; });
      out.push(hi);
      group.forEach((b) => out.push(b & 0x7F));
    }
    return out;
  }

  // ---- Message builders ---------------------------------------------------
  const header = (ch) => [0xF0, 0x42, 0x30 | (ch & 0x0F), 0x00, 0x01, 0x22];

  const msg = {
    identityRequest: () => [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7],
    globalDumpRequest: (ch) => [...header(ch), FUNC.GLOBAL_DUMP_REQUEST, 0xF7],
    currentProgramDumpRequest: (ch) => [...header(ch), FUNC.CURRENT_PROGRAM_DUMP_REQUEST, 0xF7],
    programDumpRequest: (ch, prog) =>
      [...header(ch), FUNC.PROGRAM_DUMP_REQUEST, prog & 0x7F, (prog >> 7) & 0x7F, 0xF7],
    currentProgramDump: (ch, data) =>
      [...header(ch), FUNC.CURRENT_PROGRAM_DUMP, ...pack7(Array.from(data)), 0xF7],
    // PARAMETER CHANGE (NOTE 4): 14-bit ID, sub ID and signed value, LSB first.
    parameterChange: (ch, id, sub, value) =>
      [...header(ch), FUNC.PARAMETER_CHANGE, id & 0x7F, (id >> 7) & 0x7F, sub & 0x7F, (sub >> 7) & 0x7F,
        value & 0x7F, (value >> 7) & 0x7F, 0xF7],
    // Program 001-128 = bank LSB 0, 129-200 = bank LSB 1 (MIDI impl. *2 / *7)
    programChange: (midiCh, prog) => [
      [0xB0 | midiCh, 0x00, 0x00],
      [0xB0 | midiCh, 0x20, prog >> 7],
      [0xC0 | midiCh, prog & 0x7F],
    ],
  };

  // ---- Message parsing ----------------------------------------------------
  // Returns {type, ...} for RK-100S / identity sysex, null otherwise.
  function parseSysex(d) {
    if (d[0] !== 0xF0) return null;
    if (d[1] === 0x7E && d[3] === 0x06 && d[4] === 0x02 && d[5] === 0x42) {
      if (d[6] !== 0x22 || d[7] !== 0x01) return { type: 'identity-other', channel: d[2] };
      return {
        type: 'identity',
        channel: d[2] & 0x0F,
        version: `${d[12]}.${String(d[10]).padStart(2, '0')}`, // e.g. 1.02
      };
    }
    if (d[1] !== 0x42 || (d[2] & 0xF0) !== 0x30 || d[3] !== 0x00 || d[4] !== 0x01 || d[5] !== 0x22) {
      return null;
    }
    const channel = d[2] & 0x0F;
    const func = d[6];
    const body = d.slice(7, d.length - 1); // strip func + F7
    switch (func) {
      case FUNC.PROGRAM_DUMP:
        return { type: 'program', channel, number: body[0] | (body[1] << 7), data: unpack7(body.slice(2)).slice(0, PROGRAM_SIZE) };
      case FUNC.CURRENT_PROGRAM_DUMP:
        return { type: 'current-program', channel, data: unpack7(body).slice(0, PROGRAM_SIZE) };
      case FUNC.GLOBAL_DUMP:
        return { type: 'global', channel, data: unpack7(body).slice(0, GLOBAL_SIZE) };
      case FUNC.PARAMETER_CHANGE:
        return {
          type: 'param', channel,
          id: body[0] | (body[1] << 7), sub: body[2] | (body[3] << 7),
          value: ((body[4] | (body[5] << 7)) << 18) >> 18, // signed 14-bit
        };
      case FUNC.DATA_LOAD_COMPLETED: return { type: 'ack', channel };
      case FUNC.DATA_LOAD_ERROR: return { type: 'nak', channel };
      case FUNC.DATA_FORMAT_ERROR: return { type: 'format-error', channel };
      case FUNC.WRITE_COMPLETED: return { type: 'write-ok', channel };
      case FUNC.WRITE_ERROR: return { type: 'write-error', channel };
      default: return { type: 'unknown', channel, func };
    }
  }

  // ---- Program / global decoding -----------------------------------------
  const signed = (v) => (v > 127 ? v - 256 : v);

  function decodeProgram(d) {
    const name = String.fromCharCode(...d.slice(0, 8)).replace(/[^\x20-\x7E]/g, ' ');
    const ribbonTimbre = d[348] >> 6;
    // Long Ribbon "FILTER" Int. lives at +91 in each timbre (TABLE 6).
    const t1FilterInt = d[16 + 91] - 64;
    const t2FilterInt = d[112 + 91] - 64;
    return {
      name,
      voiceMode: d[8] >> 6,
      arpTimbre: (d[8] >> 4) & 0x03,
      octave: (d[8] & 0x0F) - 8,
      scaleKey: d[12] >> 4,
      scaleType: d[12] & 0x0F,
      timbre2Ch: d[13],
      centerKey: d[14],
      tempo: d[334] | (d[335] << 8),
      arpOn: (d[336] >> 7) & 1,
      keySync: (d[336] >> 6) & 1,
      arpType: d[338] & 0x07,
      arpResolution: d[338] >> 4,
      shortRibbonLock: d[346] >> 7,
      shortRibbonAssign: d[346] & 0x7F,
      ribbonScaleSw: d[347] >> 7,
      ribbonScaleKey: ((d[347] >> 1) & 0x1F) - 16,
      shortRibbonSetting: d[347] & 1,
      ribbonTimbre,
      ribbonScaleType: d[348] & 0x3F,
      ribbonScaleRange: signed(d[349]) - 64,
      ribbonPitchRange: signed(d[350]) - 64,
      category: d[351] & 0x0F,
      filterInt: ribbonTimbre === 1 ? t2FilterInt : t1FilterInt,
    };
  }

  function decodeGlobal(d) {
    return {
      masterTune: signed(d[0]),
      transpose: d[1] - 12,
      midiChannel: d[4] & 0x0F,
      progChgFilter: d[9] & 1,
      favorites: Array.from(d.slice(100, 140)), // 5 banks x 8 (A..H), 0-based program numbers
    };
  }

  // ---- Sound Editor library files (.rk100s_all / .rk100s_prog etc.) -------
  // The file is a tree of chunks: 8-char tag ("12100PgD"), u16 header size, u32 payload size.
  // PgD payload = 352 program bytes (8-bit) + editor metadata; GbD payload = 164 global bytes + pad.
  function parseLibraryFile(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const programs = [];
    const meta = [];   // {programmer, comment} — Sound Editor-only info, never sent to the keytar
    let globalData = null;
    const cstr = (a, b) => {
      const bytes = u8.slice(a, b); const end = bytes.indexOf(0);
      return String.fromCharCode(...(end < 0 ? bytes : bytes.slice(0, end))).trim();
    };
    const tagAt = (i) => String.fromCharCode(...u8.slice(i, i + 8));
    for (let i = 0; i + 32 <= u8.length; i++) {
      if (u8[i] !== 0x31 || tagAt(i).slice(0, 5) !== '12100') continue;
      const tag = tagAt(i).slice(5);
      const headerSize = dv.getUint16(i + 8, true);
      const size = dv.getUint32(i + 10, true);
      const start = i + headerSize;
      if (tag === 'PgD' && size >= PROGRAM_SIZE) {
        programs.push(u8.slice(start, start + PROGRAM_SIZE));
        meta.push(size >= 472 ? { programmer: cstr(start + 384, start + 408), comment: cstr(start + 408, start + 472) } : {});
        i = start + size - 1;
      } else if (tag === 'GbD' && size >= GLOBAL_SIZE) {
        globalData = u8.slice(start, start + GLOBAL_SIZE);
        i = start + size - 1;
      } else {
        i += 7;
      }
    }
    return { programs, meta, globalData };
  }

  global.RK100S = {
    PROGRAM_SIZE, GLOBAL_SIZE, NUM_PROGRAMS, FUNC,
    CATEGORIES, VOICE_MODES, TIMBRE_SELECT, SCALE_TYPES, KEYS, RIBBON_SCALES, ARP_TYPES, PARAM,
    unpack7, pack7, msg, parseSysex, decodeProgram, decodeGlobal, parseLibraryFile,
  };
})(typeof window !== 'undefined' ? window : globalThis);
