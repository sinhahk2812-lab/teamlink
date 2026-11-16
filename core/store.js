'use strict';
// Local persistence: one SQLite file per install (built-in node:sqlite, no native addons).
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(dataDir) {
    this.db = new DatabaseSync(path.join(dataDir, 'teamlink.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS peers(
        id TEXT PRIMARY KEY, pub TEXT NOT NULL, name TEXT, dept TEXT, host TEXT, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS convs(
        id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT, members TEXT, version INTEGER DEFAULT 0,
        left_group INTEGER DEFAULT 0, updated INTEGER);
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, conv TEXT NOT NULL, sender TEXT NOT NULL, ts INTEGER NOT NULL,
        body TEXT, files TEXT, sealed INTEGER DEFAULT 0, opened INTEGER DEFAULT 0, auto INTEGER DEFAULT 0,
        unread INTEGER DEFAULT 0, recipients TEXT, delivered TEXT, read_at INTEGER);
      CREATE INDEX IF NOT EXISTS messages_conv ON messages(conv, ts);
      CREATE TABLE IF NOT EXISTS files(
        fid TEXT PRIMARY KEY, msg TEXT, owner TEXT, name TEXT, size INTEGER, mime TEXT,
        path TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT NOT NULL, peer TEXT NOT NULL, frame TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY(id, peer));
    `);
    this._stmts = new Map();
  }

  q(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }
  run(sql, ...a) { return this.q(sql).run(...a); }
  get(sql, ...a) { return this.q(sql).get(...a); }
  all(sql, ...a) { return this.q(sql).all(...a); }

  // ---- peers
  upsertPeer(p) {
    this.run(`INSERT INTO peers(id,pub,name,dept,host,last_seen) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=COALESCE(excluded.name,name), dept=COALESCE(excluded.dept,dept),
      host=COALESCE(excluded.host,host), last_seen=COALESCE(excluded.last_seen,last_seen)`,
      p.id, p.pub, p.name ?? null, p.dept ?? null, p.host ?? null, p.lastSeen ?? null);
  }
  peers() { return this.all('SELECT * FROM peers'); }

  // ---- conversations
  conv(id) {
    const c = this.get('SELECT * FROM convs WHERE id=?', id);
    if (c) c.members = c.members ? JSON.parse(c.members) : [];
    return c;
  }
  convs() {
    return this.all('SELECT * FROM convs').map((c) => ({ ...c, members: c.members ? JSON.parse(c.members) : [] }));
  }
  saveConv(c) {
    this.run(`INSERT INTO convs(id,type,name,members,version,left_group,updated) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, members=excluded.members, version=excluded.version,
      left_group=excluded.left_group, updated=excluded.updated`,
      c.id, c.type, c.name ?? null, JSON.stringify(c.members || []), c.version || 0, c.left_group ? 1 : 0,
      c.updated || Date.now());
  }
  touchConv(id, ts) { this.run('UPDATE convs SET updated=? WHERE id=?', ts, id); }
  deleteConv(id) {
    this.run('DELETE FROM files WHERE msg IN (SELECT id FROM messages WHERE conv=?)', id);
    this.run('DELETE FROM messages WHERE conv=?', id);
    this.run('DELETE FROM convs WHERE id=?', id);
  }

  // ---- messages
  static row(m) {
    if (!m) return m;
    for (const k of ['files', 'recipients', 'delivered']) m[k] = m[k] ? JSON.parse(m[k]) : [];
    return m;
  }
  addMessage(m) {
    const r = this.run(`INSERT OR IGNORE INTO messages(id,conv,sender,ts,body,files,sealed,opened,auto,unread,recipients,delivered)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      m.id, m.conv, m.sender, m.ts, m.body || '', JSON.stringify(m.files || []), m.sealed ? 1 : 0, m.opened ? 1 : 0,
      m.auto ? 1 : 0, m.unread ? 1 : 0, JSON.stringify(m.recipients || []), JSON.stringify(m.delivered || []));
    return r.changes > 0;
  }
  message(id) { return Store.row(this.get('SELECT * FROM messages WHERE id=?', id)); }
  messages(conv, before, limit) {
    return this.all('SELECT * FROM messages WHERE conv=? AND ts<? ORDER BY ts DESC, rowid DESC LIMIT ?',
      conv, before || Number.MAX_SAFE_INTEGER, limit || 60).map(Store.row).reverse();
  }
  lastMessage(conv) {
    return Store.row(this.get('SELECT * FROM messages WHERE conv=? ORDER BY ts DESC, rowid DESC LIMIT 1', conv));
  }
  unread(conv) { return this.get('SELECT COUNT(*) n FROM messages WHERE conv=? AND unread=1', conv).n; }
  markRead(conv) { return this.run('UPDATE messages SET unread=0 WHERE conv=? AND unread=1', conv).changes; }
  markDelivered(id, peer) {
    const m = this.message(id);
    if (!m || m.delivered.includes(peer)) return null;
    m.delivered.push(peer);
    this.run('UPDATE messages SET delivered=? WHERE id=?', JSON.stringify(m.delivered), id);
    return m;
  }
  search(text, limit) {
    const like = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    // Unopened sealed messages stay out of search results.
    return this.all(`SELECT * FROM messages WHERE (body LIKE ? ESCAPE '\\' OR id IN (SELECT msg FROM files WHERE name LIKE ? ESCAPE '\\'))
      AND NOT (sealed=1 AND opened=0) ORDER BY ts DESC LIMIT ?`, like, like, limit || 80).map(Store.row);
  }

  // ---- files
  saveFile(f) {
    this.run(`INSERT INTO files(fid,msg,owner,name,size,mime,path,state) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(fid) DO UPDATE SET path=excluded.path, state=excluded.state`,
      f.fid, f.msg, f.owner, f.name, f.size, f.mime || '', f.path || null, f.state);
  }
  file(fid) { return this.get('SELECT * FROM files WHERE fid=?', fid); }
  filesOf(msg) { return this.all('SELECT * FROM files WHERE msg=?', msg); }

  // ---- outbox (store-and-forward for peers that are offline right now)
  queue(id, peer, frame) {
    this.run('INSERT OR REPLACE INTO outbox(id,peer,frame,created) VALUES(?,?,?,?)', id, peer, JSON.stringify(frame), Date.now());
  }
  dequeue(id, peer) { this.run('DELETE FROM outbox WHERE id=? AND peer=?', id, peer); }
  pendingFor(peer) {
    return this.all('SELECT * FROM outbox WHERE peer=? ORDER BY created LIMIT 200', peer)
      .map((r) => ({ ...r, frame: JSON.parse(r.frame) }));
  }
  expireOutbox(olderThan) { this.run('DELETE FROM outbox WHERE created<?', olderThan); }

  close() { this._stmts.clear(); this.db.close(); }
}

module.exports = { Store };
