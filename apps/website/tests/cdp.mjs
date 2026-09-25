// Minimal headless Chrome driver over CDP (no dependencies).
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// Screenshots and the throwaway Chrome profile live in tests/.output (git-ignored).
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '.output');
fs.mkdirSync(DIR, {recursive: true});
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch(port = 9333) {
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${DIR}/chrome-prof`, '--no-first-run', '--hide-scrollbars', '--disable-gpu', 'about:blank'], {stdio: 'ignore'});
  let list;
  for (let i = 0; i < 50; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.find(t => t.type === 'page')) break; } catch {} await sleep(200); }
  const target = list.find(t => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, {once: true}));
  let id = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const {res, rej} = pending.get(m.id); pending.delete(m.id); m.error ? rej(Error(m.error.message)) : res(m.result); } else listeners.forEach(l => l(m)); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, {res, rej}); ws.send(JSON.stringify({id: i, method, params})); });
  const errors = [];
  listeners.push(m => {
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) errors.push('http ' + m.params.response.status + ' ' + m.params.response.url);
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', {cacheDisabled: true});
  const api = {
    send, errors, on: fn => listeners.push(fn),
    async viewport(width, height, mobile = false) { await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile}); await send('Emulation.setTouchEmulationEnabled', {enabled: mobile}); },
    async goto(url, readyExpr = 'true') {
      errors.length = 0;
      const loaded = new Promise(r => { const l = m => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
      await send('Page.navigate', {url}); await loaded;
      for (let i = 0; i < 50; i++) { if (await api.eval(readyExpr)) break; await sleep(100); }
      await api.eval('document.querySelectorAll("img[loading=lazy]").forEach(i=>i.loading="eager"),Promise.race([new Promise(r=>setTimeout(r,6000)),Promise.all([...document.images].map(i=>i.complete?0:new Promise(r=>{i.addEventListener("load",r);i.addEventListener("error",r)})))])');
      await sleep(250);
    },
    async eval(expression) { const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    async shot(file, full = false) {
      const p = {format: 'png'};
      if (full) { const {cssContentSize: s} = await send('Page.getLayoutMetrics'); p.captureBeyondViewport = true; p.clip = {x: 0, y: 0, width: s.width, height: Math.min(s.height, 9000), scale: 1}; }
      const {data} = await send('Page.captureScreenshot', p); fs.writeFileSync(path.join(DIR, 'shots', file), Buffer.from(data, 'base64'));
    },
    async key(key, code = key, keyCode = 0) { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode: keyCode}); },
    close() { ws.close(); proc.kill(); }
  };
  fs.mkdirSync(path.join(DIR, 'shots'), {recursive: true});
  return api;
}
