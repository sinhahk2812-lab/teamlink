'use strict';
// TeamLink relay: a tiny WebSocket forwarder for team members who are not on the office LAN.
// It never sees message contents (everything is end-to-end encrypted by the clients) and stores nothing.
//
//   PORT=8080 RELAY_TOKEN=some-secret node relay/server.js
//
// Put it behind HTTPS (nginx / Caddy / any PaaS) and give clients the wss:// URL.
const http = require('http');
const WebSocket = require('ws');

function startRelay({ port = 8080, host = '0.0.0.0', token = '' } = {}) {
  const rooms = new Map(); // room -> Map<id, ws>
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('TeamLink relay OK\n');
  });
  const wss = new WebSocket.Server({ server, maxPayload: 512 * 1024 });

  wss.on('connection', (ws) => {
    let room = null, id = null;
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const joinTimer = setTimeout(() => { if (!id) ws.close(); }, 10000);
    const send = (sock, obj) => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj)); };

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return ws.close(); }
      if (!id) {
        if (m.t !== 'join' || !/^[0-9a-f]{32}$/.test(m.room) || !/^[0-9a-f]{20}$/.test(m.id)) return ws.close();
        if (token && m.token !== token) { send(ws, { t: 'error', msg: 'wrong relay token' }); return ws.close(); }
        clearTimeout(joinTimer);
        room = rooms.get(m.room) || rooms.set(m.room, new Map()).get(m.room);
        id = m.id;
        const old = room.get(id);
        room.set(id, ws);
        if (old && old !== ws) old.close();
        return send(ws, { t: 'joined' });
      }
      if (m.t === 'pres') {
        if (m.to) { const peer = room.get(m.to); if (peer) send(peer, { t: 'pres', from: id, data: m.data }); }
        else for (const [pid, peer] of room) if (pid !== id) send(peer, { t: 'pres', from: id, data: m.data });
      } else if (m.t === 'msg' && typeof m.to === 'string') {
        const peer = room.get(m.to);
        if (peer) send(peer, { t: 'msg', from: id, data: m.data });
        else send(ws, { t: 'gone', id: m.to });
      }
    });

    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (!id || room.get(id) !== ws) return;
      room.delete(id);
      for (const peer of room.values()) send(peer, { t: 'left', id });
      for (const [name, r] of rooms) if (!r.size) rooms.delete(name);
    });
  });

  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch {}
    }
  }, 30000);

  return new Promise((resolve) => server.listen(port, host, () => resolve({
    port: server.address().port,
    close: () => { clearInterval(sweep); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); },
  })));
}

module.exports = { startRelay };

if (require.main === module) {
  startRelay({ port: Number(process.env.PORT) || 8080, token: process.env.RELAY_TOKEN || '' })
    .then((r) => console.log(`TeamLink relay listening on :${r.port}` + (process.env.RELAY_TOKEN ? ' (token required)' : ' (no token set)')));
}
