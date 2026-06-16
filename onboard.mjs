#!/usr/bin/env node
/*
 * onboard.mjs — one-time Tesla Fleet API onboarding for READ-ONLY State of Charge.
 *
 * Zero dependencies. Requires Node 18+ (uses global fetch).
 *
 * What it does:
 *   1. Partner registration  (POST /api/1/partner_accounts, one-time per app+region)
 *   2. OAuth authorization_code flow -> refresh_token (saved to tokens.json)
 *   3. Reads vehicle_data and prints the battery_level (SoC)
 *
 * Credentials (client_id / client_secret) are read from, in order:
 *   - environment variables TESLA_CLIENT_ID / TESLA_CLIENT_SECRET
 *   - a gitignored "tesla.env" file (KEY=VALUE lines)
 *   - interactive prompt
 *
 * The public key must already be hosted at:
 *   https://<DOMAIN>/.well-known/appspecific/com.tesla.3p.public-key.pem
 * and the Tesla app's "Allowed Origin" must equal https://<DOMAIN>.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

// ---------------------------- config ----------------------------
// Override via env (or tesla.env): TESLA_REGION, TESLA_DOMAIN, TESLA_REDIRECT_URI.
const REGION_BASES  = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  cn: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn',
};
const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const TOKEN_URL     = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const SCOPES        = 'openid offline_access vehicle_device_data';
const TOKENS_FILE   = 'tokens.json';
// ----------------------------------------------------------------

// Load tesla.env (KEY=VALUE) without overriding real environment variables.
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnvFile('tesla.env');

const REGION       = (process.env.TESLA_REGION || 'eu').toLowerCase();
const REGION_BASE  = REGION_BASES[REGION] || REGION_BASES.eu;
const DOMAIN       = process.env.TESLA_DOMAIN || 'oiqxy.fleetkey.net';
const REDIRECT_URI = process.env.TESLA_REDIRECT_URI || 'https://oauth.pstmn.io/v1/callback';

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);

// POST application/x-www-form-urlencoded and parse the JSON/text response.
async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function getJson(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const CLIENT_ID     = process.env.TESLA_CLIENT_ID     || (await ask('client_id: ')).trim();
  const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET || (await ask('client_secret: ')).trim();
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing client_id / client_secret.');
    process.exit(1);
  }

  // -------- Step 1: partner token + one-time partner registration --------
  console.log('\n[1/4] Partner registration for', DOMAIN, '...');
  const pt = await postForm(TOKEN_URL, {
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'openid vehicle_device_data',
    audience: REGION_BASE,
  });
  if (!pt.ok) {
    console.error('  Partner token FAILED:', pt.status, pt.body);
    console.error('  -> usually a wrong client_id/client_secret.');
    process.exit(1);
  }
  const reg = await fetch(`${REGION_BASE}/api/1/partner_accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pt.body.access_token}` },
    body: JSON.stringify({ domain: DOMAIN }),
  });
  const regText = await reg.text();
  console.log('  register ->', reg.status, regText.slice(0, 300));
  if (reg.status >= 400) {
    console.error('  Registration error. Check: Allowed Origin == https://' + DOMAIN +
                  ', and the key is reachable at the .well-known path.');
    // Not exiting: it may already be registered; continue and let the read confirm.
  }

  // -------- Step 2: authorization_code flow --------
  const state = Math.random().toString(36).slice(2);
  const url = `${AUTHORIZE_URL}?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}` +
              `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
              `&scope=${encodeURIComponent(SCOPES)}&state=${state}`;
  console.log('\n[2/4] Open this URL, log in & approve, then copy the "code" from the redirect URL:\n');
  console.log(url + '\n');
  const code = (await ask('Paste code here: ')).trim();

  // -------- Step 3: exchange code -> tokens --------
  console.log('\n[3/4] Exchanging code for tokens ...');
  const tok = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
    audience: REGION_BASE,
  });
  if (!tok.ok) {
    console.error('  Token exchange FAILED:', tok.status, tok.body);
    console.error('  -> the code expires fast; re-run and exchange immediately.');
    process.exit(1);
  }
  const { access_token, refresh_token } = tok.body;
  writeFileSync(TOKENS_FILE, JSON.stringify(
    { refresh_token, region_base: REGION_BASE, obtained: new Date().toISOString() }, null, 2));
  console.log('  refresh_token saved to', TOKENS_FILE);

  // -------- Step 4: read SoC --------
  console.log('\n[4/4] Reading vehicle data ...');
  const list = await getJson(`${REGION_BASE}/api/1/vehicles`, access_token);
  if (list.status === 412) {
    console.error('  412 -> partner registration is NOT effective for this region. Re-check step 1.');
    process.exit(1);
  }
  if (!list.ok) { console.error('  List vehicles FAILED:', list.status, list.body); process.exit(1); }
  const vehicles = list.body.response || [];
  if (!vehicles.length) { console.error('  No vehicles on this account.'); process.exit(1); }
  console.log('  vehicles:', vehicles.map((v) => `${v.display_name} [${v.state}]`).join(', '));

  const v = vehicles[0];
  const vd = await getJson(
    `${REGION_BASE}/api/1/vehicles/${v.id}/vehicle_data?endpoints=charge_state`, access_token);

  if (vd.status === 408) {
    console.log(`\n✅ Registration WORKS (no 412). The car "${v.display_name}" is ${v.state} ` +
                `so vehicle_data returned 408 (asleep). Wake it (open the Tesla app) and re-run to see SoC.`);
  } else if (vd.status === 412) {
    console.error('\n  412 on vehicle_data -> registration gate. Re-check step 1.');
  } else if (!vd.ok) {
    console.error('\n  vehicle_data ->', vd.status, vd.body);
  } else {
    const cs = vd.body.response?.charge_state || {};
    console.log(`\n✅ SoC = ${cs.battery_level}%  ` +
                `(usable ${cs.usable_battery_level}%, limit ${cs.charge_limit_soc}%, ` +
                `range ${cs.battery_range}, charging ${cs.charging_state})`);
  }
  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
