'use strict';
/*
 * Shared Tesla Fleet API helpers (read-only State of Charge).
 * CommonJS, zero dependencies, Node 18+ (global fetch).
 *
 * Two groups of functions:
 *   - Onboarding (need client_secret): partnerRegister, exchangeCode, authorizeUrl
 *   - Runtime (no client_secret):      refreshAccessToken, listVehicles, getVehicleData
 */

const REGIONS = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  cn: 'https://fleet-api.prd.cn.vn.cloud.tesla.cn',
};
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';
const READ_SCOPES = 'openid offline_access vehicle_device_data';

function baseUrl(region) {
  const b = REGIONS[region];
  if (!b) throw new Error('Unknown Tesla region: ' + region + ' (expected na/eu/cn)');
  return b;
}

class TeslaApiError extends Error {
  constructor(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    super('Tesla API ' + status + ': ' + text);
    this.name = 'TeslaApiError';
    this.status = status;
    this.body = body;
  }
}

async function parse(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await parse(res);
  if (!res.ok) throw new TeslaApiError(res.status, body);
  return body;
}

async function getJson(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  const body = await parse(res);
  if (!res.ok) throw new TeslaApiError(res.status, body);
  return body;
}

// ---------------- OAuth ----------------

// Refresh grant: ONLY client_id + refresh_token (no client_secret).
// Returns { access_token, refresh_token (ROTATED), expires_in, token_type }.
async function refreshAccessToken(clientId, refreshToken) {
  return postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
}

// Partner (client_credentials) token — needs client_secret. Used for partner registration.
async function partnerToken(clientId, clientSecret, region) {
  return postForm(TOKEN_URL, {
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'openid vehicle_device_data',
    audience: baseUrl(region),
  });
}

// One-time partner registration. Requires the public key hosted at
// https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem.
// Idempotent: Tesla returns 200 even if already registered.
async function partnerRegister(clientId, clientSecret, domain, region) {
  const pt = await partnerToken(clientId, clientSecret, region);
  const res = await fetch(baseUrl(region) + '/api/1/partner_accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pt.access_token },
    body: JSON.stringify({ domain }),
  });
  const body = await parse(res);
  if (!res.ok) throw new TeslaApiError(res.status, body);
  return body;
}

// Authorization-code exchange — needs client_secret. Returns initial refresh_token.
async function exchangeCode(clientId, clientSecret, code, redirectUri, region) {
  return postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    audience: baseUrl(region),
  });
}

function authorizeUrl(clientId, redirectUri, state, includeLocation) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', READ_SCOPES + (includeLocation ? ' vehicle_location' : ''));
  u.searchParams.set('state', state || 'state');
  // Force the login/consent screen. Without this, an already-authorised Tesla
  // session redirects instantly and re-uses the OLD consent, so a newly added
  // scope (e.g. vehicle_location) is NOT granted. prompt=login makes Tesla
  // re-prompt so changed scopes actually take effect.
  u.searchParams.set('prompt', 'login');
  return u.toString();
}

// ---------------- Pure helpers ----------------

const MI_TO_KM = 1.609344;

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function convertValue(value, unit, system) {
  if (value == null || !unit) return { value, unit: unit || '' };
  if (system === 'metric') {
    if (unit === 'mi') return { value: value * MI_TO_KM, unit: 'km' };
    if (unit === 'mph') return { value: value * MI_TO_KM, unit: 'km/h' };
    if (unit === 'mi/hr') return { value: value * MI_TO_KM, unit: 'km/h' };
  } else if (system === 'imperial') {
    if (unit === 'C') return { value: value * 9 / 5 + 32, unit: 'F' };
  }
  return { value, unit };
}

// ---------------- Data (read-only) ----------------

const ALL_ENDPOINTS = 'charge_state;climate_state;drive_state;vehicle_state;gui_settings;vehicle_config';

// List vehicles with their sleep state. Does NOT wake the car and is not billed.
async function listVehicles(region, accessToken) {
  const body = await getJson(baseUrl(region) + '/api/1/vehicles', accessToken);
  return body.response || [];
}

// Full read-only snapshot. Returns the `response` object (the six domain objects).
async function getVehicleData(region, accessToken, idOrVin, endpoints) {
  const ep = endpoints || ALL_ENDPOINTS;
  const url = baseUrl(region) + '/api/1/vehicles/' + idOrVin + '/vehicle_data?endpoints=' + encodeURIComponent(ep);
  const body = await getJson(url, accessToken);
  return body.response || null;
}

module.exports = {
  REGIONS,
  READ_SCOPES,
  MI_TO_KM,
  ALL_ENDPOINTS,
  TeslaApiError,
  baseUrl,
  getByPath,
  convertValue,
  refreshAccessToken,
  partnerRegister,
  exchangeCode,
  authorizeUrl,
  listVehicles,
  getVehicleData,
};
