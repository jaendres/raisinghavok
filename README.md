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

**reCAPTCHA v3 (invisible, score-based):** no checkbox — signups are scored
silently and the server rejects below 0.3 (`MIN_SCORE` in server/security.js).
Keys live as GitHub Actions secrets and flow through the Bicep deploy — do NOT
set them in the portal, the pipeline owns app settings and wipes manual
changes on every deploy. To rotate/change keys
(https://www.google.com/recaptcha/admin, **v3**, domain raisinghavok.com):

```
gh secret set RECAPTCHA_SITE_KEY --repo jaendres/raisinghavok --body <site key>
gh secret set RECAPTCHA_SECRET  --repo jaendres/raisinghavok --body <secret>
```

then re-run the deploy workflow. The signup form detects the key via
`/api/config` and shows the checkbox automatically; with empty secrets
everything works captcha-free.

## Discord SSO

"Log in wiv Discord" appears on the login screen once configured. Uses the
same Discord application as the Blood Bowl bot:

1. https://discord.com/developers/applications → your app → **OAuth2**
2. Add redirect URLs (must match exactly):
   - `https://raisinghavok.com/api/auth/discord/callback`
   - `http://localhost:3040/api/auth/discord/callback` (local dev)
3. Copy the Client ID and Client Secret into GitHub secrets:

```
gh secret set DISCORD_CLIENT_ID     --repo jaendres/raisinghavok --body <client id>
gh secret set DISCORD_CLIENT_SECRET --repo jaendres/raisinghavok --body <client secret>
```

then re-run the deploy workflow. Discord accounts are matched by Discord user
id (never auto-linked to a password account by name); first login creates a
site account named after the Discord display name.

## Balancing

All game balance lives in `server/parts.js` (costs, damage, ranges, speeds)
and the constants at the top of `server/game.js` (match size, arena size,
storm timing). Tweak and restart.

## Builders (`/builders`)

List builders for the games the club plays, members-only like the league.
First one is **BattleTech — Alpha Strike**.

The unit data is our own archive of [masterunitlist.info](http://masterunitlist.info),
harvested in August 2026 before that site shut down (the harvester and the raw
capture live in `../mul-archive`). It is a **private club copy** — BattleTech
unit data is community-compiled around Catalyst Game Labs' published material,
so it stays behind the login and off the public web.

### Where the data lives

Azure Database for PostgreSQL Flexible Server, Burstable **B1ms**, 32 GB, in
the same region as the app service plan. It is not in this repo: ~8,700 units
and ~200k faction/era availability rows, filtered on several dimensions at once,
is what a database is for. `pg` is pure JavaScript, so the Node 20 host needs no
native build step.

The connection string reaches the app as the `MUL_DATABASE_URL` app setting,
via the `mulDatabaseUrl` bicep parameter from the `MUL_DATABASE_URL` GitHub
secret. **`infra/main.bicep` owns the app-settings list** — setting it by hand
in the portal gets wiped on the next deploy.

If `MUL_DATABASE_URL` is empty the Builders API returns 503 and the rest of the
site carries on as normal; nothing else depends on it.

### Standing it up

```bash
# 1. create the server (once)
az postgres flexible-server create \
  --resource-group tcg-business-rg --name raisinghavok-pg --location centralus \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
  --admin-user rhadmin --admin-password "$(cat ~/.raisinghavok-pg-password.txt)" \
  --public-access <your ip> --yes

# 2. let the app service reach it
az postgres flexible-server firewall-rule create \
  --resource-group tcg-business-rg --name raisinghavok-pg \
  --rule-name allow-azure --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0

# 3. load the archive (from ../mul-archive)
export MUL_DATABASE_URL='postgresql://rhadmin:<password>@raisinghavok-pg.postgres.database.azure.com/postgres?sslmode=require'
node build/import-postgres.mjs

# 4. hand the connection string to CI, then deploy
gh secret set MUL_DATABASE_URL --repo jaendres/raisinghavok --body "$MUL_DATABASE_URL"
```

Re-running the import is safe — it replaces the tables inside one transaction,
so the site never sees a half-loaded dataset.

### Developing without Azure

`../mul-archive/test/serve-site-pglite.cjs` runs **this exact server** against
an in-process Postgres (PGlite), loading the archive from local JSON. No Azure,
no Docker, no local Postgres install:

```bash
cd ../mul-archive && node test/serve-site-pglite.cjs
```

It prints a login token to drop into `localStorage.mol_token`. There is also a
test suite covering the real import and the real queries:

```bash
cd ../mul-archive && node test/builders.pglite.test.cjs
```

### Saved forces

Stored on the user record in `db.json` as ids plus pilot skill only — unit stats
are looked up at load time, so re-importing the archive refreshes every saved
force at once instead of leaving stale copies behind.
