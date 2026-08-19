# Warhammer 40k (11th edition) database layer

Reference data for the 40k builder, imported from Wahapedia's 11th-edition CSV
export (`https://wahapedia.ru/wh40k11ed/<Name>.csv`) into the same Azure
Postgres the BattleTech builder uses. All tables are prefixed `wh40k_` and the
importer drops/recreates only those tables — the `mul_*` and other tables are
never touched.

## Re-running the import

The importer needs `MUL_DATABASE_URL` in the environment. Fetch it from the
web app's settings for the run — never write the value into a file:

```bash
MUL_DATABASE_URL="$(az webapp config appsettings list -g tcg-business-rg \
  -n raisinghavok --query "[?name=='MUL_DATABASE_URL'].value" -o tsv)" \
node scripts/wh40k-import.mjs
```

It downloads the CSVs sequentially (politely), parses the pipe-delimited
format (UTF-8 BOM, trailing pipe, embedded newlines in a few description
fields), and imports everything inside one transaction. Idempotent: re-running
replaces the `wh40k_*` tables wholesale. Description fields keep Wahapedia's
HTML verbatim; the UI sanitizes/renders it.

## Tables

One table per CSV, all-text columns, ids as text (Wahapedia ids are
zero-padded strings like `000000882`): `wh40k_factions`, `wh40k_source`,
`wh40k_datasheets`, `wh40k_datasheets_abilities`, `wh40k_datasheets_keywords`,
`wh40k_datasheets_models`, `wh40k_datasheets_options`,
`wh40k_datasheets_wargear`, `wh40k_datasheets_unit_composition`,
`wh40k_datasheets_models_cost`, `wh40k_datasheets_stratagems`,
`wh40k_datasheets_enhancements`, `wh40k_datasheets_detachment_abilities`,
`wh40k_datasheets_leader`, `wh40k_detachments`, `wh40k_stratagems`,
`wh40k_abilities`, `wh40k_enhancements`, `wh40k_detachment_abilities`,
`wh40k_last_update`, plus `wh40k_meta` (key/value import metadata, like
`mul_meta`).

## Server module

`server/wh40k.js` mirrors `server/builders.js` (lazy pool, `available()`
guard, read-only). Exports `getFactions()`, `searchDatasheets({q, faction,
limit})`, `getDatasheet(id)` (full assembled play card: models, weapon
profiles, abilities, keywords, costs, options, leader links), `resolveList(text)`
(matches a pasted GW app / New Recruit / BattleScribe list against datasheet
names — exact, then normalized, then fuzzy, with confidence and honest
unmatched reporting), and `mount(app, { memberReader })` which registers:

- `GET  /api/builders/wh40k/meta`
- `GET  /api/builders/wh40k/datasheets?q=&faction=&limit=`
- `GET  /api/builders/wh40k/datasheets/:id`
- `POST /api/builders/wh40k/resolve-list` (`{ text }`)

Every route is gated by the `memberReader` middleware passed in from
`server/index.js`, same as the battletech routes. To wire it up:

```js
const wh40k = require('./wh40k');
wh40k.mount(app, { memberReader });
```
