# KORG RK-100S Programs

A Web MIDI page for the KORG RK-100S keytar. It lists the keytar's 200 programs and favorites, selects programs, and edits the program's arpeggiator, scale and ribbon settings, along with the global settings. It has no libraries and needs no network access.

## Features

- **Programs and favorites:** receive all programs and the favorites from the keytar. They're saved in the browser and shown on the next visit.
- **Select:** tap a program to select it on the keytar.
- **Edit:** the arpeggiator, scale, scale key and Long Ribbon settings are dropdowns. A change is sent at once and shows a yellow border. **SAVE** stores the program on the keytar, then reads it back to check it.
- **GLOBAL** (globe button): the MIDI ports, transpose, velocity curve, master tune, user scale and CC# map, with their own **SAVE**.

## Running it

The page needs a browser with Web MIDI and SysEx. Allow both when the browser asks. Without SysEx it can still select programs, but it can't load them.

### On a computer (Chrome)

1. Connect the RK-100S with a USB cable.
2. Start a web server in this folder and open http://localhost:8000 in Chrome:
```
python3 -m http.server 8000
```
3. Allow MIDI device control (with SysEx) when Chrome asks.

### On an iPad (MIDIWeb or Web MIDI Browser)

1. Install [MIDIWeb](https://midiweb.app/) (iPadOS 17 and later) or [Web MIDI Browser](https://apps.apple.com/us/app/web-midi-browser/id953846217), which also runs on older iPads.
2. Connect the RK-100S with a USB cable and a Lightning or USB-C adapter.
3. Put the page somewhere the iPad can reach, either:
   - on a web host (for example GitHub Pages), or
   - from a computer on the same Wi-Fi
4. Open that address in the app.

## Ports

By default the page uses the keytar's own ports: In `RK-100S KBD/RIBBON` and Out `RK-100S SOUND`. When those aren't found, it uses the first In and Out. To pick other ports, use the **IN** and **OUT** menus at the top of the **GLOBAL** page. Your choice is remembered, and **auto** goes back to the default.
