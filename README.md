<p align="center">
  <img src="branding/icon.png" width="110" alt="June">
</p>

# homebridge-june-oven

[![npm](https://img.shields.io/npm/v/homebridge-june-oven?label=npm)](https://www.npmjs.com/package/homebridge-june-oven)
[![npm beta](https://img.shields.io/npm/v/homebridge-june-oven/beta?label=beta)](https://www.npmjs.com/package/homebridge-june-oven?activeTab=versions)
[![CI](https://github.com/keithah/homebridge-june-oven/actions/workflows/ci.yml/badge.svg)](https://github.com/keithah/homebridge-june-oven/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/homebridge-june-oven)](LICENSE)

A [Homebridge](https://homebridge.io) plugin that brings [June](https://juneoven.com) ovens into Apple HomeKit. Pair an oven directly from the Homebridge Config UI — no June account login, no extracted credentials — and control it from the Home app or with Siri.

> This is an independent, community-built plugin. It is not affiliated with or endorsed by June Life, Inc. It talks to June's cloud API using the same protocol the official June app uses.

## Features

- **Thermostat accessory** (`June` by default) — set a target temperature, read the current cavity temperature, turn off to cancel a cook.
- **Optional preheat switch** (`June Preheat`) — turning it on preheats to your configured default mode/temperature; turning it off cancels.
- **Optional `June Ready` / `June Done` occupancy sensors** — see [Ready and Done sensors](#ready-and-done-sensors) below for what they do and how to hook up notifications.
- **Optional cook doorbell** — a HomeKit Doorbell that rings on the events you choose (cook done and/or preheat-ready), giving you a doorbell-style notification on your phone and Apple TV. Off by default; enable and pick triggers in the Config UI.
- **Optional food-probe temperature sensors** — exposes the oven's meat-probe temperature(s) as HomeKit Temperature Sensors so you can automate on "probe reached 145°F." Off by default.
- **Optional cook-mode switches** — add a switch for any cook mode you like (bake, roast, broil, air fry, toast, or any other mode id the oven accepts), each with its own temperature. Turning one on starts that cook; they're mutually exclusive. None are added unless you configure them.
- **In-plugin pairing** — pair from the Config UI with an 8-digit code, the same flow the June app uses. No account credentials are ever entered into or stored by the plugin.
- **Editable per-oven settings in the Config UI** — rename accessories, toggle sensors, set default cook mode/temperature (in whichever unit you prefer), and check an oven's live connection status, all without hand-editing `config.json`.
- **Automatic token refresh** and a persistent, signed WebSocket connection to June's messaging service for live status and commands.
- **Multi-oven support.**

## Not exposed (and why)

- **Cook timer** — the oven accepts a set-timer command, but HomeKit has no timer/countdown surface for a thermostat-style accessory, so there's nowhere sensible to put it. Use a Home automation on the Done doorbell/sensor instead.
- **Cook progress %** — HomeKit has no native "percent complete" characteristic, so progress is used internally only (to drive the Ready/Done triggers) rather than shown as its own tile.
- **Interior camera / live video** — the oven has an interior camera, but wiring its snapshot into a HomeKit camera (and a Video Doorbell that shows a photo of your food when it's done) needs one more protocol capture to confirm how the current image URL is delivered. It's planned; the doorbell above is already built to gain the snapshot once that lands. See `docs/superpowers/specs/2026-07-08-june-expanded-homekit-features-design.md`.

## Requirements

- Homebridge `>=1.8.0`
- Node.js `18.20.4+`, `20.19.0+`, `22.12.0+`, or `24+`
- A June oven on the same June account you'll pair with

## Install

Search for **June Oven** in the Homebridge Config UI plugin screen, or install from the command line:

```bash
npm install -g homebridge-june-oven
```

### Release tracks

This plugin publishes two npm dist-tags:

| Tag | Install command | Use for |
| --- | --- | --- |
| `latest` (stable) | `npm install -g homebridge-june-oven` | Everyday use |
| `beta` | `npm install -g homebridge-june-oven@beta` | Trying upcoming fixes/features before they're promoted to stable |

The Homebridge Config UI plugin screen also shows beta releases if you enable "Show Beta Versions" in your Homebridge UI settings.

## Pair an oven

This plugin pairs directly with the oven — you don't need the June phone app.

1. Open the plugin's settings in the Homebridge Config UI.
2. On the oven's touchscreen, swipe left twice from the home screen and select **Connect**. If the oven already shows a list of connected devices instead of a code, tap **+** to add a new device.
3. Click **Pair a new June oven** in the Config UI — it displays an 8-digit code.
4. Type that code into the oven's screen.
5. Wait for the Config UI to report **Paired**, then restart Homebridge so the newly saved accessory loads.

If the oven's screen doesn't match these steps, June's own walkthrough for the same flow may help: [June app pairing guide](https://consumer-care.weber.com/s/article/Pairing-the-June-App-with-Your-Oven-1724960264554?language=en_US).

The pairing identity (companion device password, access token, refresh token, Ed25519 seed) is stored in your Homebridge `config.json` under `ovens[]`. Treat that file as a secret — anyone with it can control your oven and read its status.

Removing an oven from the Config UI only deletes it from Homebridge's config — it does **not** revoke the companion authorization on June's servers (there's no documented API for that). To fully disconnect a companion, also remove it from the oven's own connected-devices screen.

## Configuration

The Config UI is the primary way to add, pair, and edit ovens; you shouldn't need to hand-edit `config.json`. Each paired oven's card in the Config UI lets you change its name, preheat switch name, ready/done sensors, default cook mode, default preheat temperature (shown in whichever unit you pick), and temperature display units, and includes a **Check status** button that queries June's cloud for the oven's current connection/cook state. For reference, a paired platform block looks like:

```json
{
  "platform": "JuneOven",
  "name": "June",
  "ovens": [
    {
      "name": "June",
      "preheatSwitchName": "June Preheat",
      "readySensor": true,
      "doneSensor": true,
      "defaultMode": "bake",
      "defaultTempF": 350,
      "tempUnit": "F"
    }
  ]
}
```

Leave `preheatSwitchName` blank to disable the preheat switch.

## Ready and Done sensors

HomeKit has no "device finished a task" event, so `June Ready` and `June Done` are implemented as **Occupancy Sensors** — a repurposing common in the Homebridge ecosystem to get free, native Home app notifications out of a characteristic HomeKit already understands.

- **`June Ready`** trips ("Occupancy Detected") once the oven finishes preheating — current cavity temperature is within 1°F of target. It resets automatically after 30 seconds, or immediately if you start another preheat.
- **`June Done`** trips when an active cook stops on its own (not because you cancelled it) — i.e. the oven finished its cook cycle. It also auto-resets 30 seconds later.

To get a notification, open the sensor's tile in the Home app and turn on notifications, or build a Home app Automation triggered by "Occupancy Detected" on that sensor. Since both reset themselves, there's nothing to clear after the fact — set up the notification/automation once.

## Siri and HomeKit

Works well:

- "Set June to 375."
- "Turn June off."
- "What's the temperature of June?"
- "Turn on June Preheat."
- A user-created Home scene named "Preheat June."
- Home app notifications from `June Ready` and `June Done`.

HomeKit doesn't expose an oven-timer characteristic Siri can drive, so this plugin doesn't fake voice timers, timer extension, or spoken time remaining.

June's oven doesn't support changing the target temperature of a cook that's already running — confirmed by testing against a real oven, both a direct "change temp" command and simply re-issuing preheat while active are rejected or silently ignored. So "Set June to 375" while it's already heating cancels the current cook and starts a new one at 375° (a brief, sub-second interruption) rather than smoothly retargeting.

## Troubleshooting

- **Pairing hangs or fails** — make sure the oven and the Homebridge host both have working internet access; pairing goes through June's cloud, not local network. Double-check the 8-digit code before it expires and try again.
- **Accessory doesn't show up after pairing** — you need to restart Homebridge once after a successful pair for the new accessory to register.
- **Temperature looks off** — check `tempUnit` for that oven matches what you expect (`F` or `C`); the oven itself always reports in Celsius internally.

If you hit something else, please [open an issue](https://github.com/keithah/homebridge-june-oven/issues) with your Homebridge and plugin versions and the relevant log lines (redact tokens/seeds first).

## Verification

Automated tests cover protocol serialization, temperature conversion, PIN check digits, and SRP helper behavior. Full pairing and cooking control can only be verified against a physical June oven, since the cloud pairing flow and command acknowledgements are live-device operations.

## Reference materials

The reverse-engineered protocol notes and verified Python reference flows this plugin is built from are checked into [`docs/reference/`](docs/reference/):

- [`JUNE_HOMEBRIDGE_SPEC.md`](docs/reference/JUNE_HOMEBRIDGE_SPEC.md) — plugin build spec
- [`JUNE_INTEGRATION_SPEC.md`](docs/reference/JUNE_INTEGRATION_SPEC.md) — wire protocol (endpoints, signing, message codes, pairing)
- [`june_pair.py`](docs/reference/june_pair.py) / [`june_oven.py`](docs/reference/june_oven.py) — reference Python implementations

## Contributing

Issues and PRs are welcome. To work on the plugin locally:

```bash
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
