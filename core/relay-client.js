'use strict';
// Optional relay link for people outside the office LAN (WFH / other sites).
// The relay only forwards opaque, end-to-end encrypted blobs between members of a room.
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class RelayClient extends EventEmitter {
  constructor({ url, token, room, id }) {
    super();
    Object.assign(this, { url, token, room, id });
    this.state = url ? 'connecting' : 'off';
    this.error = '';
    this.members = new Set();
    this.delay = 2000;
    this.stopped = false;
  }

  start() { if (this.url) this._connect(); }

  _setState(state, error) {
    this.state = state; this.error = error || '';
    this.emit('status');
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try { ws = new WebSocket(this.url, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 10000 }); }
    catch (e) { this._setState('error', e.message); return; }
    this.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', room: this.room, id: this.id, token: this.token || '' })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'joined') {
        this.delay = 2000;
        this._setState('connected');
        this.emit('joined');
      } else if (m.t === 'pres') this.emit('pres', m.data, m.from);
      else if (m.t === 'msg' && typeof m.data === 'string') this.emit('frame', m.from, Buffer.from(m.data, 'base64'));
      else if (m.t === 'left' || m.t === 'gone') { this.members.delete(m.id); this.emit('left', m.id); }
      else if (m.t === 'error') this.error = m.msg || 'rejected';
    });
    ws.on('error', (e) => { this.error = e.message; });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      const gone = [...this.members];
      this.members.clear();
      for (const id of gone) this.emit('left', id);
      if (this.stopped) return;
      this._setState('error', this.error || 'disconnected');
      this.timer = setTimeout(() => this._connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30000);
    });
    this.ping = this.ping || setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, 25000);
  }

  get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.state === 'connected'; }

  presence(data, to) {
    if (this.connected) this.ws.send(JSON.stringify({ t: 'pres', data, to }));
  }

  async sendTo(peerId, payload) {
    if (!this.connected) return false;
    const ws = this.ws;
    while (ws.bufferedAmount > 1024 * 1024) {
      await new Promise((r) => setTimeout(r, 20));
      if (ws.readyState !== WebSocket.OPEN) return false;
    }
    try { ws.send(JSON.stringify({ t: 'msg', to: peerId, data: payload.toString('base64') })); return true; }
    catch { return false; }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    try { this.ws && this.ws.close(); } catch {}
  }
}

module.exports = { RelayClient };
