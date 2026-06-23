#!/usr/bin/env node
// Sync Feishu Bitable -> index.html data blocks (USER IDENTITY).
//
// Auth model: refresh_token (long-lived, 30d) -> user_access_token (2h).
// On every run, Feishu issues a *new* refresh_token; we must persist it.
//
// In CI: writes the rotated refresh_token back to GitHub Secrets via REST API.
//        Requires env GH_PAT (a fine-grained PAT with Secrets: write on this repo).
//        Requires env GH_REPO (owner/name, set by Actions as GITHUB_REPOSITORY).
// In local dev: writes to .feishu-refresh-token (gitignored).
//
// Env:
//   FEISHU_APP_ID, FEISHU_APP_SECRET     (required) OAuth client
//   FEISHU_REFRESH_TOKEN                 (required) seed from bootstrap-auth.mjs
//   FEISHU_APP_TOKEN                     (required) wiki node token OR bitable app_token
//   FEISHU_TABLE_ID                      (required) tblXXXX
//   FEISHU_VIEW_ID                       (optional)
//   FEISHU_WIKI_NODE                     (optional, "1" if APP_TOKEN is a wiki node)
//   GH_PAT, GH_REPO                      (CI only) for rotating refresh_token Secret
//
// Modes:
//   node scripts/sync.mjs --discover     Print field schema and exit.
//   node scripts/sync.mjs                Full sync.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateBatch } from './translate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOCAL_TOKEN_FILE = path.join(REPO_ROOT, '.feishu-refresh-token');

const APP_ID = need('FEISHU_APP_ID');
const APP_SECRET = need('FEISHU_APP_SECRET');
const REFRESH_TOKEN_IN = need('FEISHU_REFRESH_TOKEN');
const APP_TOKEN_RAW = need('FEISHU_APP_TOKEN');
const TABLE_ID = need('FEISHU_TABLE_ID');
const VIEW_ID = process.env.FEISHU_VIEW_ID || '';
const IS_WIKI = process.env.FEISHU_WIKI_NODE === '1';

const IS_CI = !!process.env.GITHUB_ACTIONS;
const GH_PAT = process.env.GH_PAT || '';
const GH_REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';

const DISCOVER = process.argv.includes('--discover');
const LIST_TABLES = process.argv.includes('--list-tables');
const LIST_VIEWS = process.argv.includes('--list-views');

const FEISHU = 'https://open.feishu.cn/open-apis';

function need(k) {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
  return v;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(`Feishu API ${url} -> code=${json.code} msg=${json.msg}`);
  }
  return json;
}

// ---------- Auth ----------

// First mint an app_access_token (server-to-server) so we can call the OAuth refresh endpoint.
async function getAppAccessToken() {
  const r = await fetchJson(`${FEISHU}/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  return r.app_access_token;
}

// Exchange refresh_token -> { user_access_token, refresh_token, ... }.
async function refreshUserToken() {
  const appToken = await getAppAccessToken();
  const r = await fetchJson(`${FEISHU}/authen/v1/refresh_access_token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN_IN,
    }),
  });
  return r.data;
}

// ---------- Persist rotated refresh_token ----------

async function persistRefreshToken(newRefreshToken) {
  if (newRefreshToken === REFRESH_TOKEN_IN) {
    console.log('refresh_token unchanged.');
    return;
  }
  if (IS_CI) {
    if (!GH_PAT || !GH_REPO) {
      throw new Error('CI run but GH_PAT or GH_REPO missing — cannot rotate refresh_token Secret. Token will EXPIRE.');
    }
    await writeGithubSecret(GH_REPO, GH_PAT, 'FEISHU_REFRESH_TOKEN', newRefreshToken);
    console.log('Rotated FEISHU_REFRESH_TOKEN in GitHub Secrets.');
  } else {
    await fs.writeFile(LOCAL_TOKEN_FILE, newRefreshToken, { mode: 0o600 });
    console.log(`Rotated refresh_token written to ${LOCAL_TOKEN_FILE}`);
  }
}

// GitHub Secrets write — requires libsodium for encryption.
async function writeGithubSecret(repo, pat, name, value) {
  const ghHeaders = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. Fetch repo public key for Secrets encryption.
  const keyRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, { headers: ghHeaders });
  if (!keyRes.ok) throw new Error(`GitHub public-key fetch failed: ${keyRes.status} ${await keyRes.text()}`);
  const { key, key_id } = await keyRes.json();

  // 2. Encrypt with NaCl sealed box (libsodium sealed box, but a CommonJS
  //    package — avoids the ESM resolution bug in libsodium-wrappers on Node 24+).
  const tweetsodium = (await import('tweetsodium')).default;
  const messageBytes = Buffer.from(value);
  const keyBytes = Buffer.from(key, 'base64');
  const encryptedBytes = tweetsodium.seal(messageBytes, keyBytes);
  const encrypted_value = Buffer.from(encryptedBytes).toString('base64');

  // 3. PUT secret.
  const putRes = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value, key_id }),
  });
  if (!putRes.ok) throw new Error(`GitHub secret PUT failed: ${putRes.status} ${await putRes.text()}`);
}

