'use strict';
module.exports = function (RED) {
  function MultiMetricNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.cfg = RED.nodes.getNode(config.config);
    node.metrics = Array.isArray(config.metrics) ? config.metrics : [];
    node.vehicleVin = config.vehicle || '';        // '' = the account's first vehicle
    node.emitMode = config.emitMode || 'every';
    node.unitSystem = config.unitSystem || '';
    node.lastJson = undefined;
    if (!node.cfg) { node.status({ fill: 'red', shape: 'ring', text: 'no config' }); return; }

    node.emitFromSnapshot = function (send, msg) {
      const out = {}; let stale = true, lastUpdated = null;
      node.metrics.forEach(k => {
        const r = node.cfg.getValue(node.vehicleVin, k, node.unitSystem || undefined);
        out[k] = r.value; stale = stale && r.stale; lastUpdated = r.lastUpdated;
      });
      const json = JSON.stringify(out);
      if (node.emitMode === 'change' && json === node.lastJson && !msg) return;
      node.lastJson = json;
      const m = msg || {}; m.payload = out; m.stale = stale; m.last_updated = lastUpdated;
      (send || node.send).call(node, m);
      node.status({ fill: stale ? 'grey' : 'green', shape: stale ? 'ring' : 'dot',
        text: node.metrics.length + ' metric(s)' + (stale ? ' (stale)' : '') });
    };

    node.cfg.subscribe(node);
    // Input triggers a fresh on-demand read (still never wakes the car — poll()
    // checks the free /vehicles state first), then emits the latest values.
    node.on('input', function (msg, send, done) {
      Promise.resolve(node.cfg.poll(true)).catch(function () {}).then(function () {
        node.emitFromSnapshot(send, msg);
        if (done) done();
      });
    });
    node.on('close', function () { node.cfg.unsubscribe(node); });
  }
  RED.nodes.registerType('tesla-fleet-multiple-metrics', MultiMetricNode);
};
