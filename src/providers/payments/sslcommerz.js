'use strict';

/**
 * SSLCommerz adapter (M06 §6.1, Q9: aggregator first). Endpoints used:
 *   POST {base}/gwprocess/v4/api.php                                   create a session → GatewayPageURL
 *   GET  {base}/validator/api/validationserverAPI.php?val_id=…          validate a payment (authoritative, FR-03)
 *   GET  {base}/validator/api/merchantTransIDvalidationAPI.php?tran_id=  query by our transaction id
 *   GET  {base}/validator/api/merchantTransIDvalidationAPI.php?bank_tran_id=&refund_amount=…   refund
 *   GET  {base}/validator/api/merchantTransIDvalidationAPI.php?refund_ref_id=…                 refund status
 * Our tran_id is the payment attempt id, so every IPN and query maps to exactly one attempt.
 *
 * IPN signature (verify_sign): md5 of the keys named in verify_key plus md5(store_passwd), sorted by
 * key and joined as k=v&…. A good signature is necessary but never sufficient: every success is
 * re-checked with the validation API (FR-03).
 *
 * The HTTP client is pluggable (setTransport) so tests can route calls into the simulator in-process.
 */
const crypto = require('crypto');
const config = require('../../config');
const { toTakaString, fromTakaString } = require('../../common/money');

const code = 'sslcommerz';
const TIMEOUT_MS = 15000;

