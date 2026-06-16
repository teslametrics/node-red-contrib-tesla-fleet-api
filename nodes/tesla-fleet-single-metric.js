'use strict';
module.exports = function (RED) {
  function SingleMetricNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.cfg = RED.nodes.getNode(config.config);
    // NB: use `metricKey`, not `metric` — Node-RED's Node prototype has a built-in
    // `node.metric()` method (metrics logging); assigning a string to it breaks input.
    node.metricKey = config.metric || 'battery_level';
    node.vehicleVin = config.vehicle || '';        // '' = the account's first vehicle
    node.format = config.format || 'naked';        // naked | named | value
    node.emitMode = config.emitMode || 'every';    // every | change
    node.unitSystem = config.unitSystem || '';     // '' = inherit config
    node.lastVal = undefined;
    if (!node.cfg) { node.status({ fill: 'red', shape: 'ring', text: 'no config' }); return; }

    node.emitFromSnapshot = function (send, msg) {
      const r = node.cfg.getValue(node.vehicleVin, node.metricKey, node.unitSystem || undefined);
      if (node.emitMode === 'change' && r.value === node.lastVal && !msg) return;
      node.lastVal = r.value;
      const m = msg || {};
      if (node.format === 'named') m.payload = { [node.metricKey]: r.value };
      else if (node.format === 'value') m.payload = { value: r.value };
      else m.payload = r.value;
      m.metric = node.metricKey; m.unit = r.unit; m.stale = r.stale; m.last_updated = r.lastUpdated;
      (send || node.send).call(node, m);
      node.status({ fill: r.stale ? 'grey' : 'green', shape: r.stale ? 'ring' : 'dot',
        text: (r.value == null ? '—' : r.value) + (r.unit ? ' ' + r.unit : '') + (r.stale ? ' (stale)' : '') });
    };

    node.cfg.subscribe(node);                       // emit on each refresh
    // Input triggers a fresh on-demand read (still never wakes the car — poll()
    // checks the free /vehicles state first), then emits the latest value.
    node.on('input', function (msg, send, done) {
      Promise.resolve(node.cfg.poll(true)).catch(function () {}).then(function () {
        node.emitFromSnapshot(send, msg);
        if (done) done();
      });
    });
    node.on('close', function () { node.cfg.unsubscribe(node); });
  }
  RED.nodes.registerType('tesla-fleet-single-metric', SingleMetricNode);
};
