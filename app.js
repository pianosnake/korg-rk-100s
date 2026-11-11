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
        `<span class="name">${esc(p.name)}</span><span class="cat">${esc(R.CATEGORIES[p.category])}</span></div>`;
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

  const signedText = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const rangeText = (n) => (n < 0 ? `${-n} Octave (Rev)` : `${n} Octave`);
  // Long Ribbon scale key: -12..+12 semitones around C ("downC ~ C ~ upC").
  const ribbonKeyText = (n) => {
    const name = R.KEYS[((n % 12) + 12) % 12];
    return n < 0 ? `${name} (down)` : n === 12 ? `${name} (up)` : name;
  };

  // Program fields that can be changed live on the keytar (PARAMETER CHANGE into the edit buffer).
  const octaves = Array.from({ length: 17 }, (_, k) => k - 8).map((n) => [n, rangeText(n)]);
  const EDITABLE = {
    scaleType: { label: 'Scale', param: R.PARAM.SCALE_TYPE, options: R.SCALE_TYPES.map((n, v) => [v, n]) },
    scaleKey: { label: 'Scale key', param: R.PARAM.SCALE_KEY, options: R.KEYS.map((n, v) => [v, n]) },
    ribbonScaleType: { label: 'Long Ribbon scale type', param: R.PARAM.LONG_RIBBON_SCALE_TYPE, options: R.RIBBON_SCALES.map((n, v) => [v, n]) },
    ribbonScaleRange: { label: 'Long Ribbon scale range', param: R.PARAM.LONG_RIBBON_SCALE_RANGE, options: octaves },
    ribbonPitchRange: { label: 'Long Ribbon (pitch) range', param: R.PARAM.LONG_RIBBON_PITCH_RANGE, options: octaves },
  };

  function renderDetails() {
    const el = $('details');
    const i = state.viewed;
    const stored = i != null ? state.decoded[i] : null;
    if (!stored) { el.innerHTML = '<div class="empty">Click a program to see its details.</div>'; return; }
    const edits = state.edit && state.edit.prog === i && i === state.current ? state.edit.values : {};
    const p = { ...stored, ...edits };

    // One labelled box, like the old editor: caption above, black LCD value below.
    const field = (caption, value) => `<div class="field"><div class="cap">${esc(caption)}</div><div class="val">${esc(value)}</div></div>`;
    const editor = (caption, key) => {
      const opts = EDITABLE[key].options.map(([v, name]) => `<option value="${v}"${v === p[key] ? ' selected' : ''}>${esc(name)}</option>`).join('');
      return `<div class="field${key in edits ? ' modified' : ''}"><div class="cap">${esc(caption)}</div><select class="val" data-field="${key}">${opts}</select></div>`;
    };
    const section = (title, body, extra = '') =>
      `<section class="sect${extra}"><div class="sect-title">${title}</div><div class="sect-body">${body}</div></section>`;

    const favSlots = (state.favorites || [])
      .map((prog, k) => (prog === i ? `Bank #${Math.floor(k / 8) + 1} ${'ABCDEFGH'[k % 8]}` : null))
      .filter(Boolean);
    const anyEdits = Object.keys(edits).length > 0;

    el.innerHTML =
      `<div class="det-head"><div class="det-num">${pad3(i + 1)}</div>` +
      `<div><div class="det-name">${esc(p.name.trimEnd())}</div>` +
      `<div class="det-sub">${i === state.current ? '<span class="badge">ON KEYTAR</span>' : ''}` +
      `${anyEdits ? ' <span class="edited" title="Write the program on the keytar to keep the changes">EDITED, NOT SAVED</span>' : ''}</div></div></div>` +
      `<div class="sect-row">` +
      section('PROGRAM', [
        field('VOICE MODE', R.VOICE_MODES[p.voiceMode]),
        field('OCTAVE', signedText(p.octave)),
        field('ARPEGGIATOR', `${p.arpOn ? 'On' : 'Off'} · ${R.ARP_TYPES[p.arpType] || '?'} · ${R.TIMBRE_SELECT[p.arpTimbre] || '?'}${p.keySync ? ' · Key Sync' : ''}`),
        field('FAVORITE', favSlots.length ? favSlots.join(', ') : '—'),
      ].join(''), ' grid2') +
      section('SCALE', [
        editor('SCALE', 'scaleType'),
        editor('SCALE KEY', 'scaleKey'),
      ].join(''), ' grid1') +
      `</div>` +
      `<div class="sect-row">` +
      section('LONG RIBBON',
        `<div class="cols">` +
          `<div>${field('TIMBRE SELECT', R.TIMBRE_SELECT[p.ribbonTimbre] || '?')}` +
          `${editor('SCALE TYPE', 'ribbonScaleType')}` +
          `${field('SCALE KEY', ribbonKeyText(p.ribbonScaleKey))}</div>` +
          `<div>${editor('SCALE RANGE', 'ribbonScaleRange')}` +
          `${editor('PITCH RANGE', 'ribbonPitchRange')}` +
          `${field('FILTER INTENSITY', signedText(p.filterInt))}</div>` +
        `</div>`, ' ribbon') +
      section('SHORT RIBBON', [
        field('SETTING', p.shortRibbonSetting ? 'Modulation' : 'Pitch'),
        field('MODULATION ASSIGN', `CC#${String(p.shortRibbonAssign).padStart(2, '0')}`),
        field('MODULATION LOCK', p.shortRibbonLock ? 'Lock On' : 'Lock Off'),
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
  function selectOnKeytar(i) {
    if (!midi.connected) { view(i); setStatus('Not connected: only showing the details.'); return; }
    R.msg.programChange(midi.channel, i).forEach(send);
    setCurrent(i, { scroll: false });
    setStatus(state.progChgOn ? `Sent program ${pad3(i + 1)} to the keytar.`
      : 'Program Change is disabled in the keytar\'s global settings, so it will ignore this.');
  }

  // Remember (or forget, when back to the stored value) an edit-buffer change.
  function noteEdit(i, key, v) {
    if (!state.edit || state.edit.prog !== i) state.edit = { prog: i, values: {} };
    if (v === state.decoded[i][key]) delete state.edit.values[key]; else state.edit.values[key] = v;
  }

  // Change a field in the keytar's edit buffer (PARAMETER CHANGE, func 41h).
  // Like turning a knob on the keytar: lost on the next program change unless written on the keytar.
  function setField(i, key, v) {
    const f = EDITABLE[key];
    if (!midi.connected) { setStatus('Not connected: cannot change it.'); renderDetails(); return; }
    if (i !== state.current) selectOnKeytar(i); // the edit buffer must hold this program first
    send(R.msg.parameterChange(midi.channel, f.param[0], f.param[1], v));
    noteEdit(i, key, v);
    renderDetails();
    const name = f.options.find(([x]) => x === v)[1];
    setStatus(`${f.label} set to ${name}. Write the program on the keytar to keep it.`);
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
        const key = Object.keys(EDITABLE).find((k) => EDITABLE[k].param[0] === m.id && EDITABLE[k].param[1] === m.sub);
        if (key) { noteEdit(state.current, key, m.value); renderDetails(); }
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
      setStatus('Connected. Showing the cached programs; press Reload to receive them again.');
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
  // List click selects the program on the keytar; the favorites grid and arrow keys only show details.
  $('list').onclick = (e) => { const i = clicked(e); if (i != null) selectOnKeytar(i); };
  $('fav-table').onclick = (e) => { const i = clicked(e); if (i != null) view(i); };
  $('details').onchange = (e) => {
    const key = e.target.dataset.field;
    if (key) setField(state.viewed, key, +e.target.value);
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
