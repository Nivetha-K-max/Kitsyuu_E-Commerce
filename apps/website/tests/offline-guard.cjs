/* Proof that a build or test run stays on this machine (2026-10-08).
   Preloaded into EVERY Node process of the run (the runners, the Next.js servers, the scripts they start):

     NODE_OPTIONS=--require=<absolute path to this file>  OFFLINE_LOG=<file>  KITSYUU_TEST_OFFLINE=1

   Any attempt to open a connection to a host that is not this machine is refused before it leaves the process, and the
   host is written to OFFLINE_LOG (one line per attempt, no path, no credentials). An empty log after a full run means no
   Node process tried to reach another machine. The test browser is covered separately (tests/cdp.mjs: with
   KITSYUU_TEST_OFFLINE=1 Chrome cannot resolve any name but localhost). */
'use strict';
const net = require('node:net'), dns = require('node:dns'), fs = require('node:fs');
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::']);
const isLocal = h => h === undefined || h === null || h === '' || LOCAL.has(String(h).toLowerCase()) || /^127\./.test(String(h));
const note = (kind, host) => { try { if (process.env.OFFLINE_LOG) fs.appendFileSync(process.env.OFFLINE_LOG, `${new Date().toISOString()} ${kind} ${host} (pid ${process.pid}, ${require('node:path').basename(process.argv[1] || 'node')})\n`); } catch {} };
const refused = host => Object.assign(new Error(`offline guard: connection to ${host} refused (this run must stay on this machine)`), {code: 'ENETUNREACH', syscall: 'connect', address: host});

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];          // net passes a normalised [options, cb] array internally
  const opts = first && typeof first === 'object' ? first : {port: first, host: typeof args[1] === 'string' ? args[1] : undefined};
  if (opts && !opts.path && !isLocal(opts.host)) {
    note('connect', opts.host);
    process.nextTick(() => this.destroy(refused(opts.host)));
    return this;
  }
  return connect.apply(this, args);
};
for (const target of [dns, dns.promises]) {
  const lookup = target.lookup;
  target.lookup = function (hostname, ...rest) {
    if (isLocal(hostname)) return lookup.call(this, hostname, ...rest);
    note('lookup', hostname);
    const err = Object.assign(new Error(`offline guard: lookup of ${hostname} refused`), {code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname});
    const cb = rest[rest.length - 1];
    if (typeof cb === 'function') { process.nextTick(cb, err); return {}; }
    return Promise.reject(err);
  };
}