class ProviderError extends Error {
  constructor(message, { retryable = true, code: errCode = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.retryable = retryable;
    this.code = errCode;
  }
}

const fetchTransport = {
  async postForm(url, fields) {
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams(fields), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new ProviderError(`SSLCommerz answered ${res.status}`);
    return res.json();
  },
  async getJson(url, params) {
    const res = await fetch(`${url}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new ProviderError(`SSLCommerz answered ${res.status}`);
    return res.json();
  },
};
let transport = fetchTransport;
const setTransport = (t) => {
  transport = t ?? fetchTransport;
};

const store = () => config.payments.sslcommerz;
const configured = () => Boolean(store().baseUrl && store().storeId && store().storePassword);
const creds = () => ({ store_id: store().storeId, store_passwd: store().storePassword });
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// SSLCommerz `multi_card_name` limits the gateway page to the method the payer picked.
const GATEWAYS = { bkash: 'bkash', nagad: 'nagad', card: 'visacard,mastercard,amexcard' };

/** "BKASH-BKash" / "VISA-Dutch Bangla" + "432149XXXXXX0667" → method and a masked display. */
function methodOf(v) {
  const type = String(v.card_type ?? '').toLowerCase();
  const last4 = /(\d{4})\s*$/.exec(String(v.card_no ?? ''))?.[1];
  if (type.includes('bkash')) return { method: 'bkash', display: last4 ? `bKash ••• ${last4}` : 'bKash' };
  if (type.includes('nagad')) return { method: 'nagad', display: last4 ? `Nagad ••• ${last4}` : 'Nagad' };
  if (/visa|master|amex|card/.test(type)) return { method: 'card', display: last4 ? `Card ••• ${last4}` : 'Card' };
  return { method: 'other', display: v.card_type ? String(v.card_type).slice(0, 40) : 'Other' };
}

const PAID = new Set(['VALID', 'VALIDATED']);

/** Normalise a validation/query element to the M06 VerifyResult. */
function toResult(v) {
  const status = String(v.status ?? '').toUpperCase();
  if (PAID.has(status)) {
    const { method, display } = methodOf(v);
    return {
      status: 'paid',
      amount: fromTakaString(String(v.amount)),
      currency: String(v.currency ?? v.currency_type ?? '').toUpperCase(),
      tranId: v.tran_id,
      valId: v.val_id,
      providerTrxId: v.bank_tran_id ?? null,
      method,
      methodDisplay: display,
    };
  }
  if (status === 'PENDING' || status === 'UNATTEMPTED' || status === 'PROCESSING') return { status: 'pending', tranId: v.tran_id };
  if (status === 'CANCELLED') return { status: 'cancelled', tranId: v.tran_id, reason: 'cancelled' };
  return { status: 'failed', tranId: v.tran_id, reason: status ? status.toLowerCase() : 'unknown' };
}

/**
 * Start a gateway session. `urls` = { success, fail, cancel, ipn }. `customer` = { name, email, phone }:
 * SSLCommerz requires them; they go only to the gateway, never into our logs (the stored request is redacted).
 */
async function createSession({ payment, attempt, method, urls, customer }) {
  if (!configured()) throw new ProviderError('SSLCommerz is not configured', { retryable: false, code: 'PROVIDER_NOT_CONFIGURED' });
  const fields = {
    ...creds(),
    total_amount: toTakaString(payment.amountPoisha),
    currency: 'BDT',
    tran_id: attempt.id,
    success_url: urls.success,
    fail_url: urls.fail,
    cancel_url: urls.cancel,
    ipn_url: urls.ipn,
    multi_card_name: GATEWAYS[method],
    cus_name: customer.name || 'Kriraghor member',
    cus_email: customer.email || 'payments@kriraghor.com',
    cus_phone: customer.phone || '01700000000',
    cus_add1: 'Dhaka',
    cus_city: 'Dhaka',
    cus_country: 'Bangladesh',
    shipping_method: 'NO',
    num_of_item: 1,
    product_name: payment.title,
    product_category: 'service',
    product_profile: 'non-physical-goods',
    value_a: payment.id,
  };
  const res = await transport.postForm(`${store().baseUrl}/gwprocess/v4/api.php`, fields);
  if (String(res.status).toUpperCase() !== 'SUCCESS' || !res.GatewayPageURL) {
    throw new ProviderError(`Session refused: ${res.failedreason ?? res.status}`, { retryable: false, code: 'PROVIDER_REFUSED' });
  }
  return {
    redirectUrl: res.GatewayPageURL,
    providerSessionId: res.sessionkey,
    request: { tran_id: attempt.id, total_amount: fields.total_amount, currency: 'BDT', multi_card_name: fields.multi_card_name },
    response: { status: res.status, sessionkey: res.sessionkey },
  };
}

/** Authoritative check of one payment by val_id (FR-03). */
async function verify({ valId }) {
  const v = await transport.getJson(`${store().baseUrl}/validator/api/validationserverAPI.php`, { val_id: valId, ...creds(), format: 'json' });
  return toResult(v);
}

/** Query by our tran_id (attempt id): used by polling, expiry and reconciliation. */
async function query({ attemptId }) {
  const res = await transport.getJson(`${store().baseUrl}/validator/api/merchantTransIDvalidationAPI.php`, { tran_id: attemptId, ...creds(), format: 'json' });
  const elements = Array.isArray(res.element) ? res.element : [];
  if (!elements.length) return { status: 'not_found', tranId: attemptId };
  const paid = elements.find((e) => PAID.has(String(e.status).toUpperCase()));
  return toResult(paid ?? elements[0]);
}

/** IPN body → { eventId, tranId, valId, status, signatureOk }. */
function parseWebhook(body) {
  const keys = String(body.verify_key ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  let signatureOk = false;
  if (keys.length && body.verify_sign) {
    const data = Object.fromEntries(keys.map((k) => [k, body[k] ?? '']));
    data.store_passwd = md5(store().storePassword);
    const text = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('&');
    signatureOk = md5(text) === String(body.verify_sign);
  }
  return {
    eventId: body.val_id || `${body.tran_id}:${body.status}`,
    tranId: body.tran_id,
    valId: body.val_id || null,
    status: String(body.status ?? '').toUpperCase(),
    signatureOk,
  };
}

/** Start a refund. Returns { status: 'pending' | 'succeeded', providerRefundId }. Throws ProviderError on refusal. */
async function refund({ payment, refund: r }) {
  if (!payment.providerTrxId) throw new ProviderError('No bank transaction id to refund against', { retryable: false, code: 'REFUND_NOT_POSSIBLE' });
  const res = await transport.getJson(`${store().baseUrl}/validator/api/merchantTransIDvalidationAPI.php`, {
    bank_tran_id: payment.providerTrxId,
    refund_amount: toTakaString(r.amountPoisha),
    refund_remarks: r.reasonCode,
    refe_id: r.id,
    ...creds(),
    format: 'json',
  });
  const status = String(res.status ?? '').toLowerCase();
  if (String(res.APIConnect).toUpperCase() !== 'DONE') throw new ProviderError(`Refund API unavailable: ${res.APIConnect}`);
  if (status === 'success' || status === 'processing') return { status: 'pending', providerRefundId: res.refund_ref_id };
  throw new ProviderError(`Refund refused: ${res.errorReason ?? status}`, { retryable: true, code: 'REFUND_REFUSED' });
}

/** Refund status by refund_ref_id → 'succeeded' | 'pending' | 'failed'. */
async function refundStatus({ providerRefundId }) {
  const res = await transport.getJson(`${store().baseUrl}/validator/api/merchantTransIDvalidationAPI.php`, { refund_ref_id: providerRefundId, ...creds(), format: 'json' });
  const status = String(res.status ?? '').toLowerCase();
  if (status === 'refunded') return { status: 'succeeded' };
  if (status === 'processing' || status === 'initiated') return { status: 'pending' };
  return { status: 'failed', reason: res.errorReason ?? status };
}

/** IPN fields we keep (no customer contact details). */
const IPN_KEEP = ['status', 'tran_id', 'val_id', 'amount', 'store_amount', 'currency', 'bank_tran_id', 'card_type', 'card_issuer', 'card_brand', 'tran_date', 'risk_level', 'risk_title', 'value_a', 'verify_key'];
const redactIpn = (body) => Object.fromEntries(IPN_KEEP.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

module.exports = { code, configured, createSession, verify, query, parseWebhook, refund, refundStatus, redactIpn, setTransport, ProviderError, toResult, methodOf };
