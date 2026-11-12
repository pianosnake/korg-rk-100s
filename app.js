// RK-100S program viewer: connect, list the 200 programs + favorites, follow the keytar.
(function () {
  'use strict';
  const R = window.RK100S;
  const $ = (id) => document.getElementById(id);
  const pad3 = (n) => String(n).padStart(3, '0');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


  const state = {
    programs: [],        // raw 352-byte arrays
    decoded: [],         // decodeProgram() results
    favorites: null,     // 40 program numbers (5 banks x A..H)
    edit: null,          // unsaved changes in the keytar's edit buffer: {prog, values: {field: value}}
    progChgOn: true,     // Global "ProgChg Filter": keytar ignores Program Change when disabled
    current: null,       // program selected on the keytar
    viewed: null,        // program shown in the details pane
    busy: false,
  };
  const midi = { access: null, input: null, output: null, channel: 0, connected: false, waiter: null, bank: 0 };

  // ------------------------------------------------------------ rendering
  function setStatus(t) { $('status-text').textContent = t; }
  function setConn(text, cls) { const el = $('conn-status'); el.textContent = text; el.className = `status ${cls}`; }

  function renderFavorites() {
    const favs = state.favorites;
    let html = '<tr><th></th>' + 'ABCDEFGH'.split('').map((c) => `<th>${c}</th>`).join('') + '</tr>';
    for (let b = 0; b < 5; b++) {
      html += `<tr><th class="bank">#${b + 1}</th>`;
      for (let k = 0; k < 8; k++) {
        const prog = favs ? favs[b * 8 + k] : null;
        const cls = [prog != null && prog === state.current ? 'cur' : '', prog != null && prog === state.viewed ? 'viewed' : ''].join(' ');
        const name = prog != null && state.decoded[prog] ? state.decoded[prog].name.trimEnd() : '';
        html += `<td class="${cls}" data-i="${prog ?? ''}" title="${esc(name)}">${prog != null ? pad3(prog + 1) : '&nbsp;'}</td>`;
      }
      html += '</tr>';
    }
    $('fav-table').innerHTML = html;
  }

  function renderList() {
    const list = $('list');
    if (!state.decoded.length) {
      list.innerHTML = '<div class="empty">Connect to the RK-100S to load its programs.</div>';
      return;
    }
    list.innerHTML = state.decoded.map((p, i) => {
      const cls = ['row', i === state.current ? 'cur' : '', i === state.viewed ? 'viewed' : ''].join(' ');
      return `<div class="${cls}" data-i="${i}"><span class="num">${pad3(i + 1)}</span>` +
        `<span class="name">${esc(p.name)}</span><span class="mode">${esc(R.VOICE_MODES[p.voiceMode] || '?')}</span><span class="rscale">${esc(R.RIBBON_SCALES[p.ribbonScaleType] || '?')}</span><span class="cat">${esc(R.CATEGORIES[p.category])}</span></div>`;
    }).join('');
  }

  // Cheap highlight update (avoids rebuilding 200 rows on every program change).
  function markRows() {
    $('list').querySelectorAll('.row').forEach((el) => {
      const i = +el.dataset.i;
      el.classList.toggle('cur', i === state.current);
      el.classList.toggle('viewed', i === state.viewed);
    });
  }

  const noteText = (n) => `${R.KEYS[n % 12]}${Math.floor(n / 12) - 1}`; // 0 = C-1, 60 = C4
  const ccText = (n) => `CC#${String(n).padStart(2, '0')}`;
  const signedText = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const rangeText = (n) => (n < 0 ? `${-n} Octave (Rev)` : `${n} Octave`);
  // Long Ribbon scale key: -12..+12 semitones around C ("downC ~ C ~ upC").
  const ribbonKeyText = (n) => {
    const name = R.KEYS[((n % 12) + 12) % 12];
    return n < 0 ? `${name} (down)` : n === 12 ? `${name} (up)` : name;
  };

  // Program fields that can be changed live on the keytar (PARAMETER CHANGE into the edit buffer).
  const octaves = Array.from({ length: 17 }, (_, k) => k - 8).map((n) => [n, rangeText(n)]);
  // Arpeggiator as one value: -1 = off, 0..5 = on with that type.
  const arpValue = (p) => (p.arpOn ? p.arpType : -1);
  const EDITABLE = {
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
      options: [...Array.from({ length: 16 }, (_, v) => [v, String(v + 1)]), [16, 'Global']], text: (v) => (v >= 16 ? 'Global' : String(v + 1)),
      enabled: (p) => p.voiceMode === 3 },
    keySync: { label: 'Arpeggiator key sync', param: R.PARAM.ARP_KEY_SYNC, options: [[0, 'Off'], [1, 'On']] },
    arpLatch: { label: 'Arpeggiator latch', param: R.PARAM.ARP_LATCH, options: [[0, 'Off'], [1, 'On']] },
    arpOctRange: { label: 'Arpeggiator octave range', param: R.PARAM.ARP_OCTAVE_RANGE, options: [0, 1, 2, 3].map((v) => [v, String(v + 1)]) },
    // Step 1~8 on/off (STEP EDIT buttons; not drawn by editor()).
    ...Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`arpStep${k}`,
      { label: `Arpeggiator step ${k + 1}`, param: R.PARAM.ARP_STEP(k), options: [[0, 'Off'], [1, 'On']] }])),
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
      messages: (v, p) => EDITABLE.filterInt.keys(p).map((k) => [...(k === 't1FilterInt' ? R.PARAM.T1_LONG_RIBBON_FILTER_INT : R.PARAM.T2_LONG_RIBBON_FILTER_INT), v]),
    },
    ribbonTimbre: { label: 'Long Ribbon timbre select', param: R.PARAM.LONG_RIBBON_TIMBRE, options: R.TIMBRE_SELECT.map((n, v) => [v, n]) },
    // The keytar allows -12..+12 (down C .. up C); the dropdown offers the 12 notes C..B.
    ribbonScaleKey: { label: 'Long Ribbon scale key', param: R.PARAM.LONG_RIBBON_SCALE_KEY, options: R.KEYS.map((n, v) => [v, n]), text: ribbonKeyText },
    shortRibbonLock: { label: 'Short Ribbon modulation lock', param: R.PARAM.SHORT_RIBBON_LOCK, options: [[0, 'Lock Off'], [1, 'Lock On']] },
    shortRibbonSetting: { label: 'Short Ribbon setting', param: R.PARAM.SHORT_RIBBON_SETTING, options: [[0, 'Pitch'], [1, 'Modulation']] },
  };

  // Stored program with the unsaved edits applied. filterInt follows the (possibly edited) ribbon timbre.
  function withEdits(stored, edits) {
    const p = { ...stored, arp: arpValue(stored), ...edits };
    p.filterInt = p.ribbonTimbre === 1 ? p.t2FilterInt : p.t1FilterInt;
    return p;
  }
  const editLabel = (k) => (k === 't1FilterInt' || k === 't2FilterInt' ? EDITABLE.filterInt.label : EDITABLE[k].label);

  function renderDetails() {
    const el = $('details');
    const i = state.viewed;
    const stored = i != null ? state.decoded[i] : null;
    if (!stored) { el.innerHTML = '<div class="empty">Click a program to see its details.</div>'; return; }
    const edits = state.edit && state.edit.prog === i && i === state.current ? state.edit.values : {};
    const p = withEdits(stored, edits);

    // One labelled box, like the old editor: caption above, black LCD value below.
    const field = (caption, value) => `<div class="field"><div class="cap">${esc(caption)}</div><div class="val">${esc(value)}</div></div>`;
    const editor = (caption, key) => {
      const f = EDITABLE[key];
      // Keep a stored value the dropdown doesn't offer (e.g. a Long Ribbon key below/above C..B) selectable.
      const options = f.options.some(([v]) => v === p[key]) ? f.options : [...f.options, [p[key], f.text ? f.text(p[key]) : String(p[key])]];
      const opts = options.map(([v, name]) => `<option value="${v}"${v === p[key] ? ' selected' : ''}>${esc(name)}</option>`).join('');
      const modified = f.keys ? f.keys(p).some((k) => k in edits) : key in edits;
      // Fields that only matter in some modes (split key, timbre 2 channel) are greyed out otherwise.
      const off = f.enabled && !f.enabled(p);
      return `<div class="field${modified ? ' modified' : ''}${off ? ' off' : ''}"><div class="cap">${esc(caption)}</div><select class="val" data-field="${key}"${off ? ' disabled' : ''}>${opts}</select></div>`;
    };
    // On/off field as a checkbox (custom-drawn: WebKit ignores borders on native checkboxes).
    const checkbox = (caption, key) =>
      `<div class="field${key in edits ? ' modified' : ''}"><div class="cap">${esc(caption)}</div>` +
      `<label class="check"><input type="checkbox" data-field="${key}"${p[key] ? ' checked' : ''}><span>On</span></label></div>`;
    // STEP EDIT: 8 step on/off buttons (lit red when on) and ◀ ▶ to rotate the pattern. Steps after the
    // program's last step are dimmed: the keytar doesn't play them.
    const stepEdit = () => {
      const steps = Array.from({ length: 8 }, (_, k) => {
        const key = `arpStep${k}`;
        const cls = `step${p[key] ? ' on' : ''}${key in edits ? ' modified' : ''}${k > p.arpLastStep ? ' past' : ''}`;
        return `<button class="${cls}" data-step="${k}" title="Step ${k + 1}: ${p[key] ? 'on' : 'off'}${k > p.arpLastStep ? ' (after the last step)' : ''}">` +
          `<span class="n">${k + 1}</span><span class="led"></span></button>`;
      }).join('');
      return `<div class="step-edit"><div class="sub-title">STEP EDIT</div><div class="step-row">` +
        `<button class="shift" data-shift="-1" title="Rotate the pattern one step left">◀</button>` +
        `<button class="shift" data-shift="1" title="Rotate the pattern one step right">▶</button>` +
        `<div class="steps">${steps}</div></div></div>`;
    };
    const section = (title, body, extra = '') =>
      `<section class="sect${extra}"><div class="sect-title">${title}</div><div class="sect-body">${body}</div></section>`;

    const anyEdits = Object.keys(edits).length > 0;
    const canSave = anyEdits && !state.busy;

    el.innerHTML =
      `<div class="det-head"><div class="det-num">${pad3(i + 1)}</div>` +
      `<div class="det-name">${esc(p.name.trimEnd())}</div>` +
      `<button id="btn-save" class="save"${canSave ? '' : ' disabled'} title="${anyEdits ? `Save the changes into program ${pad3(i + 1)} on the keytar` : 'No changes to save'}">SAVE</button></div>` +
      `<div class="sect-grid">` +
      section('PROGRAM', [
        editor('VOICE MODE', 'voiceMode'),
        editor('SPLIT KEY', 'centerKey'),
        editor('TIMBRE 2 MIDI CH', 'timbre2Ch'),
      ].join(''), ' grid2 span2') +
      section('SCALE', [
        editor('SCALE', 'scaleType'),
        editor('SCALE KEY', 'scaleKey'),
      ].join(''), ' grid1') +
      section('ARPEGGIATOR', [
        editor('TYPE', 'arp'),
        editor('TIMBRE', 'arpTimbre'),
        editor('OCTAVE RANGE', 'arpOctRange'),
        `<div class="pair">${checkbox('LATCH', 'arpLatch')}${checkbox('KEY SYNC', 'keySync')}</div>`,
        stepEdit(),
      ].join(''), ' grid2 span2') +
      section('LONG RIBBON',
        `<div class="cols">` +
          `<div>${editor('TIMBRE SELECT', 'ribbonTimbre')}` +
          `${editor('SCALE TYPE', 'ribbonScaleType')}` +
          `${editor('SCALE KEY', 'ribbonScaleKey')}</div>` +
          `<div>${editor('SCALE RANGE', 'ribbonScaleRange')}` +
          `${editor('PITCH RANGE', 'ribbonPitchRange')}` +
          `${editor('FILTER INTENSITY', 'filterInt')}</div>` +
        `</div>`, ' ribbon span2') +
      section('SHORT RIBBON', [
        editor('SETTING', 'shortRibbonSetting'),
        editor('MODULATION ASSIGN', 'shortRibbonAssign'),
        checkbox('MODULATION LOCK', 'shortRibbonLock'),
      ].join(''), ' short') +
      `</div>`;
  }

  function renderAll() { renderFavorites(); renderList(); renderDetails(); }

  function scrollToRow(i) {
    const el = $('list').querySelector(`.row[data-i="${i}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ selection
  function view(i) {
    state.viewed = i;
    markRows(); renderFavorites(); renderDetails();
  }

  // Select the program on the keytar: Bank MSB 0, Bank LSB 0/1, Program Change on the global channel.
  // scroll: bring the row into view (favorites can point anywhere in the list).
  function selectOnKeytar(i, { scroll = false } = {}) {
    if (!midi.connected) { view(i); if (scroll) scrollToRow(i); setStatus('Not connected: only showing the details.'); return; }
    R.msg.programChange(midi.channel, i).forEach(send);
    setCurrent(i, { scroll });
    if (!state.progChgOn) setStatus('Program Change is disabled in the keytar\'s global settings, so it will ignore this.');
  }

  // Remember (or forget, when back to the stored value) an edit-buffer change.
  function noteEdit(i, key, v) {
    if (!state.edit || state.edit.prog !== i) state.edit = { prog: i, values: {} };
    const d = state.decoded[i];
    const base = key === 'arp' ? arpValue(d) : d[key];
    if (v === base) delete state.edit.values[key]; else state.edit.values[key] = v;
  }

  // Change a field in the keytar's edit buffer (PARAMETER CHANGE, func 41h).
  // Like turning a knob on the keytar: lost on the next program change unless written on the keytar.
  function setField(i, key, v) {
    const f = EDITABLE[key];
    if (!midi.connected) { setStatus('Not connected: cannot change it.'); renderDetails(); return; }
    if (i !== state.current) selectOnKeytar(i); // the edit buffer must hold this program first
    const p = withEdits(state.decoded[i], state.edit && state.edit.prog === i ? state.edit.values : {});
    const msgs = f.messages ? f.messages(v, p) : [[...f.param, v]];
    msgs.forEach(([id, sub, val]) => send(R.msg.parameterChange(midi.channel, id, sub, val)));
    (f.keys ? f.keys(p) : [key]).forEach((k) => noteEdit(i, k, v));
    renderDetails();
  }

  const sameBytes = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

  // Save the keytar's edit buffer into program slot i with PROGRAM WRITE REQUEST (func 11). It's a 10-byte
  // message, so it also gets through AUv3 hosts that choke on long outgoing SysEx. Then read the slot back
  // and check every edited field landed.
  async function saveProgram() {
    const i = state.edit && state.edit.prog;
    if (i == null || i !== state.current || state.busy) return;
    if (!midi.identified) await handshake(); // saving needs SysEx both ways
    if (!midi.identified) {
      setStatus('Cannot save: no SysEx is coming back from the keytar. Route the keytar\'s MIDI (with SysEx) into this plugin.');
      return;
    }
    const edits = { ...state.edit.values };
    state.busy = true; renderButtons(); renderDetails();
    const step = async (what, promise) => { try { return await promise; } catch (e) { throw new Error(`no reply ${what}`); } };
    try {
      setStatus(`Saving program ${pad3(i + 1)}…`);
      // A write must not be retried blindly: one attempt, wait for WRITE COMPLETED / WRITE ERROR.
      const reply = await step('to the write request', request(R.msg.programWriteRequest(midi.channel, i),
        (x) => ['write-ok', 'write-error', 'nak', 'format-error'].includes(x.type), { timeout: 3000, retries: 0 }));
      if (reply.type !== 'write-ok') throw new Error(`the keytar refused the write (${reply.type}; is memory protect on?)`);
      const back = await step('when reading the program back', request(R.msg.programDumpRequest(midi.channel, i),
        (x) => x.type === 'program' && x.number === i));
      const d = R.decodeProgram(back.data);
      const missing = Object.keys(edits).filter((k) => (k === 'arp' ? arpValue(d) : d[k]) !== edits[k]);
      if (missing.length) {
        await checkWrongSlot(i);
        throw new Error(`program ${pad3(i + 1)} on the keytar doesn't have the change (${missing.map(editLabel).join(', ')})`);
      }
      state.programs[i] = back.data;
      state.decoded[i] = d;
      state.edit = null;
      persist();
      renderList(); markRows(); renderFavorites();
      setStatus(`Saved program ${pad3(i + 1)}.`);
    } catch (e) {
      setStatus(`Save failed: ${e.message}`);
    } finally {
      state.busy = false; renderButtons(); renderDetails();
    }
  }

  // Safety net for programs 129-200: if the keytar ignored the program number's high byte it wrote
  // into slot i-128 instead. Detect that against our loaded copy and put the old program back.
  async function checkWrongSlot(i) {
    const j = i & 0x7F;
    if (j === i || !state.programs[j]) return;
    const m = await request(R.msg.programDumpRequest(midi.channel, j), (x) => x.type === 'program' && x.number === j);
    if (sameBytes(m.data, state.programs[j])) return;
    await request(R.msg.programDumpPacked(midi.channel, j, R.pack7(Array.from(state.programs[j]))),
      (x) => ['ack', 'nak', 'format-error'].includes(x.type), { timeout: 3000, retries: 0 });
    setStatus(`Program ${pad3(j + 1)} was overwritten by mistake and has been restored.`);
  }

  function setCurrent(i, { scroll = true } = {}) {
    state.current = i;
    state.edit = null; // a program change reloads the stored program
    state.viewed = i; // details follow the keytar
    markRows(); renderFavorites(); renderDetails();
    if (scroll) scrollToRow(i);
  }

  // ------------------------------------------------------------ cache
  const toB64 = (u8) => btoa(String.fromCharCode(...u8));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function persist() {
    try {
      localStorage.setItem('rk100s-simple-lib', JSON.stringify({
        programs: state.programs.map(toB64), favorites: state.favorites,
      }));
    } catch (e) { console.warn('Could not cache programs', e); }
  }

  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem('rk100s-simple-lib') || 'null');
      if (!s || !s.programs?.length) return;
      state.programs = s.programs.map(fromB64);
      state.decoded = state.programs.map(R.decodeProgram);
      state.favorites = s.favorites || null;
    } catch (e) { console.warn(e); }
  }

  // ------------------------------------------------------------ MIDI
  function send(bytes) { if (midi.output) midi.output.send(bytes); }

  function onMidiMessage(ev) {
    const d = ev.data;
    if (d[0] === 0xF0) {
      const m = R.parseSysex(d);
      if (!m) return;
      if (m.type !== 'identity-other' && m.channel != null && !midi.identified) markIdentified(m.channel);
      if (midi.waiter && midi.waiter.match(m)) {
        const w = midi.waiter; midi.waiter = null; clearTimeout(w.timer); w.resolve(m);
        return;
      }
      if (m.type === 'param' && state.current != null && state.decoded[state.current]) {
        // A field changed on the keytar itself.
        const is = ([id, sub]) => m.id === id && m.sub === sub;
        const cur = state.current;
        const edits = state.edit && state.edit.prog === cur ? state.edit.values : {};
        const arpNow = 'arp' in edits ? edits.arp : arpValue(state.decoded[cur]);
        if (is(R.PARAM.ARP_ON)) {
          // ARP button: on restores the last known type.
          noteEdit(cur, 'arp', m.value ? (arpNow >= 0 ? arpNow : state.decoded[cur].arpType) : -1);
        } else if (is(R.PARAM.ARP_TYPE)) {
          if (arpNow >= 0) noteEdit(cur, 'arp', m.value);
        } else if (is(R.PARAM.T1_LONG_RIBBON_FILTER_INT)) {
          noteEdit(cur, 't1FilterInt', m.value);
        } else if (is(R.PARAM.T2_LONG_RIBBON_FILTER_INT)) {
          noteEdit(cur, 't2FilterInt', m.value);
        } else {
          const key = Object.keys(EDITABLE).find((k) => EDITABLE[k].param && is(EDITABLE[k].param));
          if (!key) return;
          noteEdit(cur, key, m.value);
        }
        renderDetails();
        return;
      }
      // Unsolicited dumps (e.g. from the keytar's MIDI dump page, or after editing favorites).
      if (m.type === 'global') {
        ({ favorites: state.favorites, progChgFilter: state.progChgOn } = R.decodeGlobal(m.data));
        state.progChgOn = !!state.progChgOn;
        persist(); renderFavorites(); renderDetails();
        setStatus('Favorites updated from the keytar.');
      } else if (m.type === 'program' && m.number < R.NUM_PROGRAMS && state.programs.length) {
        state.programs[m.number] = m.data;
        state.decoded[m.number] = R.decodeProgram(m.data);
        persist(); renderAll();
        setStatus(`Program ${pad3(m.number + 1)} updated from the keytar.`);
      }
      return;
    }
    // Program changes made on the keytar: Bank LSB (CC#32) then Program Change.
    const status = d[0] & 0xF0;
    if (status === 0xB0 && d[1] === 0x20) midi.bank = d[2];
    if (status === 0xC0) {
      const prog = midi.bank * 128 + d[1];
      if (prog < R.NUM_PROGRAMS) setCurrent(prog);
    }
  }

  function request(bytes, match, { timeout = 1500, retries = 2 } = {}) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryOnce = () => {
        midi.waiter = {
          match, resolve,
          timer: setTimeout(() => {
            midi.waiter = null;
            if (attempt++ < retries) tryOnce(); else reject(new Error('No reply from the RK-100S'));
          }, timeout),
        };
        send(bytes);
      };
      tryOnce();
    });
  }

  async function initMidi() {
    if (!navigator.requestMIDIAccess) { setStatus('No Web MIDI here.'); return; }
    try {
      midi.access = await navigator.requestMIDIAccess({ sysex: true });
    } catch (e) { setStatus(`MIDI access denied (${e.message}). Allow MIDI/SysEx and reload.`); return; }
    midi.access.onstatechange = () => {
      if (midi.connected && (midi.input.state === 'disconnected' || midi.output.state === 'disconnected')) {
        disconnect(); setStatus('The MIDI device was disconnected.');
      }
      autoConnect(); // a device may have just appeared
    };
  }

  // Ports to use: the keytar's own ports by name if present
  // (In "RK-100S KBD/RIBBON", Out "RK-100S SOUND"), otherwise the first connected port.
  function pickPorts() {
    const pick = (ports, prefer) => {
      const list = Array.from(ports.values()).filter((p) => p.state !== 'disconnected');
      const rk = list.filter((p) => /RK-?100S/i.test(p.name));
      return rk.find((p) => prefer.test(p.name)) || rk[0] || list[0] || null;
    };
    return { input: pick(midi.access.inputs, /KBD|RIBBON/i), output: pick(midi.access.outputs, /SOUND/i) };
  }

  function autoConnect() {
    if (!midi.access || midi.connecting) return;
    const { input, output } = pickPorts();
    if (midi.connected) {
      // Switch over if better ports showed up (e.g. the keytar was plugged in after another device).
      if (input === midi.input && output === midi.output) return;
      disconnect();
    }
    if (input && output) connect(input, output);
    else { setConn('No MIDI device', 'off'); setStatus('Waiting for a MIDI device…'); }
  }

  function renderButtons() {
    $('btn-reload').disabled = !midi.connected || state.busy;
    $('btn-reload').textContent = state.programs.length ? 'Reload' : 'Load programs';
  }

  function disconnect() {
    if (midi.input) midi.input.onmidimessage = null;
    midi.input = midi.output = null; midi.connected = false; midi.identified = false;
    setConn('Not connected', 'off');
    renderButtons();
  }

  // The keytar answered something on channel ch: it's there and SysEx works both ways.
  function markIdentified(ch, version) {
    midi.channel = ch;
    if (version) midi.version = version;
    if (!midi.identified || version) setConn(`${midi.version ? `v${midi.version} · ` : ''}ch ${ch + 1}`, 'on');
    midi.identified = true;
    $('conn-status').title = `In: ${midi.input?.name} · Out: ${midi.output?.name}`;
  }

  async function connect(input, output) {
    midi.connecting = true;
    try { await Promise.all([input.open(), output.open()]); } finally { midi.connecting = false; }
    midi.input = input; midi.output = output;
    input.onmidimessage = onMidiMessage;
    midi.connected = true;
    $('conn-status').title = `In: ${input.name} · Out: ${output.name}`;
    renderButtons();
    await handshake();
  }

  // Find the keytar's global channel. Device Inquiry first; if that gets no answer (some hosts
  // drop universal SysEx), ask for the edit buffer on channel 1, the default global channel.
  async function handshake() {
    setConn('Searching…', 'warn');
    try {
      const id = await request(R.msg.identityRequest(), (m) => m.type === 'identity', { timeout: 1000, retries: 1 });
      markIdentified(id.channel, id.version);
    } catch (e) {
      try {
        const m = await request(R.msg.currentProgramDumpRequest(0), (x) => x.type === 'current-program', { timeout: 1000, retries: 1 });
        markIdentified(m.channel);
      } catch (e2) {
        if (!midi.identified) {
          setConn('Send only', 'warn');
          setStatus(`No SysEx from the keytar on "${midi.input.name}". Program changes are still sent; loading programs needs the keytar's MIDI (with SysEx) routed in.`);
        }
        return;
      }
    }
    if (state.programs.length) {
      await findCurrentProgram();
      renderAll();
      if (state.current != null) scrollToRow(state.current);
      setStatus('Connected. Press Reload to refresh');
    } else {
      setStatus('Connected. Press Load programs to receive the 200 programs.');
    }
  }

  async function receiveAll() {
    if (state.busy) return;
    if (!midi.identified) { await handshake(); if (!midi.identified) return; }
    state.busy = true; renderButtons();
    try {
      setStatus('Receiving favorites…');
      const g = await request(R.msg.globalDumpRequest(midi.channel), (x) => x.type === 'global');
      const programs = [];
      for (let i = 0; i < R.NUM_PROGRAMS; i++) {
        const m = await request(R.msg.programDumpRequest(midi.channel, i), (x) => x.type === 'program' && x.number === i);
        programs.push(m.data);
        if (i % 10 === 9) setStatus(`Receiving programs… ${i + 1}/200`);
      }
      state.programs = programs;
      state.decoded = programs.map(R.decodeProgram);
      ({ favorites: state.favorites, progChgFilter: state.progChgOn } = R.decodeGlobal(g.data));
      state.progChgOn = !!state.progChgOn;
      persist();
      await findCurrentProgram();
      renderAll();
      if (state.current != null) scrollToRow(state.current);
      setStatus('Loaded 200 programs.');
    } catch (e) {
      setStatus(`Receive failed: ${e.message}`);
    } finally {
      state.busy = false; renderButtons();
    }
  }

  // The keytar has no "which program is selected" query, so ask for its edit buffer and
  // look for the stored program with identical data. Works unless the sound has been edited.
  async function findCurrentProgram() {
    try {
      const m = await request(R.msg.currentProgramDumpRequest(midi.channel), (x) => x.type === 'current-program', { retries: 0 });
      const same = (a) => a.length === m.data.length && a.every((b, k) => b === m.data[k]);
      const hits = state.programs.map((p, i) => (same(p) ? i : -1)).filter((i) => i >= 0);
      if (hits.length === 1) { state.current = hits[0]; state.viewed = hits[0]; }
    } catch (e) { /* not critical */ }
  }

  // ------------------------------------------------------------ events
  $('btn-reload').onclick = receiveAll;
  const clicked = (e) => {
    const el = e.target.closest('[data-i]');
    return el && el.dataset.i !== '' ? +el.dataset.i : null;
  };
  // List and favorites clicks select the program on the keytar; arrow keys only show details.
  $('list').onclick = (e) => { const i = clicked(e); if (i != null) selectOnKeytar(i); };
  $('fav-table').onclick = (e) => { const i = clicked(e); if (i != null) selectOnKeytar(i, { scroll: true }); };
  $('details').onclick = (e) => {
    if (e.target.id === 'btn-save') { saveProgram(); return; }
    const i = state.viewed;
    if (i == null || !state.decoded[i]) return;
    const p = withEdits(state.decoded[i], state.edit && state.edit.prog === i ? state.edit.values : {});
    const step = e.target.closest('[data-step]');
    if (step) { const key = `arpStep${step.dataset.step}`; setField(i, key, p[key] ? 0 : 1); return; }
    const shift = e.target.closest('[data-shift]');
    if (shift) {
      // Rotate the steps up to the last step; only the steps that change are sent.
      const n = p.arpLastStep + 1, d = +shift.dataset.shift;
      const cur = Array.from({ length: n }, (_, k) => p[`arpStep${k}`]);
      const next = cur.map((_, k) => cur[(k - d + n) % n]);
      next.forEach((v, k) => { if (v !== cur[k]) setField(i, `arpStep${k}`, v); });
    }
  };
  $('details').onchange = (e) => {
    const key = e.target.dataset.field;
    if (key) setField(state.viewed, key, e.target.type === 'checkbox' ? +e.target.checked : +e.target.value);
  };
  $('list').onkeydown = (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 20, PageUp: -20 }[e.key];
    if (!step || !state.decoded.length) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(state.decoded.length - 1, (state.viewed ?? -1) + step));
    view(i); scrollToRow(i);
  };

  // ------------------------------------------------------------ boot
  restore();
  renderAll();
  initMidi().then(autoConnect);
})();
