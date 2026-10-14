'use strict';

const client = require('prom-client');

// One registry per process. Each entrypoint labels itself through the "process" default label.
const registry = new client.Registry();
let defaultsOn = false;

function initMetrics(processName) {
  registry.setDefaultLabels({ app: 'kriraghor-backend', process: processName });
  if (!defaultsOn) {
    client.collectDefaultMetrics({ register: registry });
    defaultsOn = true;
  }
}

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const socketConnections = new client.Gauge({
  name: 'realtime_socket_connections',
  help: 'Open Socket.IO connections on this pod',
  registers: [registry],
});

const jobsTotal = new client.Counter({
  name: 'worker_jobs_total',
  help: 'Jobs processed by this worker',
  labelNames: ['queue', 'name', 'result'],
  registers: [registry],
});

/** Records latency by matched route, never the raw URL, to keep label cardinality low. */
function httpMetrics(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}

module.exports = { registry, initMetrics, httpMetrics, socketConnections, jobsTotal };
