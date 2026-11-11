# RK-100S Programs (simple viewer)

A stripped-down version of `../rk100s-web`. It sends a Program Change when you click a program, a Parameter Change when you change a dropdown, and a program write when you press **Save**.

```sh
python3 serve.py          # opens http://localhost:8766 in Google Chrome
```

- No port menus or Connect button (it's meant to run inside an AUv3 host). It uses the keytar's ports by name if present (In `RK-100S KBD/RIBBON`, Out `RK-100S SOUND`), otherwise the first connected In and Out. It reconnects when devices change. Hover the channel pill to see which ports are in use.
- Handshake: Device Inquiry first. If that gets no answer (some hosts drop universal SysEx), it asks for the edit buffer on channel 1. Any RK-100S SysEx that arrives later also counts. With no SysEx at all the pill says **Send only**: Program Changes still go out, but programs can't be loaded.
- Connecting only asks for the keytar's identity (and, if programs are cached, its edit buffer to find the current program). Press **Load programs** (later **Reload**) to receive the favorites (global dump) and all 200 programs (about 2 s). They're cached in the browser and shown on the next visit.
- Follows Program Changes from the keytar. The current program is red in the list and in the favorites grid.
- Picks up global or program dumps the keytar sends on its own (favorites, programs).
- Clicking a program in the list selects it on the keytar (Bank MSB 0, Bank LSB 0/1, Program Change on the global channel) and shows its details on the right. The keytar only follows if Program Change is enabled in its global settings (ProgChg Filter).
- **SAVE** reads the keytar's edit buffer and writes it into the program's slot with PROGRAM DATA DUMP (`4C pp PP`). The keytar ACKs, then the page reads the slot back to confirm. For 129-200 it also checks that slot 1-72 wasn't hit by mistake and restores it if it was.
- Clicking a favorite or using the arrow keys only shows details. Nothing is sent.
- **Arpeggiator** is one dropdown: Off sends `60:01`=0. A type sends `61:00`=type, then `60:01`=1.
- **Scale** and **scale key** (`00:17`, `00:1E`) and the Long Ribbon **scale type**, **scale range** and **pitch range** (`70:00`, `70:01`, `70:02`) are dropdowns. Picking a value sends PARAMETER CHANGE (func 41h). Ranges are sent as plain −8…+8 octaves, not with the +64 offset the dump uses. This changes the keytar's edit buffer only, like turning a knob. Each changed field gets a yellow border and the yellow **SAVE** button next to the program name becomes active. Changes are lost on the next program change unless you save. If the program isn't selected on the keytar yet, it's selected first.
- On connect it asks for the edit buffer and matches it against the 200 programs, so it can mark the current program before you change one. This only works while the sound is unedited.

`rk100s.js` is copied from `../rk100s-web`, with `msg.parameterChange` and `PARAM` added.
