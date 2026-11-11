# RK-100S Programs (simple viewer)

A stripped-down version of `../rk100s-web`. It never sends whole programs to the keytar. It only sends a Program Change when you click a program, and a Parameter Change when you change a Long Ribbon setting.

```sh
python3 serve.py          # opens http://localhost:8766 in Google Chrome
```

- No port menus or Connect button (it's meant to run inside an AUv3 host). It uses the keytar's ports by name if present (In `RK-100S KBD/RIBBON`, Out `RK-100S SOUND`), otherwise the first connected In and Out. It reconnects when devices change. Hover the channel pill to see which ports are in use.
- Handshake: Device Inquiry first. If that gets no answer (some hosts drop universal SysEx), it asks for the edit buffer on channel 1. Any RK-100S SysEx that arrives later also counts. With no SysEx at all the pill says **Send only**: Program Changes still go out, but programs can't be loaded.
- Connecting only asks for the keytar's identity (and, if programs are cached, its edit buffer to find the current program). Press **Load programs** (later **Reload**) to receive the favorites (global dump) and all 200 programs (about 2 s). They're cached in the browser and shown on the next visit.
- Follows Program Changes from the keytar. The current program is red in the list and in the favorites grid.
- Picks up global or program dumps the keytar sends on its own (favorites, programs).
- Clicking a program in the list selects it on the keytar (Bank MSB 0, Bank LSB 0/1, Program Change on the global channel) and shows its details on the right. The keytar only follows if Program Change is enabled in its global settings (ProgChg Filter).
- Clicking a favorite or using the arrow keys only shows details. Nothing is sent.
- **Long Ribbon scale**, **scale range** and **pitch range** are dropdowns. Picking a value sends PARAMETER CHANGE (func 41h) `70:00`, `70:01` or `70:02`. Ranges are sent as plain −8…+8 octaves, not with the +64 offset the dump uses. This changes the keytar's edit buffer only, like turning a knob. An "EDITED, NOT SAVED" pill appears under the program name and each changed field gets a yellow border. The change is lost on the next program change unless you write the program on the keytar. If the program isn't selected on the keytar yet, it's selected first.
- On connect it asks for the edit buffer and matches it against the 200 programs, so it can mark the current program before you change one. This only works while the sound is unedited.

`rk100s.js` is copied from `../rk100s-web`, with `msg.parameterChange` and `PARAM` added.