// ---------- Bitable ----------

async function resolveAppToken(userToken) {
  if (!IS_WIKI) return APP_TOKEN_RAW;
  const r = await fetchJson(
    `${FEISHU}/wiki/v2/spaces/get_node?token=${encodeURIComponent(APP_TOKEN_RAW)}&obj_type=wiki`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  );
  return r.data.node.obj_token;
}

async function listFields(userToken, appToken, tableId) {
  const fields = [];
  let pageToken = '';
  do {
    const url = new URL(`${FEISHU}/bitable/v1/apps/${appToken}/tables/${tableId}/fields`);
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const r = await fetchJson(url, { headers: { Authorization: `Bearer ${userToken}` } });
    fields.push(...r.data.items);
    pageToken = r.data.has_more ? r.data.page_token : '';
  } while (pageToken);
  return fields;
}

async function listTables(userToken, appToken) {
  const tables = [];
  let pageToken = '';
  do {
    const url = new URL(`${FEISHU}/bitable/v1/apps/${appToken}/tables`);
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const r = await fetchJson(url, { headers: { Authorization: `Bearer ${userToken}` } });
    tables.push(...r.data.items);
    pageToken = r.data.has_more ? r.data.page_token : '';
  } while (pageToken);
  return tables;
}

async function listViews(userToken, appToken, tableId) {
  const views = [];
  let pageToken = '';
  do {
    const url = new URL(`${FEISHU}/bitable/v1/apps/${appToken}/tables/${tableId}/views`);
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const r = await fetchJson(url, { headers: { Authorization: `Bearer ${userToken}` } });
    views.push(...r.data.items);
    pageToken = r.data.has_more ? r.data.page_token : '';
  } while (pageToken);
  return views;
}

async function listRecords(userToken, appToken, tableId, viewId) {
  const records = [];
  let pageToken = '';
  do {
    const body = {
      automatic_fields: true,
      ...(viewId ? { view_id: viewId } : {}),
    };
    const url = new URL(`${FEISHU}/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`);
    url.searchParams.set('page_size', '500');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const r = await fetchJson(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    records.push(...(r.data.items || []));
    pageToken = r.data.has_more ? r.data.page_token : '';
  } while (pageToken);
  return records;
}

// ---------- Cell flattening ----------

function flatten(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object' && 'text' in v[0]) {
      return v.map(seg => seg.text || '').join('');
    }
    return v.map(item => {
      if (typeof item === 'object' && item) return item.name || item.text || item.value || '';
      return String(item);
    }).filter(Boolean).join(',');
  }
  if (typeof v === 'object') {
    if ('text' in v) return v.text;
    if ('name' in v) return v.name;
    if ('value' in v) return Array.isArray(v.value) ? flatten(v.value) : v.value;
  }
  return String(v);
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function loadFieldMap() {
  const p = path.join(REPO_ROOT, 'scripts/field-map.json');
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

function buildRecord(item, fieldsList, fieldMap) {
  const f = item.fields || {};
  const out = {};

  for (const m of fieldsList) {
    const raw = f[m.from];
    if (raw === undefined || raw === null) {
      out[m.to] = m.kind === 'datetime-ms' ? 0 : '';
      continue;
    }
    switch (m.kind) {
      case 'date':
        out[m.to] = typeof raw === 'number' ? formatDate(raw) : flatten(raw);
        break;
      case 'datetime-ms':
        out[m.to] = typeof raw === 'number' ? raw : Number(raw) || 0;
        break;
      default:
        out[m.to] = flatten(raw);
    }
  }

  out._countries = out.country
    ? String(out.country).split(/[,，;；/]/).map(s => s.trim()).filter(Boolean)
    : [];

  // Automatic fields from `automatic_fields: true`
  if (item.created_time) out.createdTime = item.created_time;
  if (item.last_modified_time) out.modifiedTime = item.last_modified_time;

  out.__extra = {};

  return out;
}

// Fields that should have an _en counterpart in the output.
const EN_FIELDS = [
  'name', 'category', 'artist', 'city', 'country', 'status', 'remarks',
  'eventType', 'keySites', 'pushSites', 'infoTime', 'announceTime',
  'addedAnnounceTime',
];

async function addEnglishFields(records, dict) {
  // Collect distinct strings that need translation.
  const toTranslate = new Set();
  for (const r of records) {
    for (const k of EN_FIELDS) {
      const v = r[k];
      if (typeof v === 'string' && v) toTranslate.add(v);
    }
  }

  // Pre-fill with dict entries (country/category/eventType already mapped).
  const dictMap = {};
  for (const kind of Object.keys(dict || {})) {
    for (const [zh, en] of Object.entries(dict[kind])) dictMap[zh] = en;
  }

  const stringsForApi = [...toTranslate].filter(s => !(s in dictMap));
  const apiMap = await translateBatch(stringsForApi);

  const merged = { ...apiMap, ...dictMap }; // dict wins

  for (const r of records) {
    for (const k of EN_FIELDS) {
      const v = r[k];
      r[`${k}_en`] = (typeof v === 'string' && v in merged) ? merged[v] : (v || '');
    }
  }
}

// ---------- HTML rewrite ----------

async function rewriteIndex(records, dict, extraFields, updateStamp) {
  const p = path.join(REPO_ROOT, 'index.html');
  let html = await fs.readFile(p, 'utf8');

  const replaceBlock = (id, payload) => {
    const re = new RegExp(`(<script id="${id}" type="application/json">)[\\s\\S]*?(</script>)`);
    if (!re.test(html)) throw new Error(`Block #${id} not found in index.html`);
    html = html.replace(re, `$1${JSON.stringify(payload)}$2`);
  };

  replaceBlock('data', { records });
  replaceBlock('dict', dict);
  replaceBlock('extra-fields', extraFields);

  const stampRe = /(getElementById\('update-date'\)\.textContent\s*=\s*)'[^']*'/;
  if (!stampRe.test(html)) throw new Error('update-date assignment not found in index.html');
  html = html.replace(stampRe, `$1'${updateStamp}'`);

  await fs.writeFile(p, html);
}

