#!/usr/bin/env node
// One-time OAuth bootstrap — get the initial refresh_token for user-identity sync.
//
// Usage:
//   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx node scripts/bootstrap-auth.mjs
//
// What it does:
//   1. Spins up a tiny HTTP server on http://localhost:8765/callback as the redirect URI.
//   2. Opens (or prints) the Feishu authorization URL in your browser.
//   3. Receives ?code=... from Feishu, exchanges it for an access_token + refresh_token.
//   4. Prints the refresh_token so you can paste it into GitHub Secrets.
//
// Prerequisite — in the Feishu app's "安全设置" → "重定向 URL", add:
//     http://localhost:8765/callback
// Save and re-publish the app.

import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ID = need('FEISHU_APP_ID');
const APP_SECRET = need('FEISHU_APP_SECRET');
const REDIRECT_URI = 'http://localhost:8765/callback';

function need(k) {
  const v = process.env[k];
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
  return v;
}

const FEISHU = 'https://open.feishu.cn/open-apis';

const authUrl = new URL(`${FEISHU}/authen/v1/authorize`);
authUrl.searchParams.set('app_id', APP_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('state', 'bootstrap');

console.log('\n=== Feishu OAuth bootstrap ===\n');
console.log('Opening browser to authorize. If it does not open, copy this URL into your browser:\n');
console.log(authUrl.toString());
console.log('\nWaiting for redirect on', REDIRECT_URI, '...\n');

// Try to open the URL automatically (macOS).
spawn('open', [authUrl.toString()]).on('error', () => {});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:8765`);
  if (u.pathname !== '/callback') {
    res.writeHead(404).end('not found');
    return;
  }
  const code = u.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('no code in callback');
    return;
  }
  try {
    const appTokenRes = await fetch(`${FEISHU}/auth/v3/app_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    }).then(r => r.json());

    if (appTokenRes.code !== 0) throw new Error(`app_access_token error: ${JSON.stringify(appTokenRes)}`);

    const tokenRes = await fetch(`${FEISHU}/authen/v1/access_token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appTokenRes.app_access_token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    }).then(r => r.json());

    if (tokenRes.code !== 0) throw new Error(`access_token error: ${JSON.stringify(tokenRes)}`);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>OK. You can close this tab and return to the terminal.</h2>');

    console.log('\n=== SUCCESS ===\n');
    console.log('user_access_token (2h, do not store):');
    console.log('  ', tokenRes.data.access_token.slice(0, 12) + '...');
    console.log('\nrefresh_token (30d — copy this into GitHub Secret FEISHU_REFRESH_TOKEN):\n');
    console.log(tokenRes.data.refresh_token);
    console.log('\nuser:', tokenRes.data.name || tokenRes.data.en_name || '(unknown)');
    console.log('\nDone. Press Ctrl+C to exit.\n');
  } catch (err) {
    res.writeHead(500).end(err.message);
    console.error(err);
  }
});

server.listen(8765, '127.0.0.1');
