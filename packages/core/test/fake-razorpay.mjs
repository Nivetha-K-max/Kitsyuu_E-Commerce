/* A local stand-in for Razorpay's API and Checkout, for tests only (no real payments, no network).
   - REST: POST /v1/orders, GET /v1/payments/:id, POST /v1/payments/:id/capture, GET /v1/orders/:id/payments
     (Basic auth with the test key id/secret, amounts in paise, same field names as Razorpay).
   - Signatures are made exactly like Razorpay's: HMAC-SHA256(order_id|payment_id, key secret) for the checkout handler,
     HMAC-SHA256(raw body, webhook secret) for webhooks.
   - GET /v1/checkout.js: a small `window.Razorpay` with the same options / handler / on('payment.failed') / modal.ondismiss
     contract, rendering buttons the browser tests click: [data-fake-pay=success], [data-fake-pay=fail], [data-fake-dismiss].
   - Test controls: POST /__test/pay {order_id, outcome, capture}, POST /__test/mode {down}, GET /__test/state.
   Usage: const rzp = await startFakeRazorpay({keySecret, webhookSecret}); … rzp.url … await rzp.close(); */
import http from 'node:http';
import {createHmac, randomBytes} from 'node:crypto';

export const TEST_KEY_ID = 'rzp_test_FakeKey000001';

export async function startFakeRazorpay({keyId = TEST_KEY_ID, keySecret, webhookSecret = '', port = 0} = {}) {
  if (!keySecret) throw new Error('keySecret required');
  const orders = new Map(), payments = new Map();
  const state = {down: false, requests: 0};
  const id = prefix => `${prefix}_${randomBytes(7).toString('hex')}`;
  const sign = (orderId, paymentId) => createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const authOk = req => req.headers.authorization === 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  function pay(orderId, outcome = 'success', {capture = true, method = 'upi'} = {}) {
    const o = orders.get(orderId);
    if (!o) throw new Error('unknown order ' + orderId);
    const p = {id: id('pay'), entity: 'payment', order_id: orderId, amount: o.amount, currency: o.currency, method,
      status: outcome === 'success' ? (capture ? 'captured' : 'authorized') : 'failed', captured: outcome === 'success' && capture,
      error_description: outcome === 'success' ? null : 'Your bank declined this payment (test)', created_at: Math.floor(Date.now() / 1000)};
    payments.set(p.id, p);
    if (p.status === 'captured') o.status = 'paid';
    return {payment: p, response: {razorpay_payment_id: p.id, razorpay_order_id: orderId, razorpay_signature: sign(orderId, p.id)}};
  }

  const CHECKOUT_JS = base => `(function(){
  function Razorpay(o){ this.o=o; this.h={}; }
  Razorpay.prototype.on=function(ev,cb){ this.h[ev]=cb; };
  Razorpay.prototype.open=function(){
    var self=this, o=this.o, d=document.createElement('div');
    d.setAttribute('data-fake-razorpay',''); d.setAttribute('role','dialog'); d.setAttribute('aria-label','Test payment');
    d.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center';
    d.innerHTML='<div style="background:#fff;color:#000;padding:24px;max-width:320px;font:14px sans-serif"><p>Test payment of '+(o.amount/100)+' '+o.currency+'</p>'
      +'<p data-fake-order>'+o.order_id+'</p><button data-fake-pay="success">Pay</button> <button data-fake-pay="fail">Fail</button> <button data-fake-dismiss>Close</button></div>';
    document.body.appendChild(d);
    function done(){ d.remove(); }
    function post(outcome){ return fetch(${JSON.stringify(base)}+'/__test/pay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({order_id:o.order_id,outcome:outcome})}).then(function(r){return r.json();}); }
    d.querySelector('[data-fake-pay=success]').onclick=function(){ post('success').then(function(r){ done(); o.handler(r.response); }); };
    d.querySelector('[data-fake-pay=fail]').onclick=function(){ post('fail').then(function(r){ done(); if(self.h['payment.failed']) self.h['payment.failed']({error:{code:'BAD_REQUEST_ERROR',description:r.payment.error_description,source:'bank',step:'payment_authorization',reason:'payment_failed',metadata:{payment_id:r.payment.id,order_id:o.order_id}}}); }); };
    d.querySelector('[data-fake-dismiss]').onclick=function(){ done(); if(o.modal&&o.modal.ondismiss) o.modal.ondismiss(); };
  };
  window.Razorpay=Razorpay;
})();`;

  const server = http.createServer(async (req, res) => {
    state.requests++;
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, {'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type'});
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, '');
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    try {
      if (url.pathname === '/v1/checkout.js') return send(200, CHECKOUT_JS(`http://${req.headers.host}`), 'application/javascript');
      if (url.pathname === '/__test/pay') return send(200, pay(body.order_id, body.outcome, {capture: body.capture !== false}));
      if (url.pathname === '/__test/mode') { Object.assign(state, body); return send(200, state); }
      if (url.pathname === '/__test/state') return send(200, {...state, orders: [...orders.values()], payments: [...payments.values()]});
      if (state.down) return send(503, {error: {code: 'SERVER_ERROR', description: 'test: service unavailable'}});
      if (!authOk(req)) return send(401, {error: {code: 'BAD_REQUEST_ERROR', description: 'Authentication failed'}});
      let m;
      if (req.method === 'POST' && url.pathname === '/v1/orders') {
        if (!Number.isInteger(body.amount) || body.amount < 100) return send(400, {error: {code: 'BAD_REQUEST_ERROR', description: 'amount must be at least 100'}});
        const o = {id: id('order'), entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt ?? null, status: 'created', notes: body.notes ?? {}};
        orders.set(o.id, o); return send(200, o);
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/payments\/([\w]+)$/))) {
        const p = payments.get(m[1]); return p ? send(200, p) : send(404, {error: {code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist'}});
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/v1\/payments\/([\w]+)\/capture$/))) {
        const p = payments.get(m[1]);
        if (!p || p.status !== 'authorized' || body.amount !== p.amount) return send(400, {error: {code: 'BAD_REQUEST_ERROR', description: 'cannot capture'}});
        p.status = 'captured'; p.captured = true; orders.get(p.order_id).status = 'paid'; return send(200, p);
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/orders\/([\w]+)\/payments$/))) {
        const items = [...payments.values()].filter(p => p.order_id === m[1]); return send(200, {entity: 'collection', count: items.length, items});
      }
      return send(404, {error: {code: 'BAD_REQUEST_ERROR', description: 'not found'}});
    } catch (e) { return send(400, {error: {code: 'BAD_REQUEST_ERROR', description: e.message}}); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  /** A webhook exactly as Razorpay sends it: event id header, raw JSON body and its signature. */
  function webhook(event, payment, eventId = id('evt')) {
    const rawBody = JSON.stringify({entity: 'event', account_id: 'acc_test', event, contains: ['payment'], payload: {payment: {entity: payment}}, created_at: Math.floor(Date.now() / 1000)});
    return {rawBody, eventId, signature: createHmac('sha256', webhookSecret).update(rawBody).digest('hex')};
  }
  return {url, keyId, orders, payments, state, pay, sign, webhook, close: () => new Promise(r => server.close(r))};
}

// CLI (browser tests): node fake-razorpay.mjs <port>  — reads RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET from the environment.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const r = await startFakeRazorpay({keySecret: process.env.RAZORPAY_KEY_SECRET, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET, port: Number(process.argv[2] || 0)});
  console.log(`fake razorpay listening on ${r.url}`);
}
