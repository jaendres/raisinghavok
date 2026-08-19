// Import Wahapedia's Warhammer 40k 11th-edition CSV export into Azure Postgres.
//
// Source: https://wahapedia.ru/wh40k11ed/<Name>.csv — pipe-delimited, UTF-8
// with BOM, one trailing pipe per line, first row is headers. Description
// fields contain HTML (kept as-is; the UI sanitizes/renders it) and a few
// files (Abilities, Stratagems) contain embedded newlines inside fields, so
// records are re-assembled by pipe count rather than assumed one-per-line.
//
// Tables are mirrored 1:1 from the CSVs as wh40k_<file> with all-text columns
// (Wahapedia ids are zero-padded strings like '000000882'). Re-running DROPs
// and recreates only wh40k_* tables — nothing else is ever touched.
//
// Usage (never write the connection string into a file):
//   MUL_DATABASE_URL="$(az webapp config appsettings list -g tcg-business-rg \
//     -n raisinghavok --query "[?name=='MUL_DATABASE_URL'].value" -o tsv)" \
//   node scripts/wh40k-import.mjs

import pg from 'pg';

const BASE = 'https://wahapedia.ru/wh40k11ed/';

// The well-known file set (10th-ed scheme, verified against the 11th-ed
// export). Files that 404 are skipped gracefully.
const FILES = [
  'Factions',
  'Source',
  'Datasheets',
  'Datasheets_abilities',
  'Datasheets_keywords',
  'Datasheets_models',
  'Datasheets_options',
  'Datasheets_wargear',
  'Datasheets_unit_composition',
  'Datasheets_models_cost',
  'Datasheets_stratagems',
  'Datasheets_enhancements',
  'Datasheets_detachment_abilities',
  'Datasheets_leader',
  'Detachments',
  'Stratagems',
  'Abilities',
  'Enhancements',
  'Detachment_abilities',
  'Last_update',
];

const CONNECTION = process.env.MUL_DATABASE_URL || '';
if (!CONNECTION) {
  console.error('MUL_DATABASE_URL is not set. Refusing to run.');
  process.exit(1);
}

// ---- CSV handling ----------------------------------------------------------

// Column names arrive as e.g. "BS_WS", "inv_sv", "M" — lowercase them so the
// SQL side never needs quoting. All are simple [A-Za-z0-9_] tokens.
const colName = (h) => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

// Parse Wahapedia's pipe-CSV. Every record has exactly ncols fields followed
// by a trailing pipe, but a field may contain literal newlines, so lines are
// accumulated until the buffer holds enough pipes to be a complete record.
function parseCsv(text) {
  const body = text.replace(/^\uFEFF/, ''); // strip UTF-8 BOM
  const lines = body.split(/\r?\n/);

  const header = lines.shift() ?? '';
  const cols = header.split('|').map(colName).filter(Boolean);
  const want = cols.length; // trailing pipe means: pipes per record == ncols

  const rows = [];
  let buf = null;
  for (const line of lines) {
    buf = buf === null ? line : `${buf}\n${line}`;
    const pipes = (buf.match(/\|/g) || []).length;
    if (pipes < want) continue; // record continues on the next line
    const parts = buf.split('|');
    rows.push(parts.slice(0, want).map((v) => (v === '' ? null : v)));
    buf = null;
  }
  if (buf !== null && buf.trim() !== '') {
    console.warn(`  ! dangling partial record ignored: ${buf.slice(0, 80)}...`);
  }
  return { cols, rows };
}

async function download(name) {
  const res = await fetch(`${BASE}${name}.csv`, {
    headers: { 'user-agent': 'raisinghavok-club-importer (contact: site admin)' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name}.csv: HTTP ${res.status}`);
  return res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- import ----------------------------------------------------------------

async function importFile(client, name, csvText) {
  const table = `wh40k_${name.toLowerCase()}`;
  if (!/^wh40k_[a-z0-9_]+$/.test(table)) throw new Error(`bad table name ${table}`);

  const { cols, rows } = parseCsv(csvText);
  if (!cols.length) throw new Error(`${name}: no header row`);

  await client.query(`DROP TABLE IF EXISTS ${table}`);
  await client.query(`CREATE TABLE ${table} (${cols.map((c) => `${c} TEXT`).join(', ')})`);

  // Multi-row inserts, batched to stay well under the parameter limit.
  const batchSize = Math.max(1, Math.floor(5000 / cols.length));
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const tuples = batch.map((row) => {
      const ph = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(',')})`;
    });
    await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`,
      params,
    );
  }

  // Indexes on the columns the site queries by.
  const idx = async (col) => {
    if (!cols.includes(col)) return;
    await client.query(`CREATE INDEX ON ${table} (${col})`);
  };
  await idx('id');
  await idx('datasheet_id');
  await idx('faction_id');
  if (cols.includes('name')) {
    await client.query(`CREATE INDEX ON ${table} (LOWER(name))`);
  }

  return { table, rows: rows.length };
}

async function main() {
  console.log('Downloading Wahapedia 11th-edition CSVs (sequential, polite)...');
  const downloaded = [];
  const missing = [];
  for (const name of FILES) {
    const text = await download(name);
    if (text === null) {
      console.log(`  404  ${name}.csv (skipped)`);
      missing.push(name);
    } else {
      console.log(`  ok   ${name}.csv (${text.length.toLocaleString()} chars)`);
      downloaded.push({ name, text });
    }
    await sleep(750);
  }

  const client = new pg.Client({
    connectionString: CONNECTION,
    ssl: { rejectUnauthorized: false }, // Azure Postgres requires TLS
  });
  await client.connect();

  try {
    await client.query('BEGIN');
    const results = [];
    for (const { name, text } of downloaded) {
      const r = await importFile(client, name, text);
      results.push(r);
      console.log(`  ${r.table}: ${r.rows} rows`);
    }

    // Import metadata, mirroring mul_meta's key/value shape.
    await client.query('DROP TABLE IF EXISTS wh40k_meta');
    await client.query('CREATE TABLE wh40k_meta (key TEXT PRIMARY KEY, value TEXT)');
    await client.query(
      `INSERT INTO wh40k_meta (key, value) VALUES
         ('importedAt', $1), ('source', 'https://wahapedia.ru/wh40k11ed/'),
         ('files', $2), ('missingFiles', $3)`,
      [new Date().toISOString(), downloaded.map((d) => d.name).join(','), missing.join(',')],
    );

    await client.query('COMMIT');
    console.log(`Done. ${results.length} tables imported${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
