'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('harness works', () => { assert.equal(1 + 1, 2); });

const tesla = require('../lib/tesla-fleet');

test('getByPath reads nested values', () => {
  const o = { charge_state: { battery_level: 48, charging_state: 'Charging' } };
  assert.equal(tesla.getByPath(o, 'charge_state.battery_level'), 48);
  assert.equal(tesla.getByPath(o, 'charge_state.charging_state'), 'Charging');
});

test('getByPath returns undefined for missing path', () => {
  assert.equal(tesla.getByPath({}, 'a.b.c'), undefined);
  assert.equal(tesla.getByPath(null, 'a'), undefined);
});

test('convertValue metric: miles to km', () => {
  const r = tesla.convertValue(100, 'mi', 'metric');
  assert.equal(r.unit, 'km');
  assert.ok(Math.abs(r.value - 160.9344) < 1e-6);
});

test('convertValue imperial: celsius to fahrenheit', () => {
  const r = tesla.convertValue(20, 'C', 'imperial');
  assert.equal(r.unit, 'F');
  assert.equal(r.value, 68);
});

test('convertValue as-reported and non-convertibles pass through', () => {
  assert.deepEqual(tesla.convertValue(48, '%', 'metric'), { value: 48, unit: '%' });
  assert.deepEqual(tesla.convertValue(20, 'C', 'metric'), { value: 20, unit: 'C' });
  assert.deepEqual(tesla.convertValue(100, 'mi', 'as-reported'), { value: 100, unit: 'mi' });
});

test('convertValue handles null value', () => {
  assert.deepEqual(tesla.convertValue(null, 'mi', 'metric'), { value: null, unit: 'mi' });
});

const metrics = require('../lib/metrics');

test('catalog: every entry has the required shape', () => {
  assert.ok(metrics.METRICS.length >= 100);
  const groups = new Set(['charge_state','climate_state','vehicle_state','drive_state','gui_settings','vehicle_config']);
  for (const m of metrics.METRICS) {
    assert.ok(m.key && m.label && m.path, `entry missing fields: ${JSON.stringify(m)}`);
    assert.ok(groups.has(m.group), `bad group: ${m.group}`);
    assert.ok(['number','boolean','string','object','array'].includes(m.type), `bad type: ${m.key}`);
    assert.ok(['vehicle_device_data','vehicle_location'].includes(m.scope), `bad scope: ${m.key}`);
    assert.ok(m.path.startsWith(m.group + '.'), `path/group mismatch: ${m.key}`);
  }
});

test('catalog: keys are unique', () => {
  const keys = metrics.METRICS.map(m => m.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('catalog: getMetric looks up by key', () => {
  assert.equal(metrics.getMetric('battery_level').path, 'charge_state.battery_level');
  assert.equal(metrics.getMetric('nope'), undefined);
});

test('ALL_ENDPOINTS lists the six domains', () => {
  assert.equal(typeof tesla.ALL_ENDPOINTS, 'string');
  for (const d of ['charge_state','climate_state','drive_state','vehicle_state','gui_settings','vehicle_config']) {
    assert.ok(tesla.ALL_ENDPOINTS.includes(d), `missing ${d}`);
  }
});
