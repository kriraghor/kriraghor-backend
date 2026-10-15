'use strict';

/**
 * SSLCommerz-compatible simulator (dev, tests and k3d only; config refuses PAYMENTS_SIMULATOR in
 * production). It speaks the same endpoints and field names as the SSLCommerz sandbox, so the real
 * adapter (sslcommerz.js) runs unchanged against it:
 *   POST /dev/sslcommerz/gwprocess/v4/api.php          session → GatewayPageURL (our hosted pay page)
 *   GET  /dev/sslcommerz/pay/:sessionkey                the pay page: Pay, Pay without IPN, Wrong amount, Decline, Cancel
 *   POST /dev/sslcommerz/pay/:sessionkey                performs the outcome: sends the signed IPN, then 303 to success/fail/cancel URL
 *   GET  /dev/sslcommerz/validator/api/validationserverAPI.php        validation by val_id
 *   GET  /dev/sslcommerz/validator/api/merchantTransIDvalidationAPI.php  query by tran_id, refund, refund status
 *
 * State lives in Redis (pods are stateless) under <prefix>:sslsim:*, kept for 7 days. Tests use the
 * in-process `transport` and `setIpnSender` instead of HTTP.
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../../config');
const logger = require('../../common/logger');
const { getRedis } = require('../../common/redis');
const { toTakaString, fromTakaString, format } = require('../../common/money');

const TTL_S = 7 * 24 * 3600;
const K = (s) => `${config.redis.prefix}:sslsim:${s}`;
const rand = (n = 10) => crypto.randomBytes(n).toString('hex');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

async function load(key) {
  const raw = await getRedis().get(K(key));
  return raw ? JSON.parse(raw) : null;
}
const save = (key, value) => getRedis().set(K(key), JSON.stringify(value), 'EX', TTL_S);

const store = () => config.payments.sslcommerz;
const credsOk = (f) => f.store_id === store().storeId && f.store_passwd === store().storePassword;

// ---------------------------------------------------------------- IPN delivery
const fetchIpn = async (url, body) => {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(body), signal: AbortSignal.timeout(10000) });
  return res.status;
};
/**
 * IPNs for this API are handed to the webhook handler in-process (inside a pod, the public API host is
 * not reachable as itself); any other ipn_url gets a real POST.
 */
const defaultIpn = async (url, body) => {
  if (!url.startsWith(config.apiPublicUrl)) return fetchIpn(url, body);
  try {
    await require('../../modules/payments/payments.service').handleIpn(body);
    return 200;
  } catch (err) {
    return err.status ?? 500;
  }
};
let ipnSender = defaultIpn;
const setIpnSender = (fn) => {
  ipnSender = fn ?? defaultIpn;
};

/** Signs an IPN the way SSLCommerz does (verify_key + verify_sign). */
function sign(body) {
  const keys = Object.keys(body);
  const data = { ...body, store_passwd: md5(store().storePassword) };
  const text = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('&');
  return { ...body, verify_key: keys.join(','), verify_sign: md5(text) };
}

// ---------------------------------------------------------------- core
async function initSession(f) {
  if (!credsOk(f)) return { status: 'FAILED', failedreason: 'Store Credential Error Or Store is De-active' };
  if (!f.tran_id || !f.total_amount || !f.success_url || !f.ipn_url) return { status: 'FAILED', failedreason: 'Missing required fields' };
  const sessionkey = `SIM${rand(12).toUpperCase()}`;
  const session = {
    sessionkey,
    tran_id: f.tran_id,
    amount: toTakaString(fromTakaString(f.total_amount)),
    currency: f.currency || 'BDT',
    product_name: f.product_name,
    multi_card_name: f.multi_card_name || '',
    success_url: f.success_url,
    fail_url: f.fail_url,
    cancel_url: f.cancel_url,
    ipn_url: f.ipn_url,
    value_a: f.value_a,
    status: 'PENDING',
  };
  await save(`session:${sessionkey}`, session);
  await save(`tran:${f.tran_id}`, { sessionkey });
  return { status: 'SUCCESS', sessionkey, GatewayPageURL: `${store().baseUrl}/pay/${sessionkey}` };
}

const CARD = {
  bkash: { card_type: 'BKASH-BKash', card_no: '01711XXXX4321', card_issuer: 'BKash Mobile Banking', card_brand: 'MOBILEBANKING' },
  nagad: { card_type: 'NAGAD-Nagad', card_no: '01811XXXX8765', card_issuer: 'Nagad', card_brand: 'MOBILEBANKING' },
  card: { card_type: 'VISA-Dutch Bangla', card_no: '432149XXXXXX0667', card_issuer: 'Dutch Bangla Bank', card_brand: 'VISA' },
};
const cardFor = (multi) => (multi.includes('bkash') ? CARD.bkash : multi.includes('nagad') ? CARD.nagad : CARD.card);

