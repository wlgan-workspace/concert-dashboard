// Translation helper — batches Chinese strings to Claude, with on-disk cache.
//
// Cache: scripts/translation-cache.json — { "中文": "English", ... }
// The cache is committed to git so repeat runs hit it.
//
// Env: ANTHROPIC_API_KEY (required if any new strings need translation).
//      ANTHROPIC_MODEL (optional, defaults to claude-haiku-4-5-20251001)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, 'translation-cache.json');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const BATCH_SIZE = 80; // strings per API call

let cache = null;

async function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache() {
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Returns map { srcText -> englishText }. Pure-ascii strings pass through as-is.
export async function translateBatch(strings) {
  const c = await loadCache();
  const result = {};
  const needed = [];

  for (const s of strings) {
    if (!s || typeof s !== 'string') { result[s] = s; continue; }
    if (s in c) { result[s] = c[s]; continue; }
    if (!/[一-鿿]/.test(s)) {
      // No Chinese chars at all — pass-through, also cache to skip re-checking.
      c[s] = s;
      result[s] = s;
      continue;
    }
    needed.push(s);
  }

  if (needed.length === 0) {
    await saveCache();
    return result;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`No ANTHROPIC_API_KEY — using free Google Translate fallback for ${needed.length} new strings.`);
    for (let i = 0; i < needed.length; i++) {
      const s = needed[i];
      try {
        const en = await freeTranslate(s);
        c[s] = en;
        result[s] = en;
      } catch (e) {
        console.warn(`  free translate failed for "${s}": ${e.message} — keeping Chinese.`);
        c[s] = s;
        result[s] = s;
      }
      // Save every 10 to avoid losing progress on crash.
      if (i % 10 === 9) await saveCache();
      // Rate limit ~5 req/sec to be polite.
      await new Promise(r => setTimeout(r, 200));
    }
    await saveCache();
    return result;
  }

  console.log(`Translating ${needed.length} new strings via ${MODEL}...`);

  for (let i = 0; i < needed.length; i += BATCH_SIZE) {
    const batch = needed.slice(i, i + BATCH_SIZE);
    const translated = await callClaude(batch);
    for (const [zh, en] of Object.entries(translated)) {
      c[zh] = en;
      result[zh] = en;
    }
    // Save cache after every batch so a crash doesn't lose progress.
    await saveCache();
  }

  // Fill in anything Claude failed to return.
  for (const s of needed) {
    if (!(s in result)) {
      c[s] = s;
      result[s] = s;
    }
  }
  await saveCache();
  return result;
}

// Free fallback: undocumented Google Translate endpoint used by their web client.
// No API key, but unofficial — rate limit gently. If it stops working, switch to MyMemory.
async function freeTranslate(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Response shape: [[[ "translated", "src", null, null, ... ], ...], ...]
  const segments = data?.[0];
  if (!Array.isArray(segments)) throw new Error('unexpected response shape');
  return segments.map(seg => seg?.[0] || '').join('').trim();
}

async function callClaude(strings) {
  const prompt = `Translate these Chinese strings to natural English. They are concert/event metadata: event names, artist names, city names, statuses, remarks, etc.

Rules:
- Translate proper nouns idiomatically (artists/cities). E.g. 周深 → Zhou Shen, 陶喆 → David Tao, 香港 → Hong Kong.
- Preserve any English/Latin/numeric segments already in the source.
- Preserve punctuation including · ·「」"" - ()【】etc., but you may swap full-width for half-width where natural.
- Output STRICT JSON: an object mapping each input string to its English translation. No prose, no markdown fences.

Input (JSON array):
${JSON.stringify(strings, null, 2)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const json = await res.json();
  const text = json.content?.[0]?.text || '';
  // Extract JSON object — model may include surrounding whitespace/newlines.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    console.warn(`Claude returned non-JSON response. Falling back to passthrough.`);
    return Object.fromEntries(strings.map(s => [s, s]));
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    console.warn(`Failed to parse Claude JSON: ${e.message}. Falling back to passthrough.`);
    return Object.fromEntries(strings.map(s => [s, s]));
  }
}
