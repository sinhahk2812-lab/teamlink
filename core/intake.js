'use strict';
// WhatsApp Intake.
//
// An agent on a member's PC reads that member's work WhatsApp groups and POSTs work messages here.
// TeamLink has no central server, so the design is:
//   * every install can run its own intake endpoint (off until the member switches it on);
//   * each member creates their own API key; only its SHA-256 hash is stored, and the hash is shared with
//     the team so that any running endpoint can tell whose key a request carries (this is what lets one
//     always-on machine serve the whole team later);
//   * items are stored locally and synced to teammates over the normal encrypted channel;
//   * the item id is a hash of (chat, source_id), so the same group message reported by two members
//     becomes one item with two reporters;
//   * "seen" is kept per install (= per user) and never synced; assignee, status, due date and comments are shared.
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const TYPES = ['review', 'update', 'new_task', 'deadline', 'question', 'file'];
const STATUSES = ['new', 'in_progress', 'done'];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
const USER = /^[0-9a-f]{20}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n);
const itemId = (chat, sourceId) => sha(chat.toLowerCase() + '\0' + sourceId).slice(0, 32);

class Intake {
  constructor(messenger) {
    this.m = messenger;
    this.db = messenger.store;
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS intake_items(
        id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, chat TEXT NOT NULL, sender TEXT, title TEXT, type TEXT,
        text TEXT, links TEXT, priority TEXT, msg_time INTEGER, received_at INTEGER, reporters TEXT,
        assignee TEXT, project TEXT, status TEXT, due INTEGER, updated INTEGER, updated_by TEXT, seen INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS intake_items_time ON intake_items(received_at);
      CREATE TABLE IF NOT EXISTS intake_comments(id TEXT PRIMARY KEY, item TEXT NOT NULL, author TEXT, ts INTEGER, text TEXT);
      CREATE TABLE IF NOT EXISTS intake_members(user TEXT PRIMARY KEY, key_hash TEXT, prefix TEXT, enabled INTEGER, last_received INTEGER, updated INTEGER);
      CREATE TABLE IF NOT EXISTS intake_log(ts INTEGER, ip TEXT, user TEXT, status INTEGER, created INTEGER, skipped INTEGER, note TEXT);
    `);
    this.hits = new Map(); // rate limiting: key -> [timestamps]
    this.server = null;
    this.error = '';
  }

  // ------------------------------------------------------------------ configuration
  // Environment variables win over saved settings, so a server deployment needs no UI.
  conf() {
    const c = this.m.cfg.intake || {};
    return {
      enabled: process.env.TEAMLINK_INTAKE === '1' || !!c.enabled,
      host: process.env.TEAMLINK_INTAKE_HOST || c.host || '0.0.0.0',
      port: Number(process.env.TEAMLINK_INTAKE_PORT || c.port) || 24252,
      baseUrl: (process.env.TEAMLINK_INTAKE_BASE_URL || c.baseUrl || '').replace(/\/+$/, ''),
      keyHash: c.keyHash || '', keyPrefix: c.keyPrefix || '', keyMade: c.keyMade || 0, lastReceived: c.lastReceived || 0,
    };
  }
  save(patch) { this.m.cfg.intake = { ...(this.m.cfg.intake || {}), ...patch }; this.m.saveCfg(); }

  team() {
    const t = this.m.cfg.team || {};
    return { admins: Array.isArray(t.admins) ? t.admins.filter((x) => USER.test(x)) : [], enabled: t.enabled !== false, rules: Array.isArray(t.rules) ? t.rules : [], version: Number(t.version) || 0 };
  }
  isAdmin(id) { return this.team().admins.includes(id || this.m.me.id); }

  urls() {
    const c = this.conf();
    if (c.baseUrl) return [c.baseUrl + '/api/intake/whatsapp'];
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${c.port}/api/intake/whatsapp`);
    out.push(`http://127.0.0.1:${c.port}/api/intake/whatsapp`);
    return out;
  }

