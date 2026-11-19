'use strict';
// Local-only API for the UI: static files, RPC + events over WebSocket, uploads and file access.
// Bound to 127.0.0.1 and protected by a random token, a Host check and an Origin check.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { safeRelPath } = require('./messenger');

const UI_DIR = path.join(__dirname, '..', 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const INLINE_IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

function startServer(messenger, { port = 0, token } = {}) {
  token = token || crypto.randomBytes(24).toString('hex');
  const clients = new Set();
  let listenPort = 0;

  const tokenOk = (t) => typeof t === 'string' && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  const hostOk = (req) => [`127.0.0.1:${listenPort}`, `localhost:${listenPort}`].includes(req.headers.host);
  const originOk = (req) => !req.headers.origin || [`http://127.0.0.1:${listenPort}`, `http://localhost:${listenPort}`].includes(req.headers.origin);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!hostOk(req) || !originOk(req)) return json(403, { error: 'forbidden' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'POST' && url.pathname === '/upload') {
      if (!tokenOk(url.searchParams.get('token'))) return json(403, { error: 'forbidden' });
      const rel = safeRelPath(url.searchParams.get('name'));
      const dir = path.join(messenger.dataDir, 'outgoing', crypto.randomBytes(8).toString('hex'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, rel[rel.length - 1]);
      const out = fs.createWriteStream(file);
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) req.destroy(); });
      req.pipe(out);
      out.on('finish', () => json(200, { path: file }));
      const fail = () => { out.destroy(); fs.rm(dir, { recursive: true, force: true }, () => {}); };
      req.on('aborted', fail); req.on('error', fail);
      return;
    }

    // The user's own chat wallpaper: a picture kept in the data folder.
    // Profile pictures: POST /avatar sets mine, GET /avatar/<id> shows anyone's.
    if (url.pathname === '/avatar' && req.method === 'POST') {
      if (!tokenOk(url.searchParams.get('token'))) return json(403, { error: 'forbidden' });
      const chunks = []; let size = 0, tooBig = false;
      req.on('data', (c) => { size += c.length; if (size > 200 * 1024) { tooBig = true; req.destroy(); } else chunks.push(c); });
      req.on('end', () => { if (tooBig) return; try { messenger.setAvatar(Buffer.concat(chunks)); json(200, { ok: true }); } catch (e) { json(400, { error: e.message }); } });
      return;
    }
    if (url.pathname.startsWith('/avatar/') && req.method === 'GET') {
      if (!tokenOk(url.searchParams.get('token'))) return json(403, { error: 'forbidden' });
      const id = url.pathname.slice(8);
      const file = /^[0-9a-f]{20}$/.test(id) ? messenger.avatarPath(id) : '';
      const buf = file && fs.existsSync(file) ? fs.readFileSync(file) : null;
      const kind = buf && messenger.constructor.imageKind(buf);
      if (!kind) return json(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': kind, 'content-length': buf.length });
      return res.end(buf);
    }

    if (url.pathname === '/wallpaper') {
      if (!tokenOk(url.searchParams.get('token'))) return json(403, { error: 'forbidden' });
      const file = messenger.wallpaperPath();
      const WALL = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1 };
      if (req.method === 'POST') {
        const type = String(req.headers['content-type'] || '').split(';')[0];
        if (!WALL[type]) return json(400, { error: 'Use a PNG, JPG or WebP picture' });
        const chunks = []; let size = 0, tooBig = false;
        req.on('data', (c) => { size += c.length; if (size > 20 * 1024 * 1024) { tooBig = true; req.destroy(); } else chunks.push(c); });
        req.on('end', () => {
          if (tooBig) return;
          fs.writeFileSync(file, Buffer.concat(chunks));
          messenger.cfg.wallType = type;
          messenger.setAppearance({ wall: 'image', wallVer: Date.now() % 1e9 });
          json(200, { ok: true });
        });
        return;
      }
      if (req.method === 'GET' && fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': WALL[messenger.cfg.wallType] ? messenger.cfg.wallType : 'image/png', 'content-length': fs.statSync(file).size });
        return fs.createReadStream(file).pipe(res);
      }
      return json(404, { error: 'not found' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
      if (!tokenOk(url.searchParams.get('token'))) return json(403, { error: 'forbidden' });
      const f = messenger.store.file(url.pathname.slice(6));
      if (!f || !f.path || !['local', 'done'].includes(f.state) || !fs.existsSync(f.path)) return json(404, { error: 'not found' });
      const inline = INLINE_IMAGES[path.extname(f.path).toLowerCase()];
      const headers = { 'content-length': fs.statSync(f.path).size, 'content-type': (!url.searchParams.get('dl') && inline) || 'application/octet-stream' };
      if (!inline || url.searchParams.get('dl')) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f.name))}`;
      res.writeHead(200, headers);
      return fs.createReadStream(f.path).pipe(res);
    }

    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
      const file = path.join(UI_DIR, name);
      if (!TYPES[path.extname(name)] || !fs.existsSync(file)) return json(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)], 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*" });
      return fs.createReadStream(file).pipe(res);
    }
    json(405, { error: 'method not allowed' });
  });

  const wss = new WebSocket.Server({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, sock, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || !hostOk(req) || !originOk(req) || !tokenOk(url.searchParams.get('token'))) return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => {});
      ws.on('message', async (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        try {
          const result = await rpc(m.method, m.params || {});
          ws.send(JSON.stringify({ id: m.id, result: result === undefined ? null : result }));
        } catch (e) {
          ws.send(JSON.stringify({ id: m.id, error: e.message || 'failed' }));
        }
      });
    });
  });

  const methods = {
    getState: () => messenger.getState(),
    getMessages: (p) => messenger.getMessages(p),
    send: (p) => messenger.send({ conv: String(p.conv), text: p.text, sealed: p.sealed, locked: p.locked, replyTo: p.replyTo, sub: p.sub || undefined, paths: (p.paths || []).map(String) }),
    markRead: (p) => messenger.markRead(String(p.conv), p.sub ? String(p.sub) : undefined),
    createSub: (p) => messenger.createSub(p),
    deleteSub: (p) => messenger.deleteSub(p),
    setBackupKey: (p) => messenger.setBackupKey(p),
    createBackup: (p) => messenger.createBackup(p.target ? String(p.target) : undefined),
    restoreBackup: (p) => messenger.restoreBackup(p),
    openSealed: (p) => messenger.openSealed(String(p.id), p.password),
    setLockPassword: (p) => messenger.setLockPassword(p),
    downloadAll: (p) => messenger.downloadAll(String(p.msg), p.dir ? String(p.dir) : undefined),
    forward: (p) => messenger.forward({ id: p.id, convs: p.convs }),
    saveCopy: (p) => messenger.saveCopy(String(p.fid), String(p.saveAs || '')),
    download: (p) => messenger.download(String(p.fid), p.saveAs ? String(p.saveAs) : undefined),
    search: (p) => messenger.search(p),
    createGroup: (p) => messenger.createGroup(p),
    updateGroup: (p) => messenger.updateGroup(p),
    leaveGroup: (p) => messenger.leaveGroup(String(p.conv)),
    deleteConversation: (p) => messenger.deleteConversation(String(p.conv)),
    removeAvatar: () => messenger.setAvatar(null),
    setPopupPrefs: (p) => messenger.setPopupPrefs(p),
    setRecentEmoji: (p) => messenger.setRecentEmoji(p.list),
    setAppearance: (p) => messenger.setAppearance(p),
    setProfile: (p) => messenger.setProfile(p),
    setConfig: (p) => messenger.setConfig(p),
    refresh: () => messenger.hello('hello'),
  };
  async function rpc(method, params) {
    if (!Object.prototype.hasOwnProperty.call(methods, method)) throw new Error('Unknown method');
    return methods[method](params);
  }

  messenger.on('event', (event, data) => {
    const text = JSON.stringify({ event, data });
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(text);
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    listenPort = server.address().port;
    resolve({ port: listenPort, token, url: `http://127.0.0.1:${listenPort}/?token=${token}`,
      close: () => { for (const ws of clients) ws.terminate(); wss.close(); server.close(); } });
  }));
}

module.exports = { startServer };