const OUTCOMES = ['success', 'success_no_ipn', 'wrong_amount', 'fail', 'cancel'];

/** Performs a payer's choice on the pay page. Returns the URL the browser goes to next. */
async function pay(sessionkey, outcome) {
  const s = await load(`session:${sessionkey}`);
  if (!s) throw Object.assign(new Error('Unknown session'), { status: 404 });
  if (s.status !== 'PENDING') return s.redirect;
  if (!OUTCOMES.includes(outcome)) throw Object.assign(new Error('Unknown outcome'), { status: 400 });
  const base = { tran_id: s.tran_id, value_a: s.value_a ?? '', currency: s.currency, tran_date: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  let ipn;
  let url;
  if (outcome === 'fail' || outcome === 'cancel') {
    s.status = outcome === 'fail' ? 'FAILED' : 'CANCELLED';
    ipn = { ...base, status: s.status, amount: s.amount, error: outcome === 'fail' ? 'Declined by the simulator' : 'Cancelled by the payer' };
    url = outcome === 'fail' ? s.fail_url : s.cancel_url;
  } else {
    // wrong_amount: the gateway reports one taka less than asked (M06 §12 #3).
    const amount = outcome === 'wrong_amount' ? toTakaString(Math.max(100, fromTakaString(s.amount) - 100)) : s.amount;
    Object.assign(s, { status: 'VALID', val_id: `sim-val-${rand(8)}`, bank_tran_id: `sim-bt-${rand(8)}`, paid_amount: amount, ...cardFor(s.multi_card_name) });
    await save(`val:${s.val_id}`, { sessionkey });
    ipn = { ...base, status: 'VALID', val_id: s.val_id, amount, store_amount: amount, bank_tran_id: s.bank_tran_id, card_type: s.card_type, card_no: s.card_no, card_issuer: s.card_issuer, card_brand: s.card_brand };
    url = s.success_url;
  }
  const sep = url.includes('?') ? '&' : '?';
  s.redirect = `${url}${sep}tran_id=${encodeURIComponent(s.tran_id)}${s.val_id ? `&val_id=${encodeURIComponent(s.val_id)}` : ''}&status=${s.status}`;
  await save(`session:${sessionkey}`, s);
  if (outcome !== 'success_no_ipn') {
    await Promise.resolve(ipnSender(s.ipn_url, sign(ipn))).catch((err) => logger.warn({ err: err.message }, 'simulator IPN delivery failed'));
  }
  return s.redirect;
}

const element = (s) => ({
  status: s.status === 'VALID' && s.validated ? 'VALIDATED' : s.status,
  tran_id: s.tran_id,
  val_id: s.val_id,
  amount: s.paid_amount ?? s.amount,
  currency: s.currency,
  bank_tran_id: s.bank_tran_id,
  card_type: s.card_type,
  card_no: s.card_no,
});

async function validate(params) {
  if (!credsOk(params)) return { status: 'INVALID_TRANSACTION', error: 'Invalid store credentials' };
  const ref = await load(`val:${params.val_id}`);
  const s = ref && (await load(`session:${ref.sessionkey}`));
  if (!s) return { status: 'INVALID_TRANSACTION' };
  const out = element(s);
  s.validated = true;
  await save(`session:${ref.sessionkey}`, s);
  return out;
}

async function queryTran(params) {
  const ref = await load(`tran:${params.tran_id}`);
  const s = ref && (await load(`session:${ref.sessionkey}`));
  if (!s) return { APIConnect: 'DONE', no_of_trans_found: 0, element: [] };
  return { APIConnect: 'DONE', no_of_trans_found: 1, element: [element(s)] };
}

async function refund(params) {
  const failing = Number(await getRedis().get(K('control:refund_fail'))) || 0;
  if (failing > 0) {
    await getRedis().decr(K('control:refund_fail'));
    return { APIConnect: 'DONE', status: 'failed', errorReason: 'Simulated refund failure' };
  }
  const ref = `sim-rf-${rand(8)}`;
  await save(`refund:${ref}`, { bank_tran_id: params.bank_tran_id, amount: params.refund_amount, refe_id: params.refe_id, status: 'processing' });
  return { APIConnect: 'DONE', status: 'success', refund_ref_id: ref, bank_tran_id: params.bank_tran_id, trans_id: params.refe_id };
}

async function refundStatus(params) {
  const r = await load(`refund:${params.refund_ref_id}`);
  if (!r) return { APIConnect: 'DONE', status: 'cancelled', errorReason: 'Unknown refund reference' };
  // The first status call still says processing; the next one says refunded (exercises polling).
  if (r.status === 'processing') {
    await save(`refund:${params.refund_ref_id}`, { ...r, status: 'refunded' });
    return { APIConnect: 'DONE', status: 'processing', refund_ref_id: params.refund_ref_id };
  }
  return { APIConnect: 'DONE', status: 'refunded', refund_ref_id: params.refund_ref_id, initiated_on: new Date().toISOString() };
}

async function merchantApi(params) {
  if (!credsOk(params)) return { APIConnect: 'INVALID_REQUEST', errorReason: 'Invalid store credentials' };
  if (params.refund_ref_id) return refundStatus(params);
  if (params.bank_tran_id && params.refund_amount) return refund(params);
  return queryTran(params);
}

/** Test and dev controls: make the next `n` refunds fail at the gateway. */
const failNextRefunds = (n) => getRedis().set(K('control:refund_fail'), String(n), 'EX', TTL_S);

/** In-process transport for the adapter (tests): same routing as the HTTP router, no network. */
const transport = {
  async postForm(url, fields) {
    if (url.endsWith('/gwprocess/v4/api.php')) return initSession(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])));
    throw new Error(`Simulator: no POST route for ${url}`);
  },
  async getJson(url, params) {
    if (url.endsWith('/validationserverAPI.php')) return validate(params);
    if (url.endsWith('/merchantTransIDvalidationAPI.php')) return merchantApi(params);
    throw new Error(`Simulator: no GET route for ${url}`);
  },
};

