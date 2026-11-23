// RK-100S program viewer: connect, list the 200 programs + favorites, follow the keytar.
(function () {
  'use strict';
  const R = window.RkSysEx;
  const E = window.RkEdits; // field tables and unsaved edits (rk-edits.js)
  const { FIELDS, GLOBAL_FIELDS } = E;
  const $ = (id) => document.getElementById(id);
  const pad3 = (n) => String(n).padStart(3, '0');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));


  const state = {
    programs: [],        // raw 352-byte arrays
    decoded: [],         // decodeProgram() results
    favorites: null,     // 40 program numbers (5 banks x A..H)
    global: null,        // raw 164-byte global data (TABLE 7)
    page: 'program',     // right pane: 'program' (details of state.viewed) or 'global' (GLOBAL button)
    progChgOn: true,     // Global "ProgChg Filter": keytar ignores Program Change when disabled
    current: null,       // program selected on the keytar
    viewed: null,        // program shown in the details pane
    busy: false,
  };
  const progEdits = new E.ProgramEdits();   // unsaved changes in the keytar's edit buffer
  const globalEdits = new E.GlobalEdits();  // unsaved global changes; sent with SAVE GLOBAL
  // The connection to the keytar (rk-link.js): ports, sending, request/reply. The page reacts through these handlers.
  const link = new window.RkLink({
    conn: setConn,
    status: setStatus,
    change: () => { renderButtons(); renderPorts(); },
    connected: handshake,
    sysex: onKeytarSysex,
    programChange: (prog) => setCurrent(prog),
  });
  const send = (bytes) => link.send(bytes);
  const request = (bytes, match, opts) => link.request(bytes, match, opts);

  // ------------------------------------------------------------ rendering
  function setStatus(t) { $('status-text').textContent = t; }
  function setConn(text, cls) {
    const el = $('conn-status'); el.textContent = text; el.className = `status ${cls}`;
    if (link.input) el.title = link.title;
  }

  // A titled box on the details pane (PROGRAM, SCALE, ARPEGGIATOR… / the GLOBAL page's sections).
  const section = (title, body, extra = '') =>
    `<section class="sect${extra}"><div class="sect-title">${title}</div><div class="sect-body">${body}</div></section>`;

  // A request's reply, or an error saying which step got none.
  async function replyTo(what, promise) {
    try { return await promise; } catch (e) { throw new Error(`no reply ${what}`); }
  }

  // Saving needs SysEx both ways: find the keytar if not yet, else say what's wrong. Resolves to true when it's there.
  async function canSave() {
    if (!link.identified) await handshake();
    if (!link.identified) setStatus('Cannot save: no SysEx is coming back from the keytar. Route the keytar\'s MIDI (with SysEx) into this plugin.');
    return link.identified;
  }

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

  function renderDetails() {
    const el = $('details');
    $('btn-global').classList.toggle('active', state.page === 'global');
    if (state.page === 'global') { el.innerHTML = globalPage(); renderPorts(); return; }
    const i = state.viewed;
    const stored = i != null ? state.decoded[i] : null;
    if (!stored) { el.innerHTML = '<div class="empty">Click a program to see its details.</div>'; return; }
    const edits = i === state.current ? progEdits.of(i) : {};
    const p = E.withEdits(stored, edits);

    // One labelled box, like the old editor: caption above, black LCD value below.
    const field = (caption, value) => `<div class="field"><div class="cap">${esc(caption)}</div><div class="val">${esc(value)}</div></div>`;
    const editor = (caption, key) => {
      const f = FIELDS[key];
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
        editor('RESOLUTION', 'arpResolution'),
        editor('OCTAVE RANGE', 'arpOctRange'),
        editor('LAST STEP', 'arpLastStep'),
        `<div class="pair">${checkbox('LATCH', 'arpLatch')}${checkbox('KEY SYNC', 'keySync')}</div>`,
        stepEdit(),
      ].join(''), ' grid3 span3') +
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
      section('TIMBRE 1', [
        editor('WAVE', 't1Wave'),
        editor('WAVE SELECT', 't1PcmWave'),
      ].join(''), ' grid1') +
      `</div>`;
  }

  // GLOBAL page (GLOBAL button): channel/transpose dropdowns and the USER SCALE keyboard (cents per note), with its own SAVE.
  function globalPage() {
    const anyEdits = globalEdits.any;
    const head = `<div class="det-head"><div class="det-name">GLOBAL</div>` +
      `<button id="btn-save-global" class="save"${anyEdits && !state.busy ? '' : ' disabled'} ` +
      `title="${anyEdits ? 'Write the global settings to the keytar' : 'No changes to save'}">SAVE</button>` +
      `<button id="btn-close-global" class="icon close" title="Close the global settings" aria-label="Close">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
    // The IN / OUT port menus (filled by renderPorts). Shown before the keytar's data is read: they're how it gets found.
    const portField = (caption, id, tip) =>
      `<div class="field"><div class="cap">${caption}</div><select class="val" id="${id}" title="${esc(tip)}"></select></div>`;
    const ports = section('MIDI PORTS',
      portField('IN', 'in-port', "The MIDI port the keytar's messages come in on (normally RK-100S KBD/RIBBON).") +
      portField('OUT', 'out-port', 'The MIDI port that goes to the keytar (normally RK-100S SOUND).'), ' grid2 span3');
    if (!state.global) return `${head}<div class="sect-grid">${ports}</div><div class="empty">Not read yet: connect the keytar (with SysEx both ways).</div>`;
    const g = globalEdits.view(R.decodeGlobal(state.global));
    const options = (key, cls = '') => {
      const f = GLOBAL_FIELDS[key];
      const list = f.options.some(([v]) => v === g[key]) ? f.options : [...f.options, [g[key], f.text ? f.text(g[key]) : String(g[key])]];
      return `<select class="${cls}" data-gfield="${key}" title="${esc(f.label)}">` +
        list.map(([v, name]) => `<option value="${v}"${v === g[key] ? ' selected' : ''}>${esc(name)}</option>`).join('') + '</select>';
    };
    const gInput = (caption, key, unit) =>
      `<div class="field${globalEdits.has(key) ? ' modified' : ''}"><div class="cap">${esc(caption)}</div>` +
      `<div class="with-unit"><input class="val" type="text" inputmode="decimal" maxlength="5" data-gfield="${key}" ` +
      `value="${GLOBAL_FIELDS[key].text(g[key])}" title="430.0 to 450.0 Hz"><span class="unit">${unit}</span></div></div>`;
    const gEditor = (caption, key) =>
      `<div class="field${globalEdits.has(key) ? ' modified' : ''}"><div class="cap">${esc(caption)}</div>${options(key, 'val')}</div>`;
    // One octave, C..B: white keys hold their value at the bottom, black keys (drawn over the gaps) at their own bottom.
    // Each box: the value drawn centred, with an invisible dropdown over it (iOS ignores text-align in a <select>).
    const box = (k) => { const key = `userScale${k}`;
      return `<span class="cents${globalEdits.has(key) ? ' modified' : ''}"><span class="num">${g[key]}</span>${options(key)}</span>`; };
    const whites = [0, 2, 4, 5, 7, 9, 11].map((k) => `<div class="wkey">${box(k)}</div>`).join('');
    const blacks = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]]
      .map(([k, gap]) => `<div class="bkey" style="--gap: ${gap}">${box(k)}</div>`).join('');
    return head + `<div class="sect-grid">` + ports +
      section('GLOBAL', gEditor('TRANSPOSE', 'transpose') + gEditor('VELOCITY CURVE', 'velCurve') +
        gEditor('LONG RIBBON MIDI CH', 'ribbonMidiCh') + gInput('MASTER TUNE', 'masterTune', 'Hz'), ' grid1') +
      section('USER SCALE', `<div class="kbd">${whites}${blacks}</div>`, ' uscale span2') +
      // CC# MAP: which CC each switch/ribbon parameter sends and receives. Two columns (1~32, 33~64) like the Sound Editor.
      section('CC# MAP', R.CC_MAP_NAMES.map((n, k) => {
        const key = `ccMap${k}`;
        return `<div class="field ccrow${globalEdits.has(key) ? ' modified' : ''}"><span class="name">${esc(n)}</span>${options(key, 'val')}</div>`;
      }).join(''), ' ccmap span3') +
      `</div>`;
  }

  function setGlobalField(key, v) {
    globalEdits.set(R.decodeGlobal(state.global), key, v);
    renderDetails();
  }

  // SAVE GLOBAL: read the keytar's global data fresh (so favorites etc. changed on the keytar are kept), patch the
  // edited fields in, send it as GLOBAL DATA DUMP (51, 196 bytes), wait for the ACK, then read it back and check.
  async function saveGlobal() {
    if (state.busy || !globalEdits.any) return;
    if (!(await canSave())) return;
    const edits = { ...globalEdits.values };
    state.busy = true; renderButtons(); renderDetails();
    const readGlobal = () => request(R.msg.globalDumpRequest(link.channel), (x) => x.type === 'global');
    try {
      setStatus('Saving global settings…');
      const fresh = await replyTo('when reading the global settings', readGlobal());
      const data = R.encodeGlobal(fresh.data, edits);
      const reply = await replyTo('to the global dump (long SysEx may not get through this host)',
        request(R.msg.globalDump(link.channel, data), (x) => ['ack', 'nak', 'format-error'].includes(x.type), { timeout: 3000, retries: 0 }));
      if (reply.type !== 'ack') throw new Error(`the keytar refused the global data (${reply.type})`);
      const back = await replyTo('when reading the global settings back', readGlobal());
      setGlobal(back.data); // drops the edits the keytar now has; any left over didn't land
      const missing = Object.keys(globalEdits.values);
      if (missing.length) throw new Error(`the keytar doesn't have the change (${missing.map((k) => GLOBAL_FIELDS[k].label).join(', ')})`);
      setStatus('Saved the global settings.');
    } catch (e) {
      setStatus(`Save failed: ${e.message}`);
    } finally {
      state.busy = false; renderButtons(); renderDetails();
    }
  }

  // New global data from the keytar: favorites, Program Change filter, global settings.
  function setGlobal(data) {
    state.global = data;
    ({ favorites: state.favorites, progChgFilter: state.progChgOn } = R.decodeGlobal(data));
    state.progChgOn = !!state.progChgOn;
    globalEdits.prune(R.decodeGlobal(data));
    persist();
  }

  function renderAll() { renderFavorites(); renderList(); renderDetails(); }

  function scrollToRow(i) {
    const el = $('list').querySelector(`.row[data-i="${i}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ selection
  function view(i) {
    state.page = 'program';
    state.viewed = i;
    markRows(); renderFavorites(); renderDetails();
  }

  // Select the program on the keytar: Bank MSB 0, Bank LSB 0/1, Program Change on the global channel.
  // scroll: bring the row into view (favorites can point anywhere in the list).
  function selectOnKeytar(i, { scroll = false } = {}) {
    if (!link.connected) { view(i); if (scroll) scrollToRow(i); setStatus('Not connected: only showing the details.'); return; }
    R.msg.programChange(link.channel, i).forEach(send);
    setCurrent(i, { scroll });
    if (!state.progChgOn) setStatus('Program Change is disabled in the keytar\'s global settings, so it will ignore this.');
  }

  // Change a field in the keytar's edit buffer (PARAMETER CHANGE, func 41h).
  // Like turning a knob on the keytar: lost on the next program change unless written on the keytar.
  function setField(i, key, v) {
    if (!link.connected) { setStatus('Not connected: cannot change it.'); renderDetails(); return; }
    if (i !== state.current) selectOnKeytar(i); // the edit buffer must hold this program first
    progEdits.change(i, state.decoded[i], key, v)
      .forEach(([id, sub, val]) => send(R.msg.parameterChange(link.channel, id, sub, val)));
    renderDetails();
  }

  const sameBytes = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);

  // Save the keytar's edit buffer into program slot i with PROGRAM WRITE REQUEST (func 11). It's a 10-byte
  // message, so it also gets through AUv3 hosts that choke on long outgoing SysEx. Then read the slot back
  // and check every edited field landed.
  async function saveProgram() {
    const i = progEdits.prog;
    if (i == null || i !== state.current || state.busy) return;
    if (!(await canSave())) return;
    const edits = { ...progEdits.values };
    state.busy = true; renderButtons(); renderDetails();
    try {
      setStatus(`Saving program ${pad3(i + 1)}…`);
      // A write must not be retried blindly: one attempt, wait for WRITE COMPLETED / WRITE ERROR.
      const reply = await replyTo('to the write request', request(R.msg.programWriteRequest(link.channel, i),
        (x) => ['write-ok', 'write-error', 'nak', 'format-error'].includes(x.type), { timeout: 3000, retries: 0 }));
      if (reply.type !== 'write-ok') throw new Error(`the keytar refused the write (${reply.type}; is memory protect on?)`);
      const back = await replyTo('when reading the program back', request(R.msg.programDumpRequest(link.channel, i),
        (x) => x.type === 'program' && x.number === i));
      const d = R.decodeProgram(back.data);
      const missing = E.missingEdits(edits, d);
      if (missing.length) {
        await checkWrongSlot(i);
        throw new Error(`program ${pad3(i + 1)} on the keytar doesn't have the change (${missing.map(E.editLabel).join(', ')})`);
      }
      state.programs[i] = back.data;
      state.decoded[i] = d;
      progEdits.clear();
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
    const m = await request(R.msg.programDumpRequest(link.channel, j), (x) => x.type === 'program' && x.number === j);
    if (sameBytes(m.data, state.programs[j])) return;
    await request(R.msg.programDumpPacked(link.channel, j, R.pack7(Array.from(state.programs[j]))),
      (x) => ['ack', 'nak', 'format-error'].includes(x.type), { timeout: 3000, retries: 0 });
    setStatus(`Program ${pad3(j + 1)} was overwritten by mistake and has been restored.`);
  }

  function setCurrent(i, { scroll = true } = {}) {
    state.current = i;
    progEdits.clear(); // a program change reloads the stored program
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
        global: state.global ? toB64(state.global) : null,
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
      state.global = s.global ? fromB64(s.global) : null;
    } catch (e) { console.warn(e); }
  }

  // ------------------------------------------------------------ MIDI (the connection itself is RkLink, rk-link.js)
  // SysEx from the keytar that no request was waiting for.
  function onKeytarSysex(m) {
    if (m.type === 'param' && state.current != null && state.decoded[state.current]) {
      // A field changed on the keytar itself.
      if (progEdits.fromKeytar(state.current, state.decoded[state.current], m)) renderDetails();
      return;
    }
    // Unsolicited dumps (e.g. from the keytar's MIDI dump page, or after editing favorites).
    if (m.type === 'global') {
      setGlobal(m.data);
      renderFavorites(); renderDetails();
      setStatus('Global settings updated from the keytar.');
    } else if (m.type === 'program' && m.number < R.NUM_PROGRAMS && state.programs.length) {
      state.programs[m.number] = m.data;
      state.decoded[m.number] = R.decodeProgram(m.data);
      persist(); renderAll();
      setStatus(`Program ${pad3(m.number + 1)} updated from the keytar.`);
    }
  }

  // The IN / OUT PORT menus: "auto" or a port the user picked. They're on the GLOBAL page only; not there otherwise.
  function renderPorts() {
    if (!link.access || !$('in-port')) return;
    const fill = (el, kind) => {
      const m = link.menu(kind);
      el.innerHTML = '<option value="">auto</option>' +
        (m.missing != null ? `<option value="saved" disabled>${esc(m.missing)} (not connected)</option>` : '') +
        m.ports.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
      el.value = m.value;
    };
    fill($('in-port'), 'input');
    fill($('out-port'), 'output');
  }

  function renderButtons() {
    $('btn-reload').disabled = !link.connected || state.busy;
    const what = state.programs.length ? 'Reload' : 'Load programs';
    $('btn-reload').title = `${what}: receive all programs and favorites from the keytar`;
    $('btn-reload').setAttribute('aria-label', what);
  }

  // Find the keytar, then read what the page shows from it.
  async function handshake() {
    if (!(await link.identify())) return;
    // Global settings (and favorites) are small: read them on every connect, even before the programs are loaded.
    try { setGlobal((await request(R.msg.globalDumpRequest(link.channel), (x) => x.type === 'global', { retries: 0 })).data); } catch (e) { /* not critical */ }
    renderFavorites(); renderDetails();
    if (state.programs.length) {
      await findCurrentProgram();
      renderAll();
      if (state.current != null) scrollToRow(state.current);
      setStatus('Connected. Press the reload button (↻) to refresh.');
    } else {
      setStatus('Connected. Press the reload button (↻) to receive the 200 programs.');
    }
  }

  async function receiveAll() {
    if (state.busy) return;
    if (!link.identified) { await handshake(); if (!link.identified) return; }
    state.busy = true; renderButtons();
    try {
      setStatus('Receiving favorites…');
      const g = await request(R.msg.globalDumpRequest(link.channel), (x) => x.type === 'global');
      const programs = [];
      for (let i = 0; i < R.NUM_PROGRAMS; i++) {
        const m = await request(R.msg.programDumpRequest(link.channel, i), (x) => x.type === 'program' && x.number === i);
        programs.push(m.data);
        if (i % 10 === 9) setStatus(`Receiving programs… ${i + 1}/200`);
      }
      state.programs = programs;
      state.decoded = programs.map(R.decodeProgram);
      setGlobal(g.data);
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
      const m = await request(R.msg.currentProgramDumpRequest(link.channel), (x) => x.type === 'current-program', { retries: 0 });
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
  // Clicking a program (list or favorite) leaves the GLOBAL page; program changes from the keytar don't.
  $('list').onclick = (e) => { const i = clicked(e); if (i != null) { state.page = 'program'; selectOnKeytar(i); } };
  $('fav-table').onclick = (e) => { const i = clicked(e); if (i != null) { state.page = 'program'; selectOnKeytar(i, { scroll: true }); } };
  $('btn-global').onclick = () => { state.page = state.page === 'global' ? 'program' : 'global'; renderDetails(); };
  $('details').onclick = (e) => {
    if (e.target.id === 'btn-save') { saveProgram(); return; }
    if (e.target.id === 'btn-save-global') { saveGlobal(); return; }
    if (e.target.closest('#btn-close-global')) { state.page = 'program'; renderDetails(); return; }
    const i = state.viewed;
    if (i == null || !state.decoded[i]) return;
    const p = progEdits.view(i, state.decoded[i]);
    const step = e.target.closest('[data-step]');
    if (step) { const key = `arpStep${step.dataset.step}`; setField(i, key, p[key] ? 0 : 1); return; }
    const shift = e.target.closest('[data-shift]');
    // Rotate the steps up to the last step; only the steps that change are sent.
    if (shift) E.rotateSteps(p, +shift.dataset.shift).forEach(([k, v]) => setField(i, k, v));
  };
  $('details').onchange = (e) => {
    if (e.target.id === 'in-port') { link.choose('input', e.target.value); return; }
    if (e.target.id === 'out-port') { link.choose('output', e.target.value); return; }
    const gkey = e.target.dataset.gfield;
    if (gkey && GLOBAL_FIELDS[gkey].input) {
      // Text field: only a valid value becomes an edit; leaving it with an invalid one puts the last valid value back.
      const v = GLOBAL_FIELDS[gkey].parse(e.target.value);
      if (v != null) setGlobalField(gkey, v); else renderDetails();
      return;
    }
    if (gkey) { setGlobalField(gkey, +e.target.value); return; }
    const key = e.target.dataset.field;
    if (key) setField(state.viewed, key, e.target.type === 'checkbox' ? +e.target.checked : +e.target.value);
  };
  // Live check while typing in a text field (red border = not accepted; reverted when leaving the field).
  $('details').oninput = (e) => {
    const f = GLOBAL_FIELDS[e.target.dataset.gfield];
    if (f && f.input) e.target.classList.toggle('invalid', f.parse(e.target.value) == null);
  };
  // Tapping into a text field selects its value, so typing replaces it (the field is full at 5 characters).
  $('details').addEventListener('focusin', (e) => { if (e.target.matches('input[data-gfield]')) setTimeout(() => e.target.select(), 0); });
  $('details').onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('input[data-gfield]')) e.target.blur(); };
  $('list').onkeydown = (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 20, PageUp: -20 }[e.key];
    if (!step || !state.decoded.length) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(state.decoded.length - 1, (state.viewed ?? -1) + step));
    view(i); scrollToRow(i);
  };

  // ------------------------------------------------------------ boot
  // No zooming on the iPad: Safari ignores user-scalable=no for pinches, so its gesture events are cancelled, and so is
  // any move with two fingers down (double-tap zoom is off through touch-action in style.css).
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  restore();
  renderAll();
  link.init().then(() => link.autoConnect());
})();