// ---------- Main ----------

async function main() {
  const auth = await refreshUserToken();
  const userToken = auth.access_token;
  const newRefresh = auth.refresh_token;

  // Persist rotated refresh_token EARLY — even if downstream steps fail,
  // we keep the renewed 30-day window.
  await persistRefreshToken(newRefresh);

  const appToken = await resolveAppToken(userToken);

  if (LIST_TABLES) {
    const tables = await listTables(userToken, appToken);
    console.log('All tables in this bitable:\n');
    for (const t of tables) {
      console.log(`  ${t.table_id}   ${t.name}`);
    }
    return;
  }

  if (LIST_VIEWS) {
    const tables = await listTables(userToken, appToken);
    for (const t of tables) {
      const views = await listViews(userToken, appToken, t.table_id);
      console.log(`\n${t.name}  (${t.table_id})`);
      for (const v of views) {
        console.log(`  ${v.view_id}   ${v.view_type.padEnd(8)} ${v.view_name}`);
      }
    }
    return;
  }

  if (DISCOVER) {
    const fields = await listFields(userToken, appToken, TABLE_ID);
    const summary = fields.map(f => ({
      name: f.field_name,
      type: f.type,
      ui_type: f.ui_type,
      property: f.property,
    }));
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const fieldMap = await loadFieldMap();

  if (!fieldMap.tables || !fieldMap.tables.length) {
    throw new Error('field-map.json must have a non-empty "tables" array.');
  }

  let allRecords = [];
  for (const t of fieldMap.tables) {
    const fields = await listFields(userToken, appToken, t.table_id);
    const fieldsByName = Object.fromEntries(fields.map(f => [f.field_name, f]));
    const missing = t.fields.map(m => m.from).filter(n => !fieldsByName[n]);
    if (missing.length) {
      console.warn(`[${t.source}] missing columns (will be empty): ${missing.join(', ')}`);
    }

    // Resolve view: per-table view_id wins; else view_name lookup; else env VIEW_ID; else none.
    let viewId = t.view_id || '';
    let viewLabel = viewId;
    if (!viewId && t.view_name) {
      const views = await listViews(userToken, appToken, t.table_id);
      const match = views.find(v => v.view_name === t.view_name);
      if (match) {
        viewId = match.view_id;
        viewLabel = `${match.view_name} (${match.view_id})`;
      } else {
        console.warn(`[${t.source}] view_name "${t.view_name}" not found in this table — falling back to no view.`);
      }
    }

    const items = await listRecords(userToken, appToken, t.table_id, viewId);
    console.log(`[${t.source}] view=${viewLabel || '(none)'} fetched ${items.length} records.`);

    for (const it of items) {
      const rec = buildRecord(it, t.fields, fieldMap);
      rec.source = t.source;
      allRecords.push(rec);
    }
  }

  allRecords.sort((a, b) => (b.createdTime || 0) - (a.createdTime || 0));

  await addEnglishFields(allRecords, fieldMap.dict);

  await rewriteIndex(allRecords, fieldMap.dict || {}, {}, nowStamp());
  console.log(`Wrote ${allRecords.length} records to index.html`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