// ---------------------------------------------------------------- HTTP router (dev and k3d)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(s) {
  const button = (outcome, label, style) =>
    `<form method="post" action="${esc(s.sessionkey)}"><input type="hidden" name="outcome" value="${outcome}"><button style="${style}">${esc(label)}</button></form>`;
  const method = s.multi_card_name.includes('bkash') ? 'bKash' : s.multi_card_name.includes('nagad') ? 'Nagad' : 'Card';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SSLCommerz simulator</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f3f1ec;color:#1d2a22;margin:0;padding:24px}main{max-width:420px;margin:0 auto;background:#fff;border:2px solid #1d2a22;padding:24px}
h1{font-size:20px;margin:0 0 4px}p{margin:4px 0}.amt{font-size:32px;font-weight:700;margin:16px 0}form{margin:8px 0}button{width:100%;min-height:48px;font:600 16px system-ui;border:2px solid #1d2a22;cursor:pointer}
.note{font-size:13px;color:#555;margin-top:16px;border-top:1px solid #ccc;padding-top:12px}</style></head>
<body><main><h1>SSLCommerz simulator</h1><p>Kriraghor · not a real payment</p>
<p class="amt">${esc(format(fromTakaString(s.amount)))}</p><p>${esc(s.product_name)}</p><p>Method: ${esc(method)}</p><p>Transaction: <code>${esc(s.tran_id)}</code></p>
${button('success', `Pay with ${method}`, 'background:#0f7a4a;color:#fff')}
${button('success_no_ipn', 'Pay, but lose the IPN', 'background:#fff')}
${button('wrong_amount', 'Pay the wrong amount', 'background:#fff')}
${button('fail', 'Decline', 'background:#fff')}
${button('cancel', 'Cancel', 'background:#fff')}
<p class="note">Dev and test environments only. Real payments go through SSLCommerz.</p></main></body></html>`;
}

function router() {
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
  r.post('/gwprocess/v4/api.php', form, wrap(async (req, res) => res.json(await initSession(req.body))));
  r.get('/pay/:sessionkey', wrap(async (req, res) => {
    const s = await load(`session:${req.params.sessionkey}`);
    if (!s) return res.status(404).type('text/plain').send('Unknown or expired session');
    if (s.status !== 'PENDING') return res.redirect(303, s.redirect);
    // Its own CSP: the form posts to itself and the 303s go to the API, then the web app.
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action *; frame-ancestors 'none'");
    return res.type('html').send(page(s));
  }));
  r.post('/pay/:sessionkey', form, wrap(async (req, res) => res.redirect(303, await pay(req.params.sessionkey, req.body.outcome))));
  r.get('/validator/api/validationserverAPI.php', wrap(async (req, res) => res.json(await validate(req.query))));
  r.get('/validator/api/merchantTransIDvalidationAPI.php', wrap(async (req, res) => res.json(await merchantApi(req.query))));
  r.use((err, _req, res, _next) => res.status(err.status ?? 500).type('text/plain').send(err.message));
  return r;
}

module.exports = { router, transport, setIpnSender, initSession, pay, validate, queryTran, refund, refundStatus, failNextRefunds, OUTCOMES };
