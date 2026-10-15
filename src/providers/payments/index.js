'use strict';

/**
 * Payment providers (M06 §6.1). One adapter interface hides which provider took the money:
 *   createSession, verify, query, parseWebhook, refund, refundStatus, redactIpn, configured
 * SSLCommerz first (Q9). bKash and Nagad direct adapters come in the second M06 step.
 *
 * When the built-in simulator plays the gateway (dev, tests, k3d), the adapter talks to it in-process;
 * only the payer's browser uses its HTTP pages.
 */
const config = require('../../config');
const sslcommerz = require('./sslcommerz');

const ADAPTERS = { sslcommerz };

if (config.payments.sslcommerz.inProcess) {
  sslcommerz.setTransport(require('./sslcommerz.simulator').transport);
}

/** The adapter for a provider code (default: the configured provider). */
function get(code = config.payments.provider) {
  const adapter = ADAPTERS[code];
  if (!adapter) throw new Error(`Unknown payment provider: ${code}`);
  return adapter;
}

module.exports = { get, ProviderError: sslcommerz.ProviderError };
