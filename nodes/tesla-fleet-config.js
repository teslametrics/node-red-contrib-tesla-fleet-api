'use strict';
/*
 * tesla-fleet-config — config node holding Tesla Fleet API credentials and
 * managing the OAuth token lifecycle for read-only access.
 *
 * Runtime only ever uses client_id + refresh_token (the refresh grant needs no
 * secret). client_secret is stored (encrypted) and used only for the one-time
 * in-editor onboarding (partner registration + authorization-code exchange).
 *
 * The refresh_token rotates on every refresh and must survive restarts. Node-RED
 * nodes cannot persist their own credentials at runtime, so the rotated token is
 * written to an atomic 0600 JSON file under <userDir>/<pkg>/tokens-<id>.json.
 * A "seed" (the credential value the chain started from) lets us detect when the
 * user re-onboards (credential changes) and discard a now-stale persisted token.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tesla = require('../lib/tesla-fleet');

module.exports = function (RED) {
  const STORE_DIR = path.join(RED.settings.userDir || '.', 'node-red-contrib-tesla-fleet-api');
  const tokenFile = (id) => path.join(STORE_DIR, 'tokens-' + id + '.json');

  function saveTokens(id, data) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = tokenFile(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({ updated: Date.now() }, data)), { mode: 0o600 });
    fs.renameSync(tmp, tokenFile(id)); // atomic on POSIX
  }
  function loadTokens(id) {
    try { return JSON.parse(fs.readFileSync(tokenFile(id), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  const snapFile = (id) => path.join(STORE_DIR, 'snapshot-' + id + '.json');
  function saveSnapshot(id, snap) {
    try {
      fs.mkdirSync(STORE_DIR, { recursive: true });
      const tmp = snapFile(id) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
      fs.renameSync(tmp, snapFile(id));
    } catch (e) { /* non-fatal */ }
  }
  function loadSnapshot(id) {
    try { return JSON.parse(fs.readFileSync(snapFile(id), 'utf8')); }
    catch (e) { return null; }
  }

  function TeslaFleetConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.region = config.region || 'eu';
    node.clientId = node.credentials.client_id;

    // Resolve the active refresh token: prefer the persisted (rotated) one, but
    // only if it was derived from the current credential seed.
    const seed = node.credentials.refresh_token || null;
    node._seed = seed;
    const stored = loadTokens(node.id);
    if (stored && stored.seed === seed && stored.current) {
      node.refreshToken = stored.current;
    } else {
      node.refreshToken = seed;
      if (seed) {
        try { saveTokens(node.id, { seed, current: seed }); } catch (e) { node.warn('token persist init failed: ' + e.message); }
      }
    }

    node._access = null;      // { token, expiresAt }
    node._refreshing = null;  // in-flight refresh promise (de-dupe concurrent reads)

    // Returns a valid access token, refreshing (and persisting the rotated
    // refresh token) when needed. Safe to call concurrently.
    node.getAccessToken = async function () {
      const now = Date.now();
      if (node._access && node._access.expiresAt - 60000 > now) return node._access.token;
      if (node._refreshing) return node._refreshing;
      node._refreshing = (async () => {
        if (!node.clientId || !node.refreshToken) {
          throw new Error('Tesla Fleet config not onboarded (missing client_id or refresh_token)');
        }
        const tok = await tesla.refreshAccessToken(node.clientId, node.refreshToken);
        if (tok.refresh_token && tok.refresh_token !== node.refreshToken) {
          node.refreshToken = tok.refresh_token;
          try { saveTokens(node.id, { seed: node._seed, current: tok.refresh_token }); }
          catch (e) { node.error('Failed to persist rotated refresh token: ' + e.message); }
        }
        node._access = { token: tok.access_token, expiresAt: now + (tok.expires_in || 28800) * 1000 };
        return node._access.token;
      })();
      try { return await node._refreshing; }
      finally { node._refreshing = null; }
    };

    node.refreshIntervalMs = Math.max(1, Number(config.refreshIntervalMin) || 15) * 60 * 1000;
    node.unitSystem = config.unitSystem || 'as-reported';
    // When set, request the extra `location_data` endpoint so drive_state returns
    // latitude/longitude/heading (firmware 2023.38+ withholds these otherwise).
    // Needs the vehicle_location OAuth scope too — both are driven by this one flag.
    node.includeLocation = config.includeLocation === true || config.includeLocation === 'true';

    // Snapshot cache keyed by VIN: { [vin]: { data, lastUpdated, stale, vehicleState } }.
    // Persisted so last-known values survive a restart. One Tesla account (this config)
    // can hold several vehicles; we only ever fetch the ones a consumer node asks for.
    node.snapshots = loadSnapshot(node.id) || {};
    node._vehicles = [];        // last listVehicles result (id, vin, state, display_name)
    node._firstVin = null;      // account's first vehicle — the "default" target
    node._subs = new Set();
    node._polling = null;

    node.subscribe = (n) => node._subs.add(n);
    node.unsubscribe = (n) => node._subs.delete(n);

    function notify() { for (const n of node._subs) { try { n.emitFromSnapshot && n.emitFromSnapshot(); } catch (e) {} } }

    // The set of VINs subscribers actually want (empty selection = the first vehicle).
    function targetVins() {
      const out = new Set();
      for (const n of node._subs) {
        const want = (n.vehicleVin || '').trim();
        out.add(want || node._firstVin);
      }
      return out;
    }

    // poll(silent): fetch fresh data. silent=true skips the subscriber notify
    // (used by a node's own input handler, which emits itself afterwards).
    node.poll = function (silent) {
      if (node._polling) return node._polling;           // coalesce
      node._polling = (async () => {
        if (node._subs.size === 0) return;                // nobody reading → no API call at all
        const token = await node.getAccessToken();
        const vehicles = await tesla.listVehicles(node.region, token);  // free, never wakes
        node._vehicles = vehicles;
        node._firstVin = vehicles[0] ? vehicles[0].vin : null;
        if (!vehicles.length) return;

        const eps = node.includeLocation ? ('location_data;' + tesla.ALL_ENDPOINTS) : undefined;
        const wanted = targetVins();                      // only fetch cars someone subscribes to
        for (const v of vehicles) {
          if (!wanted.has(v.vin)) continue;
          const slot = node.snapshots[v.vin] || (node.snapshots[v.vin] = { data: null, lastUpdated: null, stale: true });
          if (v.state !== 'online') {                     // asleep/offline = NOT an error
            slot.stale = true; slot.vehicleState = v.state;
            continue;
          }
          try {
            let data;
            try {
              data = await tesla.getVehicleData(node.region, token, v.id, eps);
            } catch (e) {
              if (e.status === 403 && eps) {              // location not authorised → read without it
                node.warn('Tesla: location data not authorised (re-onboard with "Include location"?). Reading without location.');
                data = await tesla.getVehicleData(node.region, token, v.id);
              } else throw e;
            }
            node.snapshots[v.vin] = { data, lastUpdated: Date.now(), stale: false, vehicleState: 'online' };
          } catch (e) {
            if (e.status === 408) { slot.stale = true; slot.vehicleState = 'asleep'; }  // asleep race
            else throw e;                                 // real error → bubble to caller
          }
        }
        saveSnapshot(node.id, node.snapshots);
      })().catch((e) => node.error('Tesla poll failed: ' + e.message))
          .finally(() => { node._polling = null; if (!silent) notify(); });
      return node._polling;
    };

    // Resolve a consumer's selected VIN ('' = the account's first vehicle).
    node.resolveVin = function (vin) {
      const want = (vin || '').trim();
      return want || node._firstVin || '';
    };

    node.getValue = function (vin, metricKey, unitSystemOverride) {
      const m = require('../lib/metrics').getMetric(metricKey);
      const snap = node.snapshots[node.resolveVin(vin)] || null;
      if (!m || !snap || !snap.data) {
        return { value: null, unit: m ? (m.unit || '') : '', stale: true, lastUpdated: snap ? snap.lastUpdated : null };
      }
      const raw = tesla.getByPath(snap.data, m.path);
      const conv = tesla.convertValue(raw, m.unit || '', unitSystemOverride || node.unitSystem);
      return { value: conv.value, unit: conv.unit, stale: snap.stale, lastUpdated: snap.lastUpdated };
    };

    node._timer = setInterval(() => node.poll(), node.refreshIntervalMs);
    setTimeout(() => node.poll(), 1500);                 // first poll soon after deploy

    node.on('close', function () { clearInterval(node._timer); node._access = null; });
  }

  RED.nodes.registerType('tesla-fleet-config', TeslaFleetConfigNode, {
    credentials: {
      client_id: { type: 'text' },
      client_secret: { type: 'password' },
      refresh_token: { type: 'password' },
    },
  });

  // ---- Admin endpoint: generate an EC (prime256v1) key pair ----
  // The user hosts the returned PUBLIC key (e.g. on fleetkey.cc). The private key
  // is unused for read-only access but kept under the user dir for completeness.
  RED.httpAdmin.post('/tesla-fleet/keygen',
    RED.auth.needsPermission('tesla-fleet-config.write'),
    function (req, res) {
      try {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
          namedCurve: 'prime256v1',
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        try {
          fs.mkdirSync(STORE_DIR, { recursive: true });
          fs.writeFileSync(path.join(STORE_DIR, 'private-key.pem'), privateKey, { mode: 0o600 });
        } catch (e) { /* non-fatal: private key is not needed for read-only */ }
        res.json({ public_key: publicKey, private_key: privateKey });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

  // ---- Admin endpoint: forget (delete) the stored private key ----
  RED.httpAdmin.post('/tesla-fleet/forget-key',
    RED.auth.needsPermission('tesla-fleet-config.write'),
    function (req, res) {
      try {
        fs.rmSync(path.join(STORE_DIR, 'private-key.pem'), { force: true });
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

  // ---- Admin endpoint: build the authorize URL for the editor login link ----
  RED.httpAdmin.get('/tesla-fleet/authorize-url',
    RED.auth.needsPermission('tesla-fleet-config.read'),
    function (req, res) {
      const { client_id, redirect_uri } = req.query;
      if (!client_id || !redirect_uri) return res.status(400).json({ error: 'client_id and redirect_uri required' });
      res.json({ url: tesla.authorizeUrl(client_id, redirect_uri, 'nr-' + Date.now(), req.query.include_location === 'true') });
    });

  // ---- Admin endpoint: list all available metrics ----
  RED.httpAdmin.get('/tesla-fleet/metrics',
    RED.auth.needsPermission('tesla-fleet-config.read'),
    function (req, res) { res.json(require('../lib/metrics').METRICS); });

  // ---- Admin endpoint: list the account's vehicles (for the per-node Vehicle picker) ----
  // Uses the DEPLOYED config node's token so refresh-token rotation stays centralised.
  RED.httpAdmin.get('/tesla-fleet/vehicles',
    RED.auth.needsPermission('tesla-fleet-config.read'),
    async function (req, res) {
      try {
        const cfg = RED.nodes.getNode(req.query.config);
        if (!cfg || typeof cfg.getAccessToken !== 'function') {
          return res.status(404).json({ error: 'Deploy the Tesla Fleet config first, then reopen this node to list vehicles.' });
        }
        const token = await cfg.getAccessToken();
        const vehicles = await tesla.listVehicles(cfg.region, token);
        res.json(vehicles.map((v) => ({ vin: v.vin, display_name: v.display_name, state: v.state })));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

  // ---- Admin endpoint: finish onboarding (partner registration + code exchange) ----
  RED.httpAdmin.post('/tesla-fleet/onboard',
    RED.auth.needsPermission('tesla-fleet-config.write'),
    async function (req, res) {
      try {
        const body = req.body || {};
        const { client_id, domain, region, code, redirect_uri, node_id } = body;
        // Node-RED never sends a stored password back to the editor: the client_secret field
        // carries the '__PWRD__' sentinel (or is blank) when a value is already saved. In that
        // case fall back to the deployed config node's stored credential.
        let client_secret = body.client_secret;
        if (!client_secret || client_secret === '__PWRD__') {
          const cnode = node_id && RED.nodes.getNode(node_id);
          client_secret = (cnode && cnode.credentials && cnode.credentials.client_secret) || '';
        }
        if (!client_id || !client_secret || !code || !redirect_uri) {
          return res.status(400).json({ error: 'client_id, client_secret (typed or already saved), code and redirect_uri are required' });
        }
        const reg = region || 'eu';
        let registration = 'skipped (no domain)';
        if (domain) {
          // Idempotent; tolerate "already registered" so re-onboarding still works.
          try { await tesla.partnerRegister(client_id, client_secret, domain, reg); registration = 'ok'; }
          catch (e) { registration = 'warning: ' + e.message; }
        }
        const tok = await tesla.exchangeCode(client_id, client_secret, code, redirect_uri, reg);
        if (!tok.refresh_token) return res.status(500).json({ error: 'No refresh_token in token response', body: tok });
        // Surface the account's vehicles right away (the fresh access token can read them).
        let vehicles = [];
        try {
          vehicles = (await tesla.listVehicles(reg, tok.access_token))
            .map((v) => ({ vin: v.vin, display_name: v.display_name, state: v.state }));
        } catch (e) { /* non-fatal: onboarding still succeeded */ }
        res.json({ refresh_token: tok.refresh_token, registration, vehicles });
      } catch (e) {
        res.status(500).json({ error: e.message, status: e.status, body: e.body });
      }
    });
};
