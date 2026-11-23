'use strict';
// LAN transport, modelled on IP Messenger: UDP broadcast for member discovery,
// TCP for everything else (messages and file data). No server involved.
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');

const MAX_FRAME = 2 * 1024 * 1024;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
      out.add(a.map((x, k) => (x | (~m[k] & 255))).join('.'));
    }
  }
  return [...out];
}

function frameParser(onFrame, onBad) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) return onBad();
      if (buf.length < 4 + len) break;
      const frame = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onFrame(frame);
    }
  };
}

function writeFrame(sock, payload) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length);
  sock.write(head);
  return sock.write(payload);
}

class Lan extends EventEmitter {
  constructor({ udpPort, tcpPort, extraPeers, handshake, checkHandshake }) {
    super();
    this.udpPort = udpPort;
    this.tcpPortWanted = tcpPort || 0;
    this.extraPeers = extraPeers || [];
    this.handshake = handshake;           // () => Buffer, identifies us to the peer we dial
    this.checkHandshake = checkHandshake; // (Buffer) => peerId | null
    this.conns = new Map();               // peerId -> Set<socket>
    this.dialing = new Map();             // peerId -> Promise<socket|null>
    this.tcpPort = 0;
    this.udpOk = false;
  }

  async start() {
    this.server = net.createServer((sock) => this._accept(sock));
    this.server.on('error', (e) => this.emit('warn', 'tcp: ' + e.message));
    await new Promise((res) => this.server.listen(this.tcpPortWanted, '0.0.0.0', res));
    this.tcpPort = this.server.address().port;

    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('message', (msg, rinfo) => this.emit('packet', msg, rinfo));
    await new Promise((res) => {
      this.udp.once('error', (e) => { this.emit('warn', 'udp: ' + e.message); res(); });
      this.udp.bind(this.udpPort, () => {
        try { this.udp.setBroadcast(true); } catch {}
        this.udpOk = true;
        this.udp.on('error', (e) => this.emit('warn', 'udp: ' + e.message));
        res();
      });
    });
  }

  // Broadcast to the local subnets plus any manually listed hosts (other subnets / VPN).
  broadcast(buf) {
    if (!this.udpOk) return;
    for (const addr of broadcastAddresses()) this.sendTo(buf, addr, this.udpPort);
    for (const entry of this.extraPeers) {
      const [host, port] = String(entry).trim().split(':');
      if (host) this.sendTo(buf, host, Number(port) || this.udpPort);
    }
  }

  sendTo(buf, addr, port) {
    if (!this.udpOk) return;
    try { this.udp.send(buf, port, addr, () => {}); } catch {}
  }

  _track(peerId, sock) {
    let set = this.conns.get(peerId);
    if (!set) this.conns.set(peerId, (set = new Set()));
    set.add(sock);
    sock.on('close', () => { set.delete(sock); if (!set.size && this.conns.get(peerId) === set) this.conns.delete(peerId); });
  }

  _accept(sock) {
    let peerId = null;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30000);
    sock.on('error', () => {});
    const timer = setTimeout(() => { if (!peerId) sock.destroy(); }, 10000);
    sock.on('close', () => clearTimeout(timer));
    sock.on('data', frameParser((frame) => {
      if (sock.destroyed) return;
      if (!peerId) {
        peerId = this.checkHandshake(frame);
        if (!peerId) return sock.destroy();
        this._track(peerId, sock);
      } else {
        this.emit('frame', peerId, Buffer.from(frame));
      }
    }, () => sock.destroy()));
  }

  _dial(peerId, host, port) {
    let p = this.dialing.get(peerId);
    if (p) return p;
    p = new Promise((resolve) => {
      const sock = net.connect({ host, port, timeout: 5000 });
      let done = false;
      const finish = (v) => { if (!done) { done = true; this.dialing.delete(peerId); resolve(v); } };
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30000);
      sock.once('connect', () => {
        sock.setTimeout(0);
        writeFrame(sock, this.handshake());
        this._track(peerId, sock);
        finish(sock);
      });
      sock.on('timeout', () => sock.destroy());
      sock.on('error', () => {});
      sock.on('close', () => finish(null));
      sock.on('data', frameParser((frame) => this.emit('frame', peerId, Buffer.from(frame)), () => sock.destroy()));
    });
    this.dialing.set(peerId, p);
    return p;
  }

  // Resolves true once the frame is handed to the kernel (waits for drain => natural backpressure).
  async send(peerId, host, port, payload) {
    // Always the oldest live connection to that peer: if a second one appears in the middle of a file transfer,
    // the remaining pieces must not switch to it, or they could arrive out of order.
    let sock = [...(this.conns.get(peerId) || [])].find((s) => !s.destroyed && s.writable);
    if (!sock) sock = await this._dial(peerId, host, port);
    if (!sock || sock.destroyed) return false;
    try {
      if (!writeFrame(sock, payload)) {
        await new Promise((res) => {
          const done = () => { sock.off('drain', done); sock.off('close', done); res(); };
          sock.once('drain', done); sock.once('close', done);
        });
      }
      return !sock.destroyed;
    } catch {
      return false;
    }
  }

  // Flow control for file downloads: stop reading from a peer while the disk catches up.
  pausePeer(peerId) { for (const s of this.conns.get(peerId) || []) s.pause(); }
  resumePeer(peerId) { for (const s of this.conns.get(peerId) || []) s.resume(); }

  stop() {
    for (const set of this.conns.values()) for (const s of set) s.destroy();
    this.conns.clear();
    try { this.server && this.server.close(); } catch {}
    try { this.udp && this.udp.close(); } catch {}
    this.udpOk = false;
  }
}

module.exports = { Lan };
