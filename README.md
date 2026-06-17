# node-red-contrib-tesla-fleet-api

Read any of your Tesla's **read-only metrics** (battery level, range, climate, drive state,
and more) into Node-RED via the official **Tesla Fleet API** — with your own developer app,
**no paid third-party service**, and it **never wakes the car**.

- `tesla-fleet-config` — holds your credentials, manages the OAuth token lifecycle, runs a
  **shared refresh poll** (default every 15 min), and caches the latest vehicle snapshot.
  Settings: **Refresh interval**, **Units** (As reported / Metric / Imperial), and an
  onboarding **Include location** checkbox (adds the `vehicle_location` scope for
  latitude/longitude/heading and navigation-destination metrics).
- `tesla-fleet-single-metric` *(palette: **Tesla single metric**)* — pick **one** metric from ~166
  read-only values; choose the payload format (`naked` = value only, `named` = `{ key: value }`,
  `value` = `{ "value": … }`); emit on every refresh or only on change. Optional per-node
  Units override.
- `tesla-fleet-multiple-metrics` *(palette: **Tesla multiple metrics**)* — tick any number of metrics
  in a grouped picker → emits one JSON object `{ key: value, … }` on `msg.payload`.

All metric nodes share the config's **single poll** — adding more nodes does not cause
extra Tesla API calls. Sending a message to a metric node's **input** triggers a fresh
live read on demand (still never wakes the car).

**Multiple vehicles.** One config = one Tesla account (you do the key/onboarding **once**).
Each metric node has a **Vehicle** picker; on a single-car account it auto-selects your only
car, so you set nothing. The config only polls the cars that at least one node actually reads —
two cars read = two `vehicle_data` calls per interval, a car nobody reads costs nothing.

📖 **Full setup guide:** <https://teslametrics.github.io/node-red-contrib-tesla-fleet-api/>

## Why it's safe and cheap

- **Read-only.** No commands, no `client_secret` used at runtime (the refresh grant
  needs only `client_id` + `refresh_token`).
- **Never wakes the car.** It checks the free `/vehicles` state first and only calls the
  (billed) `vehicle_data` endpoint when the car is already online. Otherwise it emits the
  last-known value with `msg.stale = true`. The last snapshot is also persisted to disk
  so it survives a Node-RED restart.
- Tesla gives each account ~$10/month of free Fleet API credit; a 15-minute poll stays
  well within it.

## What you need

1. A **Tesla developer app** at [developer.tesla.com](https://developer.tesla.com)
   (grant type *Authorization Code and Machine-to-Machine*) → `client_id` + `client_secret`.
2. A place to **host your public key**. Tesla requires partner registration with an EC
   public key hosted at `https://<your-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`.
   The easiest free option without running anything is **[fleetkey.cc](https://fleetkey.cc)**:
   generate a key pair, upload the **public** key, and it gives you a domain like
   `xxxxx.fleetkey.net`. (Advanced: host it yourself on a Cloudflare Worker / GitHub Pages user-site.)
3. A **redirect page** to catch the OAuth code. This repo ships one (`docs/callback.html`);
   the node's default Redirect URI is its hosted copy at
   `https://teslametrics.github.io/node-red-contrib-tesla-fleet-api/callback.html`. Register
   that URL in your Tesla app.

### The key pair

The config node generates the EC key pair for you (the **Generate key pair** button) — no
terminal needed. If you prefer the command line:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private-key.pem
openssl ec -in private-key.pem -pubout -out public-key.pem   # upload this to fleetkey
```

The private key is **never used for read-only** — keep it as a backup, don't host it.

## Install

```bash
cd ~/.node-red
npm install node-red-contrib-tesla-fleet-api
```

…or install from the Node-RED palette manager.

## Onboarding (in the editor)

1. Drag in a **Tesla single metric** node and add a new **Tesla Fleet** config.
2. Fill in **Region**, **Client ID / Secret**, **Key Domain** (your `fleetkey.net` domain)
   and **Redirect URI** (your callback page). Tick **Include location** if you want
   latitude/longitude/heading and navigation-destination metrics.
3. Click **1. Generate login link** → open it → log in to Tesla & approve → you land on
   your callback page → **copy the code**.
4. Paste it into **Code** and click **2. Finish onboarding** (this does the one-time
   partner registration and exchanges the code for a refresh token).
5. Click **Add/Update**, then **Deploy**.

> Already have a refresh token from the CLI (`onboard.mjs`)? Just paste it into the
> **Refresh Token** field and skip the buttons.

## Output

### Tesla single metric node (`tesla-fleet-single-metric`)

Selectable payload format:

| Format | `msg.payload` example |
| --- | --- |
| `naked` | `48` (value only — the default) |
| `named` | `{ "battery_level": 48 }` |
| `value` | `{ "value": 48 }` |

Additional message properties set on every emit:

| property | value |
| --- | --- |
| `msg.metric` | metric key, e.g. `"battery_level"` |
| `msg.unit` | unit string after conversion, e.g. `"%"` |
| `msg.stale` | `true` when the car isn't online (value is last-known) |
| `msg.last_updated` | epoch ms of the last fresh read |

Default metric is `battery_level`, default format `naked`.

### Tesla multiple metrics node (`tesla-fleet-multiple-metrics`)

| property | value |
| --- | --- |
| `msg.payload` | one JSON object of all selected metrics, e.g. `{ battery_level: 48, outside_temp: 18.5, … }` |
| `msg.stale` | `true` when the car isn't online (value is last-known) |
| `msg.last_updated` | epoch ms of the last fresh read |

### Stale / offline behaviour

When the car is asleep or offline, no API call is made (the car is **never woken**). Both
node types emit the last-known snapshot with `msg.stale = true`. The snapshot is persisted
across Node-RED restarts.

## Notes

- **Token persistence.** Refresh tokens rotate on every use. Since a Node-RED node can't
  rewrite its own credentials at runtime, the rotated token is written to an atomic
  `0600` file under `<userDir>/node-red-contrib-tesla-fleet-api/`. It is stored in plain
  text (mitigated by file permissions; the token is short-lived). Re-onboarding (changing
  the credential) automatically supersedes the persisted token.
- **Errors.** `408` = car asleep (never woken). `412` = partner registration / public key
  not in place. `421` = wrong region. `429` = rate limited (back off).
- **CLI alternative.** `onboard.mjs` performs the same onboarding from a terminal and
  prints a refresh token — handy for testing or headless setups.

## License

MIT

## Disclaimer

This is **not an official Tesla tool** — it's a community-built project, **not affiliated with,
endorsed by, or sponsored by Tesla, Inc.** It talks to Tesla's official Fleet API using your own
developer credentials. *Tesla* and related names and logos are trademarks of Tesla, Inc., used
here only to identify the API this package works with.
