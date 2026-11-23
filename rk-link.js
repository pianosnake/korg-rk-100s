// RkLink: the connection to the RK-100S. Ports, sending, request/reply and finding the keytar; no page logic.
//   Ports: the ones picked in the IN / OUT menus (saved by id and name), otherwise the keytar's own ports by name
//   (In "RK-100S KBD/RIBBON", Out "RK-100S SOUND"), otherwise the first connected port.
//   request(bytes, match): sends, then waits for the first parsed SysEx that match() accepts (timeout, retries).
//   Requests run one at a time, queued, so a reply can only go to the request that asked for it.
//   Handlers given to the constructor (all optional):
//     conn(text, cls)      the connection pill; cls = 'on' | 'warn' | 'off'
//     status(text)         a status line message
//     change()             connected / identified / ports changed (redraw buttons and port menus)
//     connected()          ports opened; the page runs its handshake (identify() first). Awaited.
//     sysex(m)             parsed RK-100S SysEx that no request was waiting for (edits on the keytar, unasked dumps)
//     programChange(prog)  0~199, selected on the keytar (Bank LSB + Program Change)
// Loaded as a classic script (window.RkLink) or with require() in Node (tests). No class fields: iOS 15 WebKit.
(function () {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const R = isNode ? (require('./rk-sysex.js'), globalThis.RkSysEx) : window.RkSysEx;
  const PORTS_KEY = 'rk100s-ports';

  // The ports of a MIDIInputMap / MIDIOutputMap. Walked with next() by hand: the iOS "Web MIDI Browser" app's maps give
  // an iterator that isn't iterable, so Array.from(map.values()) comes back empty there (no ports found).
  function portsOf(map) {
    const out = [];
    if (!map) return out;
    const it = map.values();
    for (let o = it.next(); !o.done; o = it.next()) out.push(o.value);
    return out;
  }

  // Ports are kept apart by id: two can share a name (in the iOS Web MIDI Browser app every Bluetooth port is just
  // "Bluetooth"). A name shared by several ports is shown with a number, in port order ("Bluetooth 1", "Bluetooth 2").
  const live = (map) => portsOf(map).filter((p) => p.state !== 'disconnected');
  function labelOf(list, p) {
    const same = list.filter((q) => q.name === p.name);
    return same.length > 1 ? `${p.name} ${same.indexOf(p) + 1}` : p.name;
  }

  // A saved port choice: by id first; by name only when one port has it, as ids can change between sessions.
  function chosen(list, c) {
    if (!c) return null;
    const same = list.filter((p) => p.name === c.name);
    return list.find((p) => String(p.id) === String(c.id)) || (same.length === 1 ? same[0] : null);
  }

  function loadChoice() {
    try { return JSON.parse(localStorage.getItem(PORTS_KEY) || 'null') || {}; } catch (e) { return {}; }
  }

  class RkLink {
    constructor(on) {
      this.on = on || {};
      this.access = null; this.input = null; this.output = null;
      this.channel = 0;          // the keytar's global channel, 0~15
      this.version = null;       // firmware, e.g. "1.02" (from Device Inquiry)
      this.bank = 0;             // last Bank LSB from the keytar
      this.connected = false;    // ports open
      this.identified = false;   // the keytar answered: SysEx works both ways
      this.connecting = false;
      this.waiter = null;        // {match, resolve, timer} of the request in flight
      this.queue = Promise.resolve();
      this.choice = loadChoice(); // {input, output}: {id, name} or null = auto
      this.onMessage = this.onMessage.bind(this);
    }

    emit(name, ...args) { const f = this.on[name]; return f ? f(...args) : undefined; }
    get title() { return `In: ${this.input?.name} · Out: ${this.output?.name}`; }

    async init() {
      if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) { this.emit('status', 'No Web MIDI here.'); return false; }
      try {
        this.access = await navigator.requestMIDIAccess({ sysex: true });
      } catch (e) { this.emit('status', `MIDI access denied (${e.message}). Allow MIDI/SysEx and reload.`); return false; }
      this.access.onstatechange = () => {
        if (this.connected && (this.input.state === 'disconnected' || this.output.state === 'disconnected')) {
          this.disconnect(); this.emit('status', 'The MIDI device was disconnected.');
        }
        this.autoConnect(); // a device may have just appeared
      };
      return true;
    }

    // ------------------------------------------------------------ ports
    ports(kind) { return this.access ? live(kind === 'input' ? this.access.inputs : this.access.outputs) : []; }

    // What the IN / OUT menu shows. value is the choice, not the port in use: that one is null while a newly picked port
    // is still opening (and port changes re-render meanwhile), which made a pick read "auto" again.
    // missing: the name of a saved port that isn't connected now (it stays saved and is used again when it's back).
    menu(kind) {
      const list = this.ports(kind), c = this.choice[kind];
      const port = chosen(list, c);
      return {
        ports: list.map((p) => ({ id: String(p.id), label: labelOf(list, p) })),
        missing: c && !port ? c.name : null,
        value: c ? (port ? String(port.id) : 'saved') : '',
      };
    }

    // A pick in the IN / OUT menu: a port id, or '' for auto.
    choose(kind, id) {
      if (!this.access) return;
      const p = this.ports(kind).find((q) => String(q.id) === id);
      this.choice[kind] = p ? { id: p.id, name: p.name } : null;
      try { localStorage.setItem(PORTS_KEY, JSON.stringify(this.choice)); } catch (e) { /* private mode */ }
      this.autoConnect();
    }

    pick() {
      const pick = (list, c, prefer) => {
        const rk = list.filter((p) => /RK-?100S/i.test(p.name));
        return chosen(list, c) || rk.find((p) => prefer.test(p.name)) || rk[0] || list[0] || null;
      };
      return { input: pick(this.ports('input'), this.choice.input, /KBD|RIBBON/i),
        output: pick(this.ports('output'), this.choice.output, /SOUND/i) };
    }

    autoConnect() {
      if (!this.access) return;
      this.emit('change');
      if (this.connecting) return;
      const { input, output } = this.pick();
      if (this.connected) {
        // Switch over if better ports showed up (e.g. the keytar was plugged in after another device).
        // By id: some hosts hand out new port objects on each lookup.
        const same = (a, b) => a && b && String(a.id) === String(b.id);
        if (same(input, this.input) && same(output, this.output)) return;
        this.disconnect();
      }
      if (input && output) {
        this.connect(input, output)
          .catch((e) => { this.emit('conn', "Can't open port", 'warn'); this.emit('status', String(e.message || e)); })
          .finally(() => this.emit('change'));
      } else {
        this.emit('conn', 'No MIDI device', 'off');
        this.emit('status', `Waiting for a MIDI ${!input && !output ? 'device' : !input ? 'input' : 'output'}… (the ports are on the GLOBAL page)`);
      }
    }

    async connect(input, output) {
      this.connecting = true;
      try { await Promise.all([input.open(), output.open()]); } finally { this.connecting = false; }
      this.input = input; this.output = output;
      input.onmidimessage = this.onMessage;
      this.connected = true;
      this.emit('change');
      await this.emit('connected');
    }

    disconnect() {
      if (this.input) this.input.onmidimessage = null;
      this.input = this.output = null; this.connected = false; this.identified = false;
      this.emit('conn', 'Not connected', 'off');
      this.emit('change');
    }

    // ------------------------------------------------------------ finding the keytar
    // The keytar answered something on channel ch: it's there and SysEx works both ways.
    markIdentified(ch, version) {
      this.channel = ch;
      if (version) this.version = version;
      const was = this.identified;
      this.identified = true;
      if (!was || version) this.emit('conn', `${this.version ? `v${this.version} · ` : ''}ch ${ch + 1}`, 'on');
      if (!was) this.emit('change');
    }

    // Find the keytar's global channel. Device Inquiry first; if that gets no answer (some hosts drop universal
    // SysEx), ask for the edit buffer on channel 1, the default global channel. Resolves to identified.
    async identify() {
      this.emit('conn', 'Searching…', 'warn');
      try {
        const id = await this.request(R.msg.identityRequest(), (m) => m.type === 'identity', { timeout: 1000, retries: 1 });
        this.markIdentified(id.channel, id.version);
      } catch (e) {
        try {
          const m = await this.request(R.msg.currentProgramDumpRequest(0), (x) => x.type === 'current-program', { timeout: 1000, retries: 1 });
          this.markIdentified(m.channel);
        } catch (e2) {
          if (!this.identified) {
            this.emit('conn', 'Send only', 'warn');
            this.emit('status', `No SysEx from the keytar on "${this.input?.name}". Program changes are still sent; loading programs needs the keytar's MIDI (with SysEx) routed in. The IN and OUT ports are on the GLOBAL page.`);
          }
        }
      }
      return this.identified;
    }

    // ------------------------------------------------------------ messages
    send(bytes) { if (this.output) this.output.send(bytes); }

    request(bytes, match, opts) {
      const run = this.queue.then(() => this.ask(bytes, match, opts));
      this.queue = run.catch(() => {});
      return run;
    }

    ask(bytes, match, { timeout = 1500, retries = 2 } = {}) {
      return new Promise((resolve, reject) => {
        let attempt = 0;
        const tryOnce = () => {
          this.waiter = {
            match, resolve,
            timer: setTimeout(() => {
              this.waiter = null;
              if (attempt++ < retries) tryOnce(); else reject(new Error('No reply from the RK-100S'));
            }, timeout),
          };
          this.send(bytes);
        };
        tryOnce();
      });
    }

    onMessage(ev) {
      const d = ev.data;
      if (d[0] === 0xF0) {
        const m = R.parseSysex(d);
        if (!m) return;
        if (m.type !== 'identity-other' && m.channel != null && !this.identified) this.markIdentified(m.channel);
        if (this.waiter && this.waiter.match(m)) {
          const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.resolve(m);
          return;
        }
        this.emit('sysex', m);
        return;
      }
      // Program changes made on the keytar: Bank LSB (CC#32) then Program Change.
      const status = d[0] & 0xF0;
      if (status === 0xB0 && d[1] === 0x20) this.bank = d[2];
      if (status === 0xC0) {
        const prog = this.bank * 128 + d[1];
        if (prog < R.NUM_PROGRAMS) this.emit('programChange', prog);
      }
    }
  }

  if (isNode) module.exports = RkLink; else window.RkLink = RkLink;
})();
