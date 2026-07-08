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
- **Optional `June Ready` / `June Done` occupancy sensors** — trigger Home app notifications when the oven finishes preheating or finishes cooking.
- **In-plugin pairing** — pair from the Config UI with an 8-digit code, the same flow the June app uses. No account credentials are ever entered into or stored by the plugin.
- **Automatic token refresh** and a persistent, signed WebSocket connection to June's messaging service for live status and commands.
- **Multi-oven support.**

## Requirements

- Homebridge `>=1.8.0`
- Node.js `18.20.4+`, `20.15.1+`, or `22+`
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

1. Open the plugin's settings in the Homebridge Config UI.
2. Click **Pair a new June oven**.
3. On the oven's touchscreen, go to **Settings → Connect** and enter the 8-digit code shown in the Config UI.
4. Wait for the Config UI to report **Paired**.
5. Restart Homebridge so the newly saved accessory loads.

The pairing identity (companion device password, access token, refresh token, Ed25519 seed) is stored in your Homebridge `config.json` under `ovens[]`. Treat that file as a secret — anyone with it can control your oven and read its status.

## Configuration

The Config UI is the primary way to add and pair ovens; you shouldn't need to hand-edit `config.json`. For reference, a paired platform block looks like:

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

## Siri and HomeKit

Works well:

- "Set June to 375."
- "Turn June off."
- "What's the temperature of June?"
- "Turn on June Preheat."
- A user-created Home scene named "Preheat June."
- Home app notifications from `June Ready` and `June Done`.

HomeKit doesn't expose an oven-timer characteristic Siri can drive, so this plugin doesn't fake voice timers, timer extension, or spoken time remaining.

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
