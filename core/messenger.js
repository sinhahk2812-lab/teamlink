'use strict';
// The messenger engine: presence, conversations, reliable delivery, groups, files.
// It has no UI and no Electron dependency, so it can also run headless (see cli.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const nodeCrypto = require('crypto');
const C = require('./crypto');
const { Store } = require('./store');
const { Lan } = require('./lan');
const { RelayClient } = require('./relay-client');

const HELLO_EVERY = 20000;
const LAN_STALE = 70000;
const CHUNK = 60 * 1024;
const AUTO_IMAGE_MAX = 10 * 1024 * 1024;
const OUTBOX_TTL = 7 * 24 * 3600 * 1000;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// Turn a sender-supplied file name into a safe relative path (no traversal, no odd characters).
function safeRelPath(name) {
  const parts = String(name || '').split(/[\\/]+/)
    .map((p) => p.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '').replace(/[. ]+$/, '').slice(0, 120))
    .filter(Boolean);
  return parts.length ? parts.slice(-12) : ['file'];
}

function uniquePath(dir, rel) {
  const target = path.join(dir, ...rel);
  if (!fs.existsSync(target)) return target;
  // De-duplicate on the top-level entry so a re-downloaded folder stays together.
  const ext = rel.length === 1 ? path.extname(rel[0]) : '';
  const base = rel.length === 1 ? rel[0].slice(0, rel[0].length - ext.length) : rel[0];
  for (let i = 2; ; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`, ...rel.slice(1));
    if (!fs.existsSync(cand)) return cand;
  }
}

class Messenger extends EventEmitter {
  constructor(dataDir, overrides = {}) {
    super();
    this.dataDir = dataDir;
    fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'outgoing'), { recursive: true });
    this.cfgPath = path.join(dataDir, 'config.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.cfgPath, 'utf8')); } catch {}
    this.cfg = {
      name: os.userInfo().username, dept: '', status: 'online', absenceMsg: '',
      teamCode: '', relayUrl: '', relayToken: '', extraPeers: [], popup: true, askSave: true,
      udpPort: 24250, tcpPort: 0, downloadDir: path.join(os.homedir(), 'Downloads', 'TeamLink'),
      ...saved, ...overrides,
    };
    if (!this.cfg.identity) { this.cfg.identity = C.generateIdentity(); }
    this.saveCfg();
    this.me = this.cfg.identity;
    this.store = new Store(dataDir);
    this.peers = new Map();
    for (const p of this.store.peers()) this.peers.set(p.id, { id: p.id, pub: p.pub, name: p.name, dept: p.dept, host: p.host, lastSeen: p.last_seen, status: 'online', absenceMsg: '', lan: null, relay: false });
    if (!this.store.conv('all')) this.store.saveConv({ id: 'all', type: 'all', name: 'Everyone', members: [], updated: 0 });
    this.keys = new Map();
    this.flushing = new Set();
    this.downloads = new Map();   // xid -> incoming transfer
    this.autoReplied = new Set(); // peers that already got the absence auto-reply
    this.timers = [];
  }

  saveCfg() {
    fs.writeFileSync(this.cfgPath, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
  }

  ev(name, data) { this.emit('event', name, data); }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    await this.startNet();
    this.timers.push(setInterval(() => this.tick(), 10000));
    this.timers.push(setInterval(() => this.hello('hello'), HELLO_EVERY));
  }

  async startNet() {
    this.tKey = C.teamKey(this.cfg.teamCode);
    this.keys.clear();
    this.lan = new Lan({
      udpPort: this.cfg.udpPort, tcpPort: this.cfg.tcpPort, extraPeers: this.cfg.extraPeers,
      handshake: () => Buffer.from(JSON.stringify({ id: this.me.id, pub: this.me.pub })),
      checkHandshake: (buf) => {
        try {
          const h = JSON.parse(buf.toString());
          if (!C.isValidPub(h.pub) || C.idFromPub(h.pub) !== h.id || h.id === this.me.id) return null;
          this.knowPeer(h.id, h.pub);
          return h.id;
        } catch { return null; }
      },
    });
    this.lan.on('packet', (msg, rinfo) => this.onPresence(msg.toString(), 'lan', rinfo));
    this.lan.on('frame', (from, buf) => this.onFrame(from, buf));
    this.lan.on('warn', (w) => this.ev('warn', w));
    // No team code, no network: the app stays completely silent (no discovery, no listening port, no relay)
    // until the user enters the team's code. There is no shared default that an outsider could use.
    this.locked = !this.cfg.teamCode;
    if (!this.locked) await this.lan.start();

    this.relay = new RelayClient({ url: this.cfg.relayUrl, token: this.cfg.relayToken, room: C.roomId(this.tKey), id: this.me.id });
    this.relay.on('status', () => {
      if (!this.relay.connected) this.dropRelayPeers();
      this.ev('net', this.netState());
    });
    this.relay.on('joined', () => this.hello('hello', 'relay'));
    this.relay.on('pres', (data) => this.onPresence(String(data), 'relay'));
    this.relay.on('frame', (from, buf) => this.onFrame(from, buf));
    this.relay.on('left', (id) => { const p = this.peers.get(id); if (p && p.relay) { p.relay = false; this.pushPeers(); } });
    if (!this.locked) this.relay.start();
    this.hello('hello');
  }

  async stopNet() {
    this.hello('bye');
    await new Promise((r) => setTimeout(r, 80)); // let the goodbye leave before the sockets close
    this.lan.stop(); this.lan.removeAllListeners();
    this.relay.stop(); this.relay.removeAllListeners();
    for (const p of this.peers.values()) { p.lan = null; p.relay = false; }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    await this.stopNet();
    this.store.close();
  }

  dropRelayPeers() {
    let changed = false;
    for (const p of this.peers.values()) if (p.relay) { p.relay = false; changed = true; }
    if (changed) this.pushPeers();
  }

  tick() {
    const now = Date.now();
    let changed = false;
    for (const p of this.peers.values()) {
      if (p.lan && now - p.lan.seen > LAN_STALE) { p.lan = null; changed = true; }
      if (this.isOnline(p)) this.flush(p.id);
    }
    if (changed) this.pushPeers();
    this.store.expireOutbox(now - OUTBOX_TTL);
  }

  // ------------------------------------------------------------------ presence
  hello(type, only, target) {
    const body = JSON.stringify({
      v: 1, t: type, id: this.me.id, pub: this.me.pub, name: this.cfg.name, dept: this.cfg.dept,
      host: os.hostname(), port: this.lan.tcpPort, st: this.cfg.status, am: this.cfg.absenceMsg, ts: Date.now(),
    });
    const pkt = JSON.stringify({ b: body, m: C.mac(this.tKey, body) });
    if (target && target.rinfo) return this.lan.sendTo(Buffer.from(pkt), target.rinfo.address, target.rinfo.port);
    if (target && target.relayTo) return this.relay.presence(pkt, target.relayTo);
    if (only !== 'relay') this.lan.broadcast(Buffer.from(pkt));
    if (only !== 'lan') this.relay.presence(pkt);
  }

  onPresence(text, via, rinfo) {
    let p;
    try {
      const pkt = JSON.parse(text);
      if (typeof pkt.b !== 'string' || !C.macEqual(pkt.m, C.mac(this.tKey, pkt.b))) return; // other team / tampered
      p = JSON.parse(pkt.b);
    } catch { return; }
    if (p.v !== 1 || p.id === this.me.id || !C.isValidPub(p.pub) || C.idFromPub(p.pub) !== p.id) return;
    const peer = this.knowPeer(p.id, p.pub);
    const wasOnline = this.isOnline(peer);
    if (p.t === 'bye') {
      if (via === 'lan') peer.lan = null; else peer.relay = false;
    } else {
      peer.name = clip(p.name, 40) || 'Unknown';
      peer.dept = clip(p.dept, 40);
      peer.host = clip(p.host, 60);
      peer.status = p.st === 'away' ? 'away' : 'online';
      peer.absenceMsg = clip(p.am, 200);
      peer.lastSeen = Date.now();
      if (via === 'lan') peer.lan = { addr: rinfo.address, port: Number(p.port) | 0, seen: Date.now() };
      else peer.relay = true;
      this.store.upsertPeer(peer);
      if (p.t === 'hello') this.hello('ack', null, via === 'lan' ? { rinfo } : { relayTo: p.id });
    }
    this.pushPeers();
    if (!wasOnline && this.isOnline(peer)) this.flush(peer.id);
  }

  knowPeer(id, pub, name) {
    let p = this.peers.get(id);
    if (!p) {
      p = { id, pub, name: name || null, dept: '', host: '', status: 'online', absenceMsg: '', lan: null, relay: false, lastSeen: null };
      this.peers.set(id, p);
      this.store.upsertPeer(p);
    }
    return p;
  }

  isOnline(p) { return !!p && (!!p.lan || (p.relay && this.relay.connected)); }

  peerView(p) {
    return { id: p.id, name: p.name || 'User ' + p.id.slice(0, 6), dept: p.dept || '', host: p.host || '',
      status: p.status, absenceMsg: p.absenceMsg, online: this.isOnline(p), via: p.lan ? 'lan' : p.relay ? 'relay' : null, lastSeen: p.lastSeen };
  }

  pushPeers() {
    clearTimeout(this._peerTimer);
    this._peerTimer = setTimeout(() => this.ev('peers', [...this.peers.values()].map((p) => this.peerView(p))), 60);
  }

  netState() {
    return { locked: this.locked, relay: this.locked ? 'off' : this.relay.state, relayError: this.relay.error, lan: this.lan.udpOk, tcpPort: this.lan.tcpPort };
  }

  // ------------------------------------------------------------------ encrypted transport
  key(peerId) {
    let k = this.keys.get(peerId);
    if (!k) {
      const p = this.peers.get(peerId);
      if (!p) return null;
      k = C.pairKey(this.me.priv, p.pub, this.tKey);
      this.keys.set(peerId, k);
    }
    return k;
  }

  async sendRaw(peerId, plain) {
    const p = this.peers.get(peerId), key = this.key(peerId);
    if (!p || !key) return false;
    const sealed = C.seal(key, plain);
    if (p.lan) {
      if (await this.lan.send(peerId, p.lan.addr, p.lan.port, sealed)) return true;
      p.lan = null; // unreachable; it will come back with its next hello
      this.pushPeers();
    }
    if (p.relay) return this.relay.sendTo(peerId, sealed);
    return false;
  }

  sendJson(peerId, obj) {
    return this.sendRaw(peerId, Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(obj))]));
  }

  // Reliable delivery: keep the frame in the outbox until the peer acknowledges it.
  deliver(peerId, frame) {
    this.store.queue(frame.id, peerId, frame);
    if (this.isOnline(this.peers.get(peerId))) this.flush(peerId);
  }

  async flush(peerId) {
    if (this.flushing.has(peerId)) return;
    this.flushing.add(peerId);
    try {
      for (const row of this.store.pendingFor(peerId)) {
        if (!(await this.sendJson(peerId, row.frame))) break;
      }
    } finally {
      this.flushing.delete(peerId);
    }
  }

  onFrame(from, sealed) {
    const key = this.key(from);
    const plain = key && C.open(key, sealed);
    if (!plain || !plain.length) return;
    if (plain[0] === 1) return this.onChunk(from, plain);
    let f;
    try { f = JSON.parse(plain.subarray(1).toString()); } catch { return; }
    try {
      const handler = { msg: this.onMsg, ack: this.onAck, read: this.onRead, group: this.onGroup, fget: this.onFileGet, fend: this.onFileEnd }[f.t];
      if (handler) handler.call(this, from, f);
    } catch (e) {
      this.ev('warn', 'frame error: ' + e.message);
    }
  }

  ack(to, id) { this.sendJson(to, { t: 'ack', id }); }

  onAck(from, f) {
    this.store.dequeue(String(f.id), from);
    const m = this.store.markDelivered(String(f.id), from);
    if (m) this.ev('message', this.msgView(m));
  }

  // ------------------------------------------------------------------ messages
  recipientsOf(conv) {
    if (conv.type === 'dm') return [conv.id.slice(3)];
    if (conv.type === 'all') return [...this.peers.keys()];
    return conv.members.map((m) => m.id).filter((id) => id !== this.me.id);
  }

  ensureDm(peerId) {
    const id = 'dm:' + peerId;
    if (!this.store.conv(id)) this.store.saveConv({ id, type: 'dm', members: [], updated: Date.now() });
    return id;
  }

  async send({ conv: convId, text, sealed, locked, replyTo, paths, auto }) {
    if (convId.startsWith('dm:')) { if (!this.peers.has(convId.slice(3))) throw new Error('Unknown member'); this.ensureDm(convId.slice(3)); }
    const conv = this.store.conv(convId);
    if (!conv) throw new Error('Unknown conversation');
    if (conv.left_group) throw new Error('You are no longer in this group');
    const body = String(text || '').slice(0, 20000);
    const files = [];
    for (const p of paths || []) this.collectFiles(p, files);
    if (!body.trim() && !files.length) throw new Error('Nothing to send');
    if (files.length > 2000) throw new Error('Too many files (max 2000 per message)');
    const id = C.rid(), ts = Date.now();
    const recipients = this.recipientsOf(conv);
    // A locked message is a sealed message that additionally needs the receiver's own password to open.
    const isLocked = !!locked && conv.type === 'dm';
    const isSealed = (!!sealed || isLocked) && conv.type === 'dm';
    let quote = null;
    const q = replyTo ? this.store.message(String(replyTo)) : null;
    if (q && q.conv === convId && !q.sealed) quote = { id: q.id, sender: q.sender, text: q.body.trim().slice(0, 200) || 'Attachment' };
    this.store.addMessage({ id, conv: convId, sender: this.me.id, ts, body, sealed: isSealed, locked: isLocked, quote, opened: 1, auto, recipients });
    for (const f of files) this.store.saveFile({ ...f, msg: id, owner: this.me.id, state: 'local' });
    this.store.touchConv(convId, ts);
    const frame = { t: 'msg', id, conv: conv.type === 'dm' ? 'dm' : convId, ts, body, sealed: isSealed, locked: isLocked, quote, auto: !!auto,
      files: files.map(({ fid, name, size, mime }) => ({ fid, name, size, mime })) };
    for (const r of recipients) this.deliver(r, frame);
    const view = this.msgView(this.store.message(id));
    this.ev('message', view);
    this.ev('conv', this.convView(this.store.conv(convId)));
    return view;
  }

  collectFiles(p, out, rel) {
    const st = fs.statSync(p);
    const name = rel || path.basename(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) this.collectFiles(path.join(p, e), out, name + '/' + e);
    } else if (st.isFile()) {
      out.push({ fid: C.rid(), name, size: st.size, mime: IMAGE_MIME[path.extname(p).toLowerCase()] || '', path: p });
    }
  }

  onMsg(from, f) {
    if (typeof f.id !== 'string' || f.id.length > 64) return;
    let convId;
    if (f.conv === 'dm') convId = this.ensureDm(from);
    else if (f.conv === 'all') convId = 'all';
    else {
      const g = this.store.conv(String(f.conv));
      // Unknown group: do not ack, the sender retries and the group definition arrives meanwhile.
      if (!g || g.type !== 'group' || g.left_group || !g.members.some((m) => m.id === from)) return;
      convId = g.id;
    }
    const ts = Math.min(Number(f.ts) || Date.now(), Date.now());
    const sealed = !!f.sealed && f.conv === 'dm';
    const files = Array.isArray(f.files) ? f.files.slice(0, 2000) : [];
    let quote = null;
    if (f.quote && typeof f.quote === 'object' && /^[0-9a-f]{20}$/.test(String(f.quote.sender))) {
      quote = { id: String(f.quote.id || '').slice(0, 64), sender: f.quote.sender, text: String(f.quote.text || '').slice(0, 200) };
    }
    const fresh = this.store.addMessage({ id: f.id, conv: convId, sender: from, ts, body: String(f.body || '').slice(0, 20000), sealed,
      locked: sealed && !!f.locked, quote, auto: !!f.auto, unread: 1 });
    this.ack(from, f.id);
    if (!fresh) return;
    for (const x of files) {
      if (typeof x.fid !== 'string' || !/^[0-9a-f]{8,64}$/.test(x.fid) || this.store.file(x.fid)) continue;
      const mime = Object.values(IMAGE_MIME).includes(x.mime) ? x.mime : '';
      this.store.saveFile({ fid: x.fid, msg: f.id, owner: from, name: clip(x.name, 400) || 'file', size: Math.max(0, Number(x.size) || 0), mime, state: 'remote' });
    }
    this.store.touchConv(convId, Date.now());
    const m = this.store.message(f.id);
    if (!sealed) this.autoFetchImages(m);
    this.ev('message', this.msgView(m));
    this.ev('conv', this.convView(this.store.conv(convId)));
    this.ev('incoming', { conv: convId, from, id: f.id });

    // Absence mode: answer once per person, never answer an auto-reply (ping-pong protection).
    if (f.conv === 'dm' && !f.auto && this.cfg.status === 'away' && this.cfg.absenceMsg && !this.autoReplied.has(from)) {
      this.autoReplied.add(from);
      this.send({ conv: convId, text: this.cfg.absenceMsg, auto: true }).catch(() => {});
    }
  }

  autoFetchImages(m) {
    for (const f of this.store.filesOf(m.id)) {
      if (f.state === 'remote' && f.mime && f.size <= AUTO_IMAGE_MAX) this.download(f.fid).catch(() => {});
    }
  }

  // ---- lock password (for opening locked messages). Only a salted scrypt hash is stored.
  lockHash(password, salt) { return nodeCrypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 32).toString('hex'); }

  checkLockPassword(password) {
    const l = this.cfg.lock;
    if (!l) return false;
    const a = Buffer.from(this.lockHash(password, l.salt), 'hex'), b = Buffer.from(l.hash, 'hex');
    return a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
  }

  setLockPassword({ current, next }) {
    if (this.cfg.lock && !this.checkLockPassword(current || '')) throw new Error('The current password is wrong');
    if (String(next || '').length < 4) throw new Error('The password must be at least 4 characters long');
    const salt = nodeCrypto.randomBytes(16).toString('hex');
    this.cfg.lock = { salt, hash: this.lockHash(next, salt) };
    this.saveCfg();
    this.ev('me', this.meView());
  }

  openSealed(id, password) {
    const m = this.store.message(id);
    if (!m || !m.sealed || m.opened || m.sender === this.me.id) return;
    if (m.locked) {
      if (!this.cfg.lock) throw new Error('Set your lock password first');
      if (!this.checkLockPassword(password || '')) throw new Error('Wrong password');
    }
    this.store.run('UPDATE messages SET opened=1, read_at=? WHERE id=?', Date.now(), id);
    this.deliver(m.sender, { t: 'read', id: 'r:' + id, mid: id });
    const fresh = this.store.message(id);
    this.autoFetchImages(fresh);
    this.ev('message', this.msgView(fresh));
    this.ev('conv', this.convView(this.store.conv(m.conv)));
  }

  // "Seen" notices. One frame may confirm several messages; `mid` is the older single-message form.
  onRead(from, f) {
    this.ack(from, f.id);
    const ids = Array.isArray(f.mids) ? f.mids.slice(0, 500) : [f.mid];
    for (const id of ids) {
      const m = this.store.message(String(id));
      if (!m || m.sender !== this.me.id || !m.recipients.includes(from) || m.read_by.includes(from)) continue;
      m.read_by.push(from);
      this.store.run('UPDATE messages SET read_by=?, read_at=COALESCE(read_at, ?) WHERE id=?', JSON.stringify(m.read_by), Date.now(), m.id);
      this.ev('message', this.msgView(this.store.message(m.id)));
      // IP Messenger style "opened" notice for sealed messages
      if (m.sealed) this.ev('opened', { conv: m.conv, by: from, id: m.id, preview: m.body.trim().slice(0, 80) || 'Attachment' });
    }
  }

  // Called when the user is actually looking at the conversation: clears the unread count
  // and tells each sender that their messages were seen.
  markRead(convId) {
    const bySender = new Map();
    for (const m of this.store.unreadMessages(convId)) {
      if (m.sealed && !m.opened) continue; // a sealed message counts as seen only when it is opened
      if (!bySender.has(m.sender)) bySender.set(m.sender, []);
      bySender.get(m.sender).push(m.id);
    }
    if (!this.store.markRead(convId)) return;
    for (const [sender, mids] of bySender) {
      if (this.peers.has(sender)) this.deliver(sender, { t: 'read', id: 'r:' + C.rid(8), mids });
    }
    this.ev('conv', this.convView(this.store.conv(convId)));
  }

  msgView(m) {
    const hidden = m.sealed && !m.opened && m.sender !== this.me.id;
    const files = hidden ? [] : this.store.filesOf(m.id).map((f) => ({
      fid: f.fid, name: f.name, size: f.size, image: !!f.mime, state: f.state, path: f.state === 'local' || f.state === 'done' ? f.path : null,
    }));
    return { id: m.id, conv: m.conv, sender: m.sender, mine: m.sender === this.me.id, ts: m.ts, body: hidden ? '' : m.body,
      sealed: !!m.sealed, locked: !!m.locked, quote: hidden ? null : m.quote, hidden, auto: !!m.auto, files, recipients: m.recipients.length, delivered: m.delivered.length, seen: m.read_by.length, readAt: m.read_at };
  }

  convView(c) {
    const last = this.store.lastMessage(c.id);
    let preview = '';
    if (last) {
      if (last.sealed && !last.opened && last.sender !== this.me.id) preview = 'Sealed message';
      else preview = last.body.trim().slice(0, 80) || (this.store.filesOf(last.id).length ? 'Attachment' : '');
    }
    return { id: c.id, type: c.type, name: c.name, members: c.members.map((m) => ({ id: m.id, name: m.name })), left: !!c.left_group,
      updated: c.updated, unread: this.store.unread(c.id), last: last ? { sender: last.sender, ts: last.ts, preview } : null };
  }

  // ------------------------------------------------------------------ groups
  memberInfo(id) {
    if (id === this.me.id) return { id, name: this.cfg.name, pub: this.me.pub };
    const p = this.peers.get(id);
    if (!p) throw new Error('Unknown member');
    return { id, name: p.name || '', pub: p.pub };
  }

  publishGroup(conv, audience) {
    this.store.saveConv(conv);
    const frame = { t: 'group', id: `gv:${conv.id}:${conv.version}:${C.rid(4)}`, gid: conv.id, name: conv.name, members: conv.members, version: conv.version };
    for (const id of audience) if (id !== this.me.id) this.deliver(id, frame);
    const view = this.convView(this.store.conv(conv.id));
    this.ev('conv', view);
    return view;
  }

  createGroup({ name, members }) {
    const ids = [...new Set([this.me.id, ...(members || [])])];
    if (ids.length < 2) throw new Error('Pick at least one member');
    const conv = { id: 'g:' + C.rid(8), type: 'group', name: clip(name, 60) || 'New group', members: ids.map((id) => this.memberInfo(id)), version: 1, updated: Date.now() };
    return this.publishGroup(conv, ids);
  }

  updateGroup({ conv: convId, name, members }) {
    const conv = this.store.conv(convId);
    if (!conv || conv.type !== 'group' || conv.left_group) throw new Error('Unknown group');
    const before = conv.members.map((m) => m.id);
    if (name !== undefined) conv.name = clip(name, 60) || conv.name;
    if (members) conv.members = [...new Set([this.me.id, ...members])].map((id) => conv.members.find((m) => m.id === id) || this.memberInfo(id));
    conv.version += 1;
    conv.updated = Date.now();
    return this.publishGroup(conv, new Set([...before, ...conv.members.map((m) => m.id)]));
  }

  leaveGroup(convId) {
    const conv = this.store.conv(convId);
    if (!conv || conv.type !== 'group' || conv.left_group) return;
    const before = conv.members.map((m) => m.id);
    conv.members = conv.members.filter((m) => m.id !== this.me.id);
    conv.version += 1;
    conv.left_group = 1;
    this.publishGroup(conv, before);
  }

  onGroup(from, f) {
    if (typeof f.gid !== 'string' || !/^g:[0-9a-f]{16}$/.test(f.gid) || !Array.isArray(f.members) || f.members.length > 500) return;
    const members = [];
    for (const m of f.members) {
      if (!m || !C.isValidPub(m.pub) || C.idFromPub(m.pub) !== m.id) return;
      members.push({ id: m.id, name: clip(m.name, 40), pub: m.pub });
    }
    const existing = this.store.conv(f.gid);
    // Only members may change a group; a brand new group must include its sender.
    const allowed = existing ? existing.members.some((m) => m.id === from) : members.some((m) => m.id === from);
    this.ack(from, f.id);
    if (!allowed || (existing && Number(f.version) <= existing.version)) return;
    for (const m of members) if (m.id !== this.me.id) { const p = this.knowPeer(m.id, m.pub, m.name); if (!p.name && m.name) { p.name = m.name; this.store.upsertPeer(p); } }
    const amMember = members.some((m) => m.id === this.me.id);
    if (!existing && !amMember) return;
    this.store.saveConv({ id: f.gid, type: 'group', name: clip(f.name, 60) || 'Group', members, version: Number(f.version) || 1,
      left_group: amMember ? 0 : 1, updated: existing ? existing.updated : Date.now() });
    this.ev('conv', this.convView(this.store.conv(f.gid)));
    this.pushPeers();
  }

  deleteConversation(convId) {
    const conv = this.store.conv(convId);
    if (!conv || conv.type === 'all') return;
    if (conv.type === 'group' && !conv.left_group) this.leaveGroup(convId);
    this.store.deleteConv(convId);
    this.ev('convDeleted', convId);
  }

  // ------------------------------------------------------------------ files
  // Pull model, like IP Messenger: the message only announces files, the receiver asks for the data.
  async download(fid, saveAs) {
    const f = this.store.file(fid);
    if (!f || f.owner === this.me.id) throw new Error('Unknown file');
    if (f.state === 'done' && f.path && fs.existsSync(f.path)) return;
    if ([...this.downloads.values()].some((d) => d.fid === fid)) return;
    if (!this.isOnline(this.peers.get(f.owner))) throw new Error('The sender is offline right now');
    const rel = safeRelPath(f.name);
    const auto = !!f.mime && f.size <= AUTO_IMAGE_MAX;
    // saveAs: the place the user picked in the "Save as" dialog; otherwise the default download folder.
    const target = saveAs && path.isAbsolute(saveAs) ? saveAs
      : auto ? path.join(this.dataDir, 'files', fid + path.extname(rel[rel.length - 1]).toLowerCase())
        : uniquePath(this.cfg.downloadDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const xid = C.rid(8);
    const d = { xid, fid, from: f.owner, target, tmp: target + '.part', size: f.size, got: 0, seq: 0, last: Date.now(), shown: 0 };
    d.out = fs.createWriteStream(d.tmp);
    d.out.on('error', (e) => this.endDownload(d, e.message));
    d.watch = setInterval(() => { if (Date.now() - d.last > 30000) this.endDownload(d, 'Transfer timed out'); }, 5000);
    this.downloads.set(xid, d);
    this.fileState(f, 'downloading', 0);
    if (!(await this.sendJson(f.owner, { t: 'fget', fid, xid }))) this.endDownload(d, 'The sender is offline right now');
  }

  // Save a copy of a file that is already on this computer (an image shown in the chat) somewhere the user chose.
  async saveCopy(fid, target) {
    const f = this.store.file(String(fid));
    if (!f || !f.path || !['local', 'done'].includes(f.state) || !fs.existsSync(f.path)) throw new Error('The file is not on this computer yet');
    if (!target || !path.isAbsolute(target)) throw new Error('Choose where to save the file');
    await fs.promises.copyFile(f.path, target);
    return target;
  }

  fileState(f, state, progress, error) {
    if (state !== 'downloading') this.store.saveFile({ ...f, state });
    this.ev('file', { fid: f.fid, msg: f.msg, state, progress, error, path: state === 'done' ? f.path : null });
  }

  onChunk(from, plain) {
    if (plain.length < 13) return;
    const d = this.downloads.get(plain.subarray(1, 9).toString('hex'));
    if (!d || d.from !== from) return;
    const seq = plain.readUInt32BE(9), data = plain.subarray(13);
    if (seq !== d.seq++ || d.got + data.length > d.size) return this.endDownload(d, 'Transfer corrupted');
    d.got += data.length;
    d.last = Date.now();
    d.out.write(data);
    if (d.last - d.shown > 200) {
      d.shown = d.last;
      const f = this.store.file(d.fid);
      this.ev('file', { fid: d.fid, msg: f.msg, state: 'downloading', progress: d.size ? d.got / d.size : 1 });
    }
  }

  onFileEnd(from, f) {
    const d = this.downloads.get(String(f.xid));
    if (!d || d.from !== from) return;
    if (!f.ok) return this.endDownload(d, clip(f.error, 100) || 'Transfer failed');
    if (d.got !== d.size) return this.endDownload(d, 'Transfer incomplete');
    this.endDownload(d, null);
  }

  endDownload(d, error) {
    if (!this.downloads.delete(d.xid)) return;
    clearInterval(d.watch);
    const f = this.store.file(d.fid);
    d.out.end(() => {
      if (error) {
        fs.rm(d.tmp, { force: true }, () => {});
        return this.fileState(f, 'remote', 0, error);
      }
      try { fs.renameSync(d.tmp, d.target); } catch (e) { return this.fileState(f, 'remote', 0, e.message); }
      this.fileState({ ...f, path: d.target }, 'done', 1);
    });
  }

  async onFileGet(from, req) {
    const xid = String(req.xid);
    if (!/^[0-9a-f]{16}$/.test(xid)) return;
    const fail = (error) => this.sendJson(from, { t: 'fend', xid, ok: false, error });
    const f = this.store.file(String(req.fid));
    const m = f && this.store.message(f.msg);
    // Only people the message was addressed to may fetch its attachments.
    if (!f || f.owner !== this.me.id || !m || !m.recipients.includes(from)) return fail('File not available');
    let fd;
    try {
      fd = await fs.promises.open(f.path, 'r');
      if ((await fd.stat()).size !== f.size) throw new Error('changed');
      const head = Buffer.alloc(13);
      head[0] = 1;
      Buffer.from(xid, 'hex').copy(head, 1);
      const buf = Buffer.alloc(CHUNK);
      let seq = 0, pos = 0;
      while (pos < f.size) {
        const { bytesRead } = await fd.read(buf, 0, CHUNK, pos);
        if (!bytesRead) throw new Error('short read');
        head.writeUInt32BE(seq++, 9);
        if (!(await this.sendRaw(from, Buffer.concat([head, buf.subarray(0, bytesRead)])))) return;
        pos += bytesRead;
      }
      await this.sendJson(from, { t: 'fend', xid, ok: true });
    } catch {
      fail('The file was moved or changed on the sender\'s computer');
    } finally {
      if (fd) await fd.close().catch(() => {});
    }
  }

  // ------------------------------------------------------------------ settings & queries
  setProfile({ name, dept, status, absenceMsg }) {
    if (name !== undefined) this.cfg.name = clip(name, 40) || this.cfg.name;
    if (dept !== undefined) this.cfg.dept = clip(dept, 40);
    if (status !== undefined) { this.cfg.status = status === 'away' ? 'away' : 'online'; this.autoReplied.clear(); }
    if (absenceMsg !== undefined) this.cfg.absenceMsg = clip(absenceMsg, 200);
    this.saveCfg();
    this.hello('hello');
    this.ev('me', this.meView());
  }

  async setConfig({ teamCode, relayUrl, relayToken, extraPeers, downloadDir, popup, askSave }) {
    const c = this.cfg;
    if (askSave !== undefined) c.askSave = !!askSave;
    if (popup !== undefined) c.popup = !!popup;
    const netBefore = JSON.stringify([c.teamCode, c.relayUrl, c.relayToken, c.extraPeers]);
    if (teamCode !== undefined) {
      const code = String(teamCode).trim().slice(0, 100);
      if (code.length < 8) throw new Error('The team code must be at least 8 characters long');
      c.teamCode = code;
    }
    if (relayUrl !== undefined) {
      const u = String(relayUrl).trim();
      if (u && !/^wss?:\/\/[^\s]+$/i.test(u)) throw new Error('Relay address must start with ws:// or wss://');
      c.relayUrl = u;
    }
    if (relayToken !== undefined) c.relayToken = String(relayToken).trim().slice(0, 200);
    if (extraPeers !== undefined) c.extraPeers = (Array.isArray(extraPeers) ? extraPeers : String(extraPeers).split(/[\s,]+/)).map((s) => String(s).trim()).filter((s) => /^[\w.-]+(:\d+)?$/.test(s)).slice(0, 200);
    if (downloadDir) c.downloadDir = String(downloadDir);
    this.saveCfg();
    if (netBefore !== JSON.stringify([c.teamCode, c.relayUrl, c.relayToken, c.extraPeers])) {
      await this.stopNet();
      await this.startNet();
      this.pushPeers();
    }
    this.ev('me', this.meView());
    this.ev('net', this.netState());
  }

  meView() {
    const c = this.cfg;
    return { id: this.me.id, name: c.name, dept: c.dept, status: c.status, absenceMsg: c.absenceMsg, host: os.hostname(), hasLock: !!c.lock,
      config: { teamCode: c.teamCode, relayUrl: c.relayUrl, relayToken: c.relayToken, extraPeers: c.extraPeers, downloadDir: c.downloadDir, udpPort: c.udpPort, popup: c.popup !== false, askSave: c.askSave !== false } };
  }

  getState() {
    return { me: this.meView(), net: this.netState(), peers: [...this.peers.values()].map((p) => this.peerView(p)),
      convs: this.store.convs().map((c) => this.convView(c)) };
  }

  getMessages({ conv, before, limit }) {
    return this.store.messages(String(conv), before, Math.min(Number(limit) || 60, 200)).map((m) => this.msgView(m));
  }

  search({ text }) {
    const q = String(text || '').trim();
    if (q.length < 2) return [];
    return this.store.search(q, 80).map((m) => this.msgView(m));
  }
}

module.exports = { Messenger, safeRelPath };
