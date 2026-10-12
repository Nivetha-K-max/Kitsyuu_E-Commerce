/* A local stand-in for a Redis REST API (the Upstash /pipeline protocol), for tests only: INCR and EXPIRE in memory, bearer
   token checked. Test controls on the object: state.down (answer 503), state.garbage (answer nonsense), keys (the counters),
   requests (how many calls arrived), bodies (what was sent).
   Usage: const redis = await startFakeRedisRest({token}); … redis.url … await redis.close(); */
import http from 'node:http';

export async function startFakeRedisRest({token, port = 0} = {}) {
  if (!token) throw new Error('token required');
  const keys = new Map(), expiries = new Map(), bodies = [];
  const state = {down: false, garbage: false, requests: 0};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      state.requests++;
      const send = (status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
      if (state.down) return send(503, {error: 'down'});
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, {error: 'Unauthorized'});
      if (req.method !== 'POST' || req.url !== '/pipeline') return send(404, {error: 'not found'});
      if (state.garbage) return send(200, {hello: 'world'});
      let commands; try { commands = JSON.parse(raw); } catch { return send(400, {error: 'bad json'}); }
      bodies.push(raw);
      send(200, commands.map(([cmd, key, arg]) => {
        if (cmd === 'INCR') { const n = (keys.get(key) ?? 0) + 1; keys.set(key, n); return {result: n}; }
        if (cmd === 'EXPIRE') { expiries.set(key, Number(arg)); return {result: 1}; }
        return {error: 'ERR unknown command'};
      }));
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${server.address().port}`, state, keys, expiries, bodies,
    reset() { keys.clear(); expiries.clear(); bodies.length = 0; },
    close: () => new Promise(r => server.close(r))};
}
