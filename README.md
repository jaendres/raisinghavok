# Raising Havok — raisinghavok.com

Club website + **Mad Ork Lands**, a multiplayer orky vehicular battle royale
(a Raising Havok production, loosely inspired by Gaslands-style rules).

## What's here

- `public/index.html` — the club site (served at `/`)
- `public/play/` — Mad Ork Lands client (served at `/play`)
- `server/` — Node server: static hosting, accounts, garage, socket.io multiplayer
  - `parts.js` — the build catalog: hulls, weapons, upgrades, teef budget, slot limits
  - `game.js` — server-authoritative match simulation (30Hz)
  - `db.js` — JSON-file storage (`data/db.json`) for accounts, stats, saved rigs

## Run it

```
npm install
npm start
```

Site at http://localhost:3040 — game at http://localhost:3040/play
(`PORT` env var overrides the port.)

## Game overview

- **Accounts**: register/login (scrypt-hashed passwords) or play as guest.
  Logged-in players get persistent stats (games/wins/kills/deaths/damage) and
  saved garage builds; leaderboard at `/api/leaderboard`.
- **Da Mek Shop**: 50 teef budget, slots per hull. 7 hulls (Warbike → War Rig),
  12 weapons (shootas, rokkits, killkannon, skorcha, harpoon, mines, oil,
  smoke, wreckin' ball...), 7 upgrades (armour, boosta, grot riggers, red paint...).
  Server re-validates every build, so no cheatin'.
- **Match**: 6 rigs (humans + bot fill), shrinking Scrap Storm, last rig rollin' wins.
- **Controls**: W/S drive, A/D steer, SPACE fire, SHIFT drop rear weapons, E boost.

## Deploying (Azure, all as code)

Everything deploys automatically on push to `main` via GitHub Actions
(`.github/workflows/deploy.yml`):

1. **Infra** — `infra/main.bicep` creates/updates the web app `raisinghavok`
   on the existing shared plan `tcg-business-plan` (B1 Linux, `tcg-business-rg`)
   — no added hosting cost. WebSockets + Always On enabled, `DATA_DIR=/home/data`
   so the JSON database survives deployments.
2. **App** — zip deploy (deps prebuilt in CI, no server-side build).
3. **Smoke test** — curls `/api/parts` and fails the run if the site is down.

One-time pieces (already run, kept in repo for reference/re-runs):

- `scripts/setup-azure-oidc.ps1` — GitHub→Azure OIDC federation (no stored
  credentials), Contributor on the resource group, GH secrets.
- `scripts/bind-domain.ps1` — run **after** DNS points at the app; binds
  raisinghavok.com and issues the free App Service managed certificate.

### DNS (GoDaddy) for raisinghavok.com

| Type  | Name    | Value                                    |
|-------|---------|------------------------------------------|
| A     | `@`     | the app's inbound IP (see workflow output or `az webapp show -g tcg-business-rg -n raisinghavok --query inboundIpAddress`) |
| TXT   | `asuid` | the app's custom domain verification ID  |
| CNAME | `www`   | `raisinghavok.azurewebsites.net` (optional) |

Note: `/home/data/db.json` on the app is the entire database — download a copy
now and then (Kudu: `https://raisinghavok.scm.azurewebsites.net`).

## Auth anti-spam

Signups/logins are protected by per-IP rate limits (5 signups/hour,
10 login tries/10 min), a honeypot field, expiring session tokens (30 days,
revoked on logout), and scrypt-hashed passwords (min 8 chars).

**reCAPTCHA (optional, off by default):** create a reCAPTCHA v2 checkbox key
pair at https://www.google.com/recaptcha/admin (domain: raisinghavok.com),
then:

```
az webapp config appsettings set -g tcg-business-rg -n raisinghavok \
  --settings RECAPTCHA_SITE_KEY=<site key> RECAPTCHA_SECRET=<secret>
```

The signup form detects the key via `/api/config` and shows the checkbox
automatically; without keys everything works captcha-free.

## Balancing

All game balance lives in `server/parts.js` (costs, damage, ranges, speeds)
and the constants at the top of `server/game.js` (match size, arena size,
storm timing). Tweak and restart.