  ev(kind, extra) { this.m.ev('intake', { kind, ...extra }); }
  everyone() { return [...this.m.peers.keys()]; }
  send(to, frame) { for (const id of to) if (id !== this.m.me.id && this.m.peers.has(id)) this.m.deliver(id, frame); }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    this.m.on('event', (name, peers) => { if (name === 'peers') this.greetNewPeers(peers); });
    if (this.conf().enabled) await this.listen();
  }

  listen() {
    return new Promise((resolve) => {
      if (this.server) return resolve();
      const c = this.conf();
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (e) => { this.error = e.code === 'EADDRINUSE' ? `Port ${c.port} is already in use on this computer` : e.message; this.server = null; this.ev('status'); resolve(); });
      server.listen(c.port, c.host, () => { this.server = server; this.error = ''; this.port = server.address().port; this.ev('status'); resolve(); });
    });
  }

  stop() { if (this.server) { this.server.close(); this.server.closeAllConnections && this.server.closeAllConnections(); this.server = null; } }

  // Members that appear for the first time get our key status and, from an admin, the team settings.
  greetNewPeers(list) {
    this.greeted = this.greeted || new Set();
    for (const p of list) {
      if (!p.online || this.greeted.has(p.id)) continue;
      this.greeted.add(p.id);
      this.send([p.id], this.statusFrame());
      if (this.isAdmin()) this.send([p.id], { t: 'iteam', id: 'iteam:' + crypto.randomBytes(6).toString('hex'), team: this.team() });
    }
  }

  // ------------------------------------------------------------------ my key and my endpoint
  statusFrame() {
    const c = this.conf();
    return { t: 'ikey', id: 'ikey:' + crypto.randomBytes(6).toString('hex'), hash: c.keyHash, prefix: c.keyPrefix, enabled: c.enabled, last: c.lastReceived, ts: Date.now() };
  }
  announce() { this.send(this.everyone(), this.statusFrame()); this.ev('status'); }

  async setEnabled(on) {
    this.save({ enabled: !!on });
    if (on) await this.listen(); else this.stop();
    this.announce();
    return this.state();
  }

  // The key is shown once and never stored; only its hash is kept.
  newKey() {
    const key = 'tlk_' + crypto.randomBytes(32).toString('base64url');
    this.save({ keyHash: sha(key), keyPrefix: key.slice(0, 10), keyMade: Date.now() });
    this.announce();
    return { key };
  }
  revokeKey() { this.save({ keyHash: '', keyPrefix: '', keyMade: 0 }); this.announce(); }

  onKeyStatus(from, f) {
    this.m.ack(from, f.id);
    const row = this.db.get('SELECT updated FROM intake_members WHERE user=?', from);
    if (row && row.updated >= Number(f.ts)) return;
    this.db.run(`INSERT INTO intake_members(user,key_hash,prefix,enabled,last_received,updated) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user) DO UPDATE SET key_hash=excluded.key_hash, prefix=excluded.prefix, enabled=excluded.enabled, last_received=excluded.last_received, updated=excluded.updated`,
      from, /^[0-9a-f]{64}$/.test(f.hash || '') ? f.hash : '', clip(f.prefix, 12), f.enabled ? 1 : 0, Number(f.last) || 0, Number(f.ts) || Date.now());
    this.ev('status');
  }

  // Whose key is this? Mine, or a teammate's whose key hash was shared with the team.
  whoHas(key) {
    const hash = sha(String(key));
    const mine = this.conf();
    const eq = (a) => a.length === hash.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(hash));
    if (mine.keyHash && eq(mine.keyHash)) return { user: this.m.me.id, mine: true };
    // A teammate's key works here whether or not their own PC's endpoint is on: that switch is about their PC, not their key.
    for (const r of this.db.all("SELECT user, key_hash FROM intake_members WHERE key_hash != ''")) if (eq(r.key_hash)) return { user: r.user, mine: false };
    return null;
  }

  // ------------------------------------------------------------------ HTTP endpoint
  limited(bucket, max, windowMs) {
    const now = Date.now();
    const list = (this.hits.get(bucket) || []).filter((t) => now - t < windowMs);
    list.push(now);
    this.hits.set(bucket, list);
    if (this.hits.size > 5000) this.hits.clear();
    return list.length > max;
  }

  log(req, user, status, created, skipped, note) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    this.db.run('INSERT INTO intake_log(ts,ip,user,status,created,skipped,note) VALUES(?,?,?,?,?,?,?)', Date.now(), ip, user || '', status, created || 0, skipped || 0, note || '');
    this.db.run('DELETE FROM intake_log WHERE ts < ?', Date.now() - 30 * 24 * 3600 * 1000);
    console.log(`[intake] ${new Date().toISOString()} ${ip} ${req.method} ${req.url} -> ${status}${user ? ' user=' + user.slice(0, 8) : ''}${note ? ' ' + note : ''}${status === 200 ? ` created=${created} skipped=${skipped}` : ''}`);
  }

  handle(req, res) {
    const reply = (status, body, headers) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(headers || {}) }); res.end(JSON.stringify(body)); };
    const path = (req.url || '').split('?')[0].replace(/\/+$/, '');
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (req.method === 'GET' && path === '/api/intake/health') return reply(200, { ok: true, service: 'teamlink-intake' });
    if (path !== '/api/intake/whatsapp') { this.log(req, '', 404); return reply(404, { error: 'Not found. Use POST /api/intake/whatsapp' }); }
    if (req.method !== 'POST') { this.log(req, '', 405); return reply(405, { error: 'Use POST' }, { allow: 'POST' }); }
    if (this.limited('ip:' + ip, 240, 60000)) { this.log(req, '', 429, 0, 0, 'ip rate limit'); return reply(429, { error: 'Too many requests. Try again in a minute.' }, { 'retry-after': '60' }); }

    const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const who = auth ? this.whoHas(auth[1]) : null;
    if (!who) {
      const blocked = this.limited('bad:' + ip, 20, 60000); // slows down key guessing
      this.log(req, '', blocked ? 429 : 401, 0, 0, auth ? 'unknown key' : 'no key');
      return blocked ? reply(429, { error: 'Too many failed attempts. Try again in a minute.' }, { 'retry-after': '60' })
        : reply(401, { error: 'Missing or invalid API key. Send: Authorization: Bearer <your key>' }, { 'www-authenticate': 'Bearer' });
    }
    if (!this.team().enabled) { this.log(req, who.user, 403, 0, 0, 'team intake disabled'); return reply(403, { error: 'WhatsApp Intake is switched off for the team' }); }
    if (who.mine && !this.conf().enabled) { this.log(req, who.user, 403, 0, 0, 'intake off'); return reply(403, { error: 'Your intake is switched off' }); }
    if (this.limited('key:' + who.user, 60, 60000)) { this.log(req, who.user, 429, 0, 0, 'key rate limit'); return reply(429, { error: 'Rate limit: 60 requests per minute per key.' }, { 'retry-after': '60' }); }

    const chunks = []; let size = 0, tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { tooBig = true; req.destroy(); } else chunks.push(c); });
    req.on('error', () => {});
    req.on('end', () => {
      if (tooBig) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { this.log(req, who.user, 400, 0, 0, 'bad json'); return reply(400, { error: 'Body must be valid JSON' }); }
      const checked = this.validate(body);
      if (checked.error) { this.log(req, who.user, 400, 0, 0, checked.error); return reply(400, checked); }
      try {
        const result = this.ingest(who.user, checked.items);
        this.log(req, who.user, 200, result.created, result.skipped);
        reply(200, result);
      } catch (e) { this.log(req, who.user, 500, 0, 0, e.message); reply(500, { error: 'Could not store the items' }); }
    });
  }

  validate(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return { error: '"items" must be an array' };
    if (!body.items.length || body.items.length > 200) return { error: '"items" must hold 1 to 200 entries' };
    const items = [];
    for (let i = 0; i < body.items.length; i++) {
      const it = body.items[i], bad = (field, why) => ({ error: `items[${i}].${field} ${why}`, index: i, field });
      if (!it || typeof it !== 'object') return { error: `items[${i}] must be an object`, index: i };
      for (const f of ['source_id', 'title', 'from', 'chat', 'time', 'text']) if (typeof it[f] !== 'string' || !it[f].trim()) return bad(f, 'is required (non-empty string)');
      if (it.source_id.length > 200) return bad('source_id', 'is too long (max 200)');
      if (!TYPES.includes(it.type)) return bad('type', 'must be one of: ' + TYPES.join(', '));
      if (it.priority !== undefined && !['high', 'normal'].includes(it.priority)) return bad('priority', 'must be "high" or "normal"');
      if (!ISO.test(it.time) || Number.isNaN(Date.parse(it.time))) return bad('time', 'must be ISO 8601 with a time zone, e.g. 2026-11-19T14:30:00+05:30');
      if (it.links !== undefined && (!Array.isArray(it.links) || it.links.length > 30 || it.links.some((l) => typeof l !== 'string'))) return bad('links', 'must be an array of up to 30 strings');
      const links = (it.links || []).map((l) => l.trim().slice(0, 1000)).filter((l) => /^https?:\/\/\S+$/i.test(l));
      items.push({ source_id: it.source_id.trim(), title: clip(it.title, 200), type: it.type, sender: clip(it.from, 80), chat: clip(it.chat, 120), msg_time: Date.parse(it.time),
        text: String(it.text).slice(0, 8000), links, priority: it.priority === 'high' ? 'high' : 'normal' });
    }
    return { items };
  }

  // ------------------------------------------------------------------ storing and merging
  row(r) {
    if (!r) return r;
    return { ...r, links: JSON.parse(r.links || '[]'), reporters: JSON.parse(r.reporters || '[]'), seen: !!r.seen };
  }
  item(id) { return this.row(this.db.get('SELECT * FROM intake_items WHERE id=?', String(id))); }

  // Mapping rules: who it is assigned to and which project it belongs to.
  route(it, reporter) {
    const rules = this.team().rules, norm = (s) => String(s || '').trim().toLowerCase();
    const bySender = rules.find((r) => r.kind === 'sender' && norm(r.match) === norm(it.sender));
    const byChat = rules.find((r) => r.kind === 'chat' && norm(r.match) === norm(it.chat));
    const known = (u) => (u && (u === this.m.me.id || this.m.peers.has(u)) ? u : '');
    return { assignee: known(bySender && bySender.user) || known(byChat && byChat.user) || reporter, project: clip((byChat && byChat.project) || (bySender && bySender.project) || '', 60) };
  }

  // Who gets a copy: everyone, unless the chat's rule lists specific members.
  audience(it) {
    const rule = this.team().rules.find((r) => r.kind === 'chat' && String(r.match || '').trim().toLowerCase() === it.chat.toLowerCase());
    if (rule && Array.isArray(rule.members) && rule.members.length) return [...new Set([...rule.members, ...it.reporters, it.assignee].filter(Boolean))];
    return this.everyone();
  }

  insert(it) {
    this.db.run(`INSERT INTO intake_items(id,source,source_id,chat,sender,title,type,text,links,priority,msg_time,received_at,reporters,assignee,project,status,due,updated,updated_by,seen)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      it.id, 'whatsapp', it.source_id, it.chat, it.sender, it.title, it.type, it.text, JSON.stringify(it.links), it.priority, it.msg_time, it.received_at,
      JSON.stringify(it.reporters), it.assignee || '', it.project || '', it.status || 'new', it.due || null, it.updated, it.updated_by || '');
  }

  ingest(reporter, items) {
    const out = { created: 0, skipped: 0, ids: [] };
    const now = Date.now();
    for (const src of items) {
      const id = itemId(src.chat, src.source_id);
      out.ids.push(id);
      const have = this.item(id);
      if (have) {
        out.skipped++;
        if (!have.reporters.includes(reporter)) { // same message, another member's agent: record the second reporter
          have.reporters.push(reporter);
          this.db.run('UPDATE intake_items SET reporters=? WHERE id=?', JSON.stringify(have.reporters), id);
          this.send(this.audience(have), this.itemFrame(have));
          this.ev('item', { id });
        }
        continue;
      }
      const it = { ...src, id, received_at: now, reporters: [reporter], status: 'new', due: null, updated: now, updated_by: reporter, ...this.route(src, reporter) };
      this.insert(it);
      out.created++;
      this.send(this.audience(it), this.itemFrame(it));
      this.ev('item', { id });
      this.alert(it, null);
    }
    if (reporter === this.m.me.id) { this.save({ lastReceived: now }); this.announce(); }
    return out;
  }

  itemFrame(it) {
    const { seen, ...shared } = it; // "seen" is per user and stays on this computer
    return { t: 'iitem', id: 'iitem:' + it.id + ':' + crypto.randomBytes(4).toString('hex'), item: shared };
  }

  // An item arriving from a teammate: create it, or merge reporters and the newer shared state.
  onItem(from, f) {
    this.m.ack(from, f.id);
    const x = f.item;
    if (!x || typeof x !== 'object' || !/^[0-9a-f]{32}$/.test(String(x.id)) || !TYPES.includes(x.type)) return;
    const chat = clip(x.chat, 120), sourceId = String(x.source_id || '').slice(0, 200);
    if (itemId(chat, sourceId) !== x.id) return; // the id must really be the hash of (chat, source_id)
    const reporters = (Array.isArray(x.reporters) ? x.reporters : []).filter((u) => USER.test(u)).slice(0, 50);
    const state = { assignee: USER.test(x.assignee) ? x.assignee : '', project: clip(x.project, 60), status: STATUSES.includes(x.status) ? x.status : 'new',
      due: Number(x.due) || null, updated: Number(x.updated) || 0, updated_by: USER.test(x.updated_by) ? x.updated_by : from };
    const have = this.item(x.id);
    if (!have) {
      const it = { id: x.id, source_id: sourceId, chat, sender: clip(x.sender, 80), title: clip(x.title, 200), type: x.type, text: String(x.text || '').slice(0, 8000),
        links: (Array.isArray(x.links) ? x.links : []).filter((l) => typeof l === 'string' && /^https?:\/\/\S+$/i.test(l)).slice(0, 30),
        priority: x.priority === 'high' ? 'high' : 'normal', msg_time: Number(x.msg_time) || Date.now(), received_at: Math.min(Number(x.received_at) || Date.now(), Date.now()),
        reporters: reporters.length ? reporters : [from], ...state };
      this.insert(it);
      this.ev('item', { id: it.id });
      return this.alert(it, null);
    }
    const merged = [...new Set([...have.reporters, ...reporters])];
    if (merged.length !== have.reporters.length) this.db.run('UPDATE intake_items SET reporters=? WHERE id=?', JSON.stringify(merged), have.id);
    this.applyState(have, state);
    this.ev('item', { id: have.id });
  }

  // Shared state is last-writer-wins on (updated, updated_by), so every computer settles on the same value.
  applyState(have, s) {
    if (s.updated < have.updated || (s.updated === have.updated && String(s.updated_by) <= String(have.updated_by))) return false;
    this.db.run('UPDATE intake_items SET assignee=?, project=?, status=?, due=?, updated=?, updated_by=? WHERE id=?', s.assignee, s.project, s.status, s.due, s.updated, s.updated_by, have.id);
    this.alert({ ...have, ...s }, have);
    return true;
  }

  // In-app notification: a new high-priority item, or an item that has just been assigned to me by someone else.
  alert(it, before) {
    const me = this.m.me.id;
    const newlyMine = it.assignee === me && it.updated_by !== me && (!before || before.assignee !== me);
    const urgent = !before && it.priority === 'high';
    if (!newlyMine && !urgent) return;
    if (it.status === 'done') return;
    this.m.ev('intakeAlert', { id: it.id, title: it.title, chat: it.chat, sender: it.sender, reason: newlyMine ? 'assigned' : 'high' });
  }

  // ------------------------------------------------------------------ actions from the UI
  update({ id, assignee, status, due, project }) {
    const have = this.item(id);
    if (!have) throw new Error('Unknown item');
    const s = { assignee: have.assignee, project: have.project, status: have.status, due: have.due };
    if (assignee !== undefined) { if (assignee && assignee !== this.m.me.id && !this.m.peers.has(assignee)) throw new Error('Unknown member'); s.assignee = assignee || ''; }
    if (status !== undefined) { if (!STATUSES.includes(status)) throw new Error('Unknown status'); s.status = status; }
    if (due !== undefined) s.due = due ? Number(due) || Date.parse(due) || null : null;
    if (project !== undefined) s.project = clip(project, 60);
    s.updated = Math.max(Date.now(), have.updated + 1); s.updated_by = this.m.me.id;
    this.db.run('UPDATE intake_items SET assignee=?, project=?, status=?, due=?, updated=?, updated_by=?, seen=1 WHERE id=?', s.assignee, s.project, s.status, s.due, s.updated, s.updated_by, have.id);
    const now = this.item(id);
    this.send([...new Set([...this.audience(now), ...this.audience(have)])], this.itemFrame(now));
    this.ev('item', { id });
    return this.view(now);
  }

  markSeen({ id, all }) {
    if (all) this.db.run('UPDATE intake_items SET seen=1 WHERE seen=0'); else this.db.run('UPDATE intake_items SET seen=1 WHERE id=?', String(id));
    this.ev('seen', { id });
  }

  comment({ id, text }) {
    const have = this.item(id), body = String(text || '').trim().slice(0, 4000);
    if (!have) throw new Error('Unknown item');
    if (!body) throw new Error('Write a comment first');
    const c = { id: crypto.randomBytes(10).toString('hex'), item: have.id, author: this.m.me.id, ts: Date.now(), text: body };
    this.db.run('INSERT INTO intake_comments(id,item,author,ts,text) VALUES(?,?,?,?,?)', c.id, c.item, c.author, c.ts, c.text);
    this.send(this.audience(have), { t: 'icom', id: 'icom:' + c.id, comment: c });
    this.ev('comment', { id: have.id });
    return c;
  }

  onComment(from, f) {
    this.m.ack(from, f.id);
    const c = f.comment;
    if (!c || !/^[0-9a-f]{20}$/.test(String(c.id)) || !this.item(c.item)) return;
    const added = this.db.run('INSERT OR IGNORE INTO intake_comments(id,item,author,ts,text) VALUES(?,?,?,?,?)', c.id, String(c.item), from, Math.min(Number(c.ts) || Date.now(), Date.now()), String(c.text || '').slice(0, 4000)).changes;
    if (added) this.ev('comment', { id: c.item });
  }

  // ------------------------------------------------------------------ queries
  view(r) {
    return { id: r.id, title: r.title, type: r.type, from: r.sender, chat: r.chat, time: r.msg_time, receivedAt: r.received_at, text: r.text, links: r.links, priority: r.priority,
      reporters: r.reporters, assignee: r.assignee, project: r.project, status: r.status, due: r.due, seen: r.seen,
      comments: this.db.get('SELECT COUNT(*) n FROM intake_comments WHERE item=?', r.id).n };
  }

  list({ view, type, sender, chat, status, assignee, q, limit } = {}) {
    const where = [], args = [];
    const add = (sql, ...a) => { where.push(sql); args.push(...a); };
    if (view === 'mine') add('(assignee=? OR (assignee=\'\' AND reporters LIKE ?))', this.m.me.id, `%${this.m.me.id}%`);
    if (TYPES.includes(type)) add('type=?', type);
    if (sender) add('sender=?', String(sender));
    if (chat) add('chat=?', String(chat));
    if (status === 'open') add("status != 'done'"); else if (STATUSES.includes(status)) add('status=?', status);
    if (assignee === 'none') add("assignee=''"); else if (assignee) add('assignee=?', String(assignee));
    if (q && String(q).trim()) { const like = '%' + String(q).trim().replace(/[\\%_]/g, (ch) => '\\' + ch) + '%'; add("(title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\' OR chat LIKE ? ESCAPE '\\')", like, like, like, like); }
    const rows = this.db.db.prepare(`SELECT * FROM intake_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY received_at DESC, msg_time DESC LIMIT ?`).all(...args, Math.min(Number(limit) || 200, 500));
    return { items: rows.map((r) => this.view(this.row(r))),
      senders: this.db.all('SELECT DISTINCT sender v FROM intake_items ORDER BY sender').map((r) => r.v),
      chats: this.db.all('SELECT DISTINCT chat v FROM intake_items ORDER BY chat').map((r) => r.v) };
  }

  get({ id }) {
    const r = this.item(id);
    if (!r) throw new Error('Unknown item');
    return { ...this.view(r), thread: this.db.all('SELECT id, author, ts, text FROM intake_comments WHERE item=? ORDER BY ts', r.id) };
  }

  unread() { return this.db.get("SELECT COUNT(*) n FROM intake_items WHERE seen=0 AND status != 'done'").n; }

  state() {
    const c = this.conf(), t = this.team(), me = this.m.me.id;
    const members = this.db.all('SELECT user, prefix, key_hash, enabled, last_received FROM intake_members').map((r) => ({ user: r.user, prefix: r.prefix, hasKey: !!r.key_hash, enabled: !!r.enabled, last: r.last_received }));
    members.unshift({ user: me, prefix: c.keyPrefix, hasKey: !!c.keyHash, enabled: c.enabled, last: c.lastReceived });
    return { mine: { enabled: c.enabled, running: !!this.server, error: this.error, hasKey: !!c.keyHash, keyPrefix: c.keyPrefix, keyMade: c.keyMade, lastReceived: c.lastReceived, urls: this.urls(), port: c.port, host: c.host },
      team: { ...t, isAdmin: t.admins.includes(me), canClaim: !t.admins.length }, members, unread: this.unread(),
      log: this.db.all('SELECT ts, ip, user, status, created, skipped, note FROM intake_log ORDER BY ts DESC LIMIT 30') };
  }

  // ------------------------------------------------------------------ team settings (admin)
  // There is no central server to hold roles, so the first member who claims it becomes the team admin;
  // every computer then accepts team settings only from an admin it already knows.
  publishTeam(next) {
    this.m.cfg.team = { ...next, version: this.team().version + 1 };
    this.m.saveCfg();
    this.send(this.everyone(), { t: 'iteam', id: 'iteam:' + crypto.randomBytes(6).toString('hex'), team: this.team() });
    this.ev('team');
    return this.state();
  }

  claimAdmin() {
    if (this.team().admins.length) throw new Error('The team already has an admin');
    return this.publishTeam({ ...this.team(), admins: [this.m.me.id] });
  }

  updateTeam({ enabled, rules, admins }) {
    if (!this.isAdmin()) throw new Error('Only a team admin can change this');
    const t = this.team();
    if (enabled !== undefined) t.enabled = !!enabled;
    if (rules !== undefined) t.rules = this.cleanRules(rules);
    if (admins !== undefined) { const list = [...new Set(admins)].filter((u) => USER.test(u)); if (!list.includes(this.m.me.id)) list.push(this.m.me.id); t.admins = list.slice(0, 20); }
    return this.publishTeam(t);
  }

  cleanRules(rules) {
    return (Array.isArray(rules) ? rules : []).slice(0, 300).map((r) => ({ kind: r.kind === 'chat' ? 'chat' : 'sender', match: clip(r.match, 120), user: USER.test(r.user) ? r.user : '', project: clip(r.project, 60),
      members: r.kind === 'chat' && Array.isArray(r.members) ? r.members.filter((u) => USER.test(u)).slice(0, 100) : [] })).filter((r) => r.match);
  }

  onTeam(from, f) {
    this.m.ack(from, f.id);
    const mine = this.team(), t = f.team;
    if (!t || typeof t !== 'object' || !Array.isArray(t.admins)) return;
    const trusted = mine.admins.length ? mine.admins.includes(from) : t.admins.includes(from); // first admin is trusted on first sight
    if (!trusted || Number(t.version) <= mine.version) return;
    this.m.cfg.team = { admins: t.admins.filter((u) => USER.test(u)).slice(0, 20), enabled: t.enabled !== false, rules: this.cleanRules(t.rules), version: Number(t.version) };
    this.m.saveCfg();
    this.ev('team');
  }

  // Admin: revoke a member's key. Their own app deletes it when it gets this.
  revokeFor({ user }) {
    if (!this.isAdmin()) throw new Error('Only a team admin can do this');
    if (user === this.m.me.id) return this.revokeKey();
    this.db.run("UPDATE intake_members SET key_hash='', prefix='' WHERE user=?", String(user)); // stop accepting it here right away
    this.send([String(user)], { t: 'irev', id: 'irev:' + crypto.randomBytes(6).toString('hex') });
    this.ev('status');
  }
  onRevoke(from, f) {
    this.m.ack(from, f.id);
    if (this.isAdmin(from)) this.revokeKey();
  }

  onFrame(from, f) {
    const handler = { iitem: this.onItem, icom: this.onComment, ikey: this.onKeyStatus, iteam: this.onTeam, irev: this.onRevoke }[f.t];
    if (!handler) return false;
    handler.call(this, from, f);
    return true;
  }
}

module.exports = { Intake, itemId };
