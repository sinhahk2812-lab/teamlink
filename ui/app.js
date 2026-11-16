'use strict';
/* TeamLink UI. Talks to the local engine over a WebSocket; `window.desktop` exists only inside the desktop app. */
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const desk = window.desktop || null;
const $ = (id) => document.getElementById(id);
const S = { me: null, net: {}, peers: new Map(), convs: new Map(), active: null, msgs: [], pending: [], sealed: false, progress: new Map(), results: null };

// ---------------------------------------------------------------- tiny DOM helpers (text only, never innerHTML)
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
const COLORS = ['#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#4f46e5', '#b45309', '#be123c'];
function avatar(seed, label, dot) {
  let n = 0;
  for (const c of String(seed)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const initials = String(label || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('').toUpperCase() || '?';
  const a = h('span', { class: 'avatar' }, initials);
  a.style.background = COLORS[n % COLORS.length];
  if (dot) a.append(h('span', { class: 'dot ' + dot }));
  return a;
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function fmtDay(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const fmtWhen = (ts) => (fmtDay(ts) === 'Today' ? fmtTime(ts) : fmtDay(ts));
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
let toastTimer;
function toast(text) {
  $('toast').textContent = text; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

// ---------------------------------------------------------------- connection to the engine
let ws, rpcSeq = 0;
const waiting = new Map();
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${TOKEN}`);
  ws.onopen = async () => {
    const st = await rpc('getState');
    S.me = st.me; S.net = st.net;
    S.peers = new Map(st.peers.map((p) => [p.id, p]));
    S.convs = new Map(st.convs.map((c) => [c.id, c]));
    renderAll();
    if (S.active) openConv(S.active);
    else if (!S.me.config.teamCode && $('modal').hidden) openSettings(); // first run: ask for the team code straight away
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.event) return onEvent(m.event, m.data);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
  };
  ws.onclose = () => {
    for (const w of waiting.values()) w.reject(new Error('Connection to the app was lost'));
    waiting.clear();
    $('net').textContent = 'Reconnecting to the app…';
    setTimeout(connect, 1500);
  };
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error('Not connected'));
    const id = ++rpcSeq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const call = (method, params) => rpc(method, params).catch((e) => { toast(e.message); throw e; });

function onEvent(event, d) {
  if (event === 'peers') { S.peers = new Map(d.map((p) => [p.id, p])); renderSide(); renderHead(); }
  else if (event === 'conv') { S.convs.set(d.id, d); renderSide(); if (d.id === S.active) renderHead(); updateTitle(); }
  else if (event === 'convDeleted') { S.convs.delete(d); if (S.active === d) closeChat(); renderSide(); }
  else if (event === 'me') { S.me = d; renderMe(); }
  else if (event === 'net') { S.net = d; renderNet(); }
  else if (event === 'message') onMessage(d);
  else if (event === 'file') onFile(d);
  else if (event === 'incoming') notify(d);
  else if (event === 'opened') toast(`${peerName(d.by)} opened your sealed message`);
}

// ---------------------------------------------------------------- names
const peerName = (id) => (id === S.me.id ? S.me.name : (S.peers.get(id) || {}).name || 'User ' + id.slice(0, 6));
function convName(c) {
  if (c.type === 'dm') return peerName(c.id.slice(3));
  if (c.type === 'all') return 'Everyone';
  return c.name || 'Group';
}
function memberName(c, id) {
  const p = S.peers.get(id);
  if (id === S.me.id || (p && p.name)) return peerName(id);
  const m = (c.members || []).find((x) => x.id === id);
  return (m && m.name) || peerName(id);
}
const dotOf = (p) => (!p || !p.online ? 'off' : p.status === 'away' ? 'away' : 'online');

// ---------------------------------------------------------------- sidebar
function renderAll() { renderMe(); renderNet(); renderSide(); updateTitle(); }

function renderMe() {
  $('meAvatar').replaceWith(Object.assign(avatar(S.me.id, S.me.name, S.me.status === 'away' ? 'away' : 'online'), { id: 'meAvatar' }));
  $('meName').textContent = S.me.name;
  $('meStatus').textContent = S.me.status === 'away' ? 'Away' + (S.me.absenceMsg ? ' · ' + S.me.absenceMsg : '') : 'Online' + (S.me.dept ? ' · ' + S.me.dept : '');
  const b = $('banner');
  b.hidden = !!S.me.config.teamCode;
  b.textContent = 'You are offline. Enter your team code to connect. Click here.';
}

function renderNet() {
  const n = S.net, parts = [n.locked ? 'Offline: no team code' : n.lan ? 'LAN on' : 'LAN discovery unavailable'];
  if (n.relay === 'connected') parts.push('Relay connected');
  else if (n.relay && n.relay !== 'off') parts.push('Relay: ' + (n.relayError || 'connecting…'));
  $('net').textContent = parts.join(' · ');
}

function renderSide() {
  const searching = S.results !== null;
  $('chatSection').hidden = searching;
  $('peerList').parentElement.hidden = searching;
  $('resultSection').hidden = !searching;
  if (searching) return renderResults();

  const convs = [...S.convs.values()].filter((c) => c.type !== 'dm' || c.last).sort((a, b) => (b.updated || 0) - (a.updated || 0) || (a.type === 'all' ? -1 : 1));
  $('convList').replaceChildren(...convs.map((c) => {
    const dm = c.type === 'dm' ? S.peers.get(c.id.slice(3)) : null;
    const last = c.last;
    let sub = last ? last.preview : c.type === 'all' ? 'Announcements for the whole team' : c.left ? 'You left this group' : `${c.members.length} members`;
    if (last && c.type !== 'dm') sub = (last.sender === S.me.id ? 'You' : memberName(c, last.sender).split(' ')[0]) + ': ' + sub;
    else if (last && last.sender === S.me.id) sub = 'You: ' + sub;
    return h('li', { class: 'item' + (c.id === S.active ? ' active' : ''), onclick: () => openConv(c.id) },
      avatar(c.type === 'dm' ? c.id.slice(3) : c.id, c.type === 'all' ? '📢' : convName(c), dm ? dotOf(dm) : null),
      h('div', { class: 'body' },
        h('div', { class: 'top' }, h('span', { class: 'name' }, convName(c)), last && h('span', { class: 'time' }, fmtWhen(last.ts))),
        h('div', { class: 'sub' }, sub)),
      c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null);
  }));

  const peers = [...S.peers.values()].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  const online = peers.filter((p) => p.online).length;
  $('membersTitle').textContent = `Members (${online} online of ${peers.length})`;
  const groups = new Map();
  for (const p of peers) { const k = p.dept || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const nodes = [];
  for (const k of keys) {
    if (keys.length > 1 || k) nodes.push(h('h4', null, k || 'No department'));
    for (const p of groups.get(k)) {
      const sub = !p.online ? (p.lastSeen ? 'Last seen ' + fmtWhen(p.lastSeen) : 'Offline')
        : (p.status === 'away' ? 'Away' + (p.absenceMsg ? ' · ' + p.absenceMsg : '') : p.host) + (p.via === 'relay' ? ' · remote' : '');
      nodes.push(h('li', { class: 'item' + (p.online ? '' : ' offline') + (S.active === 'dm:' + p.id ? ' active' : ''), onclick: () => openConv('dm:' + p.id) },
        avatar(p.id, p.name, dotOf(p)),
        h('div', { class: 'body' }, h('div', { class: 'top' }, h('span', { class: 'name' }, p.name)), h('div', { class: 'sub' }, sub))));
    }
  }
  if (!peers.length) nodes.push(h('li', { class: 'empty-note' }, 'Nobody found yet. Teammates appear here automatically when they start TeamLink on the same network with the same team code.'));
  $('peerList').replaceChildren(...nodes);
}

function renderResults() {
  const q = $('search').value.trim().toLowerCase();
  const people = [...S.peers.values()].filter((p) => p.name.toLowerCase().includes(q) || p.dept.toLowerCase().includes(q));
  const nodes = people.map((p) => h('li', { class: 'item', onclick: () => { clearSearch(); openConv('dm:' + p.id); } },
    avatar(p.id, p.name, dotOf(p)), h('div', { class: 'body' }, h('div', { class: 'top' }, h('span', { class: 'name' }, p.name)), h('div', { class: 'sub' }, p.dept || p.host))));
  for (const m of S.results) {
    const c = S.convs.get(m.conv);
    if (!c) continue;
    nodes.push(h('li', { class: 'item', onclick: () => openConv(m.conv, m.id) },
      avatar(c.type === 'dm' ? c.id.slice(3) : c.id, c.type === 'all' ? '📢' : convName(c)),
      h('div', { class: 'body' },
        h('div', { class: 'top' }, h('span', { class: 'name' }, convName(c)), h('span', { class: 'time' }, fmtWhen(m.ts))),
        h('div', { class: 'sub' }, (m.mine ? 'You' : memberName(c, m.sender).split(' ')[0]) + ': ' + (m.body.trim() || m.files.map((f) => f.name).join(', '))))));
  }
  if (!nodes.length) nodes.push(h('li', { class: 'empty-note' }, 'Nothing found.'));
  $('resultList').replaceChildren(...nodes);
}

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('search').value.trim();
  if (q.length < 2) { S.results = null; return renderSide(); }
  searchTimer = setTimeout(async () => { S.results = await call('search', { text: q }); renderSide(); }, 200);
});
function clearSearch() { $('search').value = ''; S.results = null; renderSide(); }

// ---------------------------------------------------------------- chat
async function openConv(id, focusMsg) {
  if (id.startsWith('dm:') && !S.convs.has(id)) S.convs.set(id, { id, type: 'dm', members: [], unread: 0, last: null });
  const changed = S.active !== id;
  S.active = id;
  if (changed) { S.pending = []; S.sealed = false; renderPending(); }
  document.body.classList.add('in-chat');
  $('empty').hidden = true; $('chat').hidden = false;
  renderSide(); renderHead();
  S.msgs = await call('getMessages', { conv: id, limit: focusMsg ? 200 : 80 });
  if (S.active !== id) return;
  renderMessages(true);
  if (focusMsg) {
    const el = document.querySelector(`[data-id="${CSS.escape(focusMsg)}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2500); }
  }
  markRead();
  if (!matchMedia('(max-width: 720px)').matches) $('input').focus();
}
function closeChat() {
  S.active = null; S.msgs = [];
  document.body.classList.remove('in-chat');
  $('chat').hidden = true; $('empty').hidden = false;
  renderSide();
}
function markRead() {
  const c = S.convs.get(S.active);
  if (c && c.unread && document.hasFocus()) rpc('markRead', { conv: S.active }).catch(() => {});
}
window.addEventListener('focus', markRead);

function renderHead() {
  const c = S.convs.get(S.active);
  if (!c) return;
  const dm = c.type === 'dm' ? S.peers.get(c.id.slice(3)) : null;
  $('chatAvatar').replaceWith(Object.assign(avatar(dm ? dm.id : c.id, c.type === 'all' ? '📢' : convName(c), dm ? dotOf(dm) : null), { id: 'chatAvatar' }));
  $('chatName').textContent = convName(c);
  let sub;
  if (c.type === 'all') sub = 'Goes to every team member';
  else if (c.type === 'group') sub = c.left ? 'You are no longer in this group' : c.members.map((m) => (m.id === S.me.id ? 'You' : memberName(c, m.id))).join(', ');
  else if (!dm) sub = '';
  else if (!dm.online) sub = 'Offline. Messages are delivered when they come back.';
  else sub = (dm.status === 'away' ? 'Away' + (dm.absenceMsg ? ': ' + dm.absenceMsg : '') : 'Online') + (dm.via === 'relay' ? ' · remote (via relay)' : ' · on your network') + (dm.dept ? ' · ' + dm.dept : '');
  $('chatSub').textContent = sub;
  $('groupEditBtn').hidden = c.type !== 'group' || c.left;
  $('chatMenuBtn').hidden = c.type === 'all';
  $('sealBtn').hidden = c.type !== 'dm';
  $('sealBtn').classList.toggle('on', S.sealed);
  $('composer').hidden = !!c.left;
  $('input').placeholder = S.sealed ? 'Sealed message: the receiver must click to open it.' : 'Write a message. Paste a screenshot with Ctrl+V.';
}

function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const fileUrl = (fid, dl) => `/file/${fid}?token=${TOKEN}${dl ? '&dl=1' : ''}`;

function fileNode(m, f) {
  const prog = S.progress.get(f.fid);
  const ready = f.state === 'local' || f.state === 'done';
  if (f.image && ready) return h('img', { class: 'shot', src: fileUrl(f.fid), alt: f.name, title: f.name, loading: 'lazy', onclick: () => { $('viewerImg').src = fileUrl(f.fid); $('viewer').hidden = false; } });
  let sub = fmtSize(f.size), action = null, bar = null;
  if (prog && prog.state === 'downloading') {
    sub += ` · ${Math.round((prog.progress || 0) * 100)}%`;
    bar = h('div', { class: 'bar' }, Object.assign(h('i'), { style: `width:${Math.round((prog.progress || 0) * 100)}%` }));
  } else if (ready && !m.mine) {
    action = desk ? [h('button', { onclick: () => desk.openPath(f.path) }, 'Open'), h('button', { onclick: () => desk.showItem(f.path) }, 'Folder')]
      : h('a', { class: 'btn', href: fileUrl(f.fid, true) }, 'Save');
  } else if (!ready) {
    action = h('button', { onclick: () => downloadFile(f) }, 'Download');
  }
  return h('div', { class: 'file' }, h('span', null, '📄'),
    h('div', { class: 'info' }, h('div', { class: 'fname', title: f.name }, f.name),
      h('div', { class: 'fsub' }, sub, prog && prog.error ? h('span', { class: 'err' }, ' · ' + prog.error) : null), bar),
    action);
}

// In the desktop app every download first asks where to save it; cancelling the dialog cancels the download.
async function downloadFile(f) {
  let saveAs;
  if (desk) {
    saveAs = await desk.pickSave(f.name.split(/[\\/]/).pop());
    if (!saveAs) return;
  }
  call('download', { fid: f.fid, saveAs }).catch(() => {});
}

function msgNode(m, c, showWho) {
  const bubble = h('div', { class: 'bubble' });
  if (m.hidden) {
    bubble.append(h('div', { class: 'sealed-card' }, '🔒 Sealed message', h('button', { onclick: () => call('openSealed', { id: m.id }) }, 'Open')));
  } else {
    if (m.sealed) bubble.append(h('span', { class: 'tag' }, '🔒 Sealed'));
    if (m.auto) bubble.append(h('span', { class: 'tag' }, 'Automatic reply'));
    if (m.body) bubble.append(...linkify(m.body));
    for (const f of m.files) bubble.append(fileNode(m, f));
  }
  let meta = fmtTime(m.ts);
  if (m.mine) {
    if (m.sealed) meta += m.readAt ? ' · Opened ' + fmtTime(m.readAt) : m.delivered ? ' · Delivered, not opened yet' : ' · Waiting for them to come online';
    else if (m.recipients <= 1) meta += m.readAt ? ' · ✓✓ Seen ' + fmtTime(m.readAt) : m.delivered ? ' · ✓ Delivered, not seen yet' : m.recipients ? ' · Waiting for them to come online' : '';
    else meta += ` · Delivered to ${m.delivered} of ${m.recipients}` + (m.seen ? ` · Seen by ${m.seen}` : '');
  }
  return h('div', { class: 'msg' + (m.mine ? ' mine' : ''), 'data-id': m.id },
    showWho && h('div', { class: 'who' }, memberName(c, m.sender)), bubble, h('div', { class: 'meta' }, meta));
}

function renderMessages(toBottom) {
  const box = $('messages');
  const c = S.convs.get(S.active);
  if (!c) return;
  const stick = toBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const nodes = [];
  let day = '', prev = null;
  for (const m of S.msgs) {
    const d = fmtDay(m.ts);
    if (d !== day) { nodes.push(h('div', { class: 'day' }, d)); day = d; prev = null; }
    nodes.push(msgNode(m, c, c.type !== 'dm' && !m.mine && prev !== m.sender));
    prev = m.mine ? null : m.sender;
  }
  if (!S.msgs.length) nodes.push(h('div', { class: 'notice' }, c.type === 'all' ? 'Messages here go to everyone in the team.' : 'No messages yet. Say hello.'));
  box.replaceChildren(...nodes);
  if (stick) { box.scrollTop = box.scrollHeight; for (const img of box.querySelectorAll('img.shot')) img.addEventListener('load', () => { box.scrollTop = box.scrollHeight; }, { once: true }); }
}

function onMessage(m) {
  if (m.conv !== S.active) return;
  const i = S.msgs.findIndex((x) => x.id === m.id);
  if (i >= 0) S.msgs[i] = m; else S.msgs.push(m);
  renderMessages(i < 0 && m.mine);
  if (i < 0 && !m.mine) markRead();
}
function onFile(d) {
  if (d.state === 'downloading' || d.error) S.progress.set(d.fid, d); else S.progress.delete(d.fid);
  if (d.error) toast(d.error);
  const m = S.msgs.find((x) => x.id === d.msg);
  if (!m) return;
  const f = m.files.find((x) => x.fid === d.fid);
  if (f && d.state !== 'downloading') { f.state = d.state; f.path = d.path; }
  renderMessages(false);
}

// ---------------------------------------------------------------- composer
function renderPending() {
  $('attachments').replaceChildren(...S.pending.map((a, i) => h('div', { class: 'chip' },
    a.preview ? h('img', { src: a.preview, alt: '' }) : null, h('span', { title: a.name }, a.name + (a.uploading ? ' (adding…)' : '')),
    h('button', { title: 'Remove', onclick: () => { S.pending.splice(i, 1); renderPending(); } }, '×'))));
}
async function addFiles(files) {
  for (const file of files) {
    const item = { name: file.name || 'file', preview: /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type) ? URL.createObjectURL(file) : null };
    const local = desk && file.name ? desk.pathFor(file) : '';
    S.pending.push(item);
    if (local) { item.path = local; continue; }
    // Pasted images (and everything in browser mode) are handed to the engine through a local upload.
    item.uploading = true;
    renderPending();
    try {
      const r = await fetch(`/upload?token=${TOKEN}&name=${encodeURIComponent(item.name)}`, { method: 'POST', body: file });
      if (!r.ok) throw new Error('Could not add ' + item.name);
      item.path = (await r.json()).path; item.uploading = false;
    } catch (e) { S.pending.splice(S.pending.indexOf(item), 1); toast(e.message); }
  }
  renderPending();
}
function addPaths(paths) {
  for (const p of paths || []) S.pending.push({ name: p.split(/[\\/]/).pop(), path: p });
  renderPending();
}
let sending = false;
async function send() {
  if (sending || !S.active) return;
  if (S.pending.some((a) => a.uploading)) return toast('Still adding attachments…');
  const text = $('input').value;
  if (!text.trim() && !S.pending.length) return;
  sending = true; $('sendBtn').disabled = true;
  try {
    await call('send', { conv: S.active, text, sealed: S.sealed, paths: S.pending.map((a) => a.path) });
    $('input').value = ''; autoGrow();
    S.pending = []; S.sealed = false; renderPending(); renderHead();
  } catch {} finally { sending = false; $('sendBtn').disabled = false; $('input').focus(); }
}
function autoGrow() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 140) + 'px'; }
$('input').addEventListener('input', autoGrow);
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$('sendBtn').addEventListener('click', send);
$('sealBtn').addEventListener('click', () => { S.sealed = !S.sealed; renderHead(); });
$('attachBtn').addEventListener('click', async () => { if (desk) addPaths(await desk.pickFiles()); else $('fileInput').click(); });
$('folderBtn').hidden = !desk;
$('folderBtn').addEventListener('click', async () => addPaths(await desk.pickFolder()));
$('fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
document.addEventListener('paste', (e) => {
  if (!S.active || !e.clipboardData) return;
  const files = [...e.clipboardData.files];
  if (!files.length) return;
  e.preventDefault();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${stamp}${i ? '-' + i : ''}.png`, { type: f.type }))));
});
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e) && S.active) { dragDepth++; $('dropHint').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('dropHint').hidden = true;
  if (S.active) addFiles([...e.dataTransfer.files]);
});
$('viewer').addEventListener('click', () => { $('viewer').hidden = true; });
$('backBtn').addEventListener('click', closeChat);
$('chatMenuBtn').addEventListener('click', () => {
  const c = S.convs.get(S.active);
  if (!c) return;
  const group = c.type === 'group' && !c.left;
  modal(group ? 'Leave and delete this group?' : 'Delete this conversation?', [
    h('p', { class: 'hint' }, (group ? 'You will leave the group. ' : '') + 'The history is removed from this computer only. This cannot be undone.'),
  ], { label: 'Delete', danger: true, run: () => call('deleteConversation', { conv: c.id }) });
});

// ---------------------------------------------------------------- dialogs
function modal(title, body, action, extra) {
  const close = () => { $('modal').hidden = true; };
  const ok = h('button', { class: action.danger ? 'ghost danger' : 'primary', onclick: async () => { try { await action.run(); close(); } catch {} } }, action.label);
  if (action.danger) ok.style.marginRight = '0';
  $('modalCard').replaceChildren(h('h2', null, title), ...body.filter(Boolean), h('div', { class: 'actions' }, extra, h('button', { class: 'ghost', onclick: close }, 'Cancel'), ok));
  $('modal').hidden = false;
  const first = $('modalCard').querySelector('input[type=text], textarea');
  if (first) first.focus();
}
$('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('modal').hidden = true; $('viewer').hidden = true; } });
const field = (label, input, hint) => [h('label', null, label), input, ...(hint ? [h('p', { class: 'hint' }, hint)] : [])];

$('meBtn').addEventListener('click', () => {
  const name = h('input', { type: 'text', value: S.me.name, maxLength: 40 });
  const dept = h('input', { type: 'text', value: S.me.dept, maxLength: 40, placeholder: 'e.g. Sales, Accounts, Design' });
  const status = h('select', null, h('option', { value: 'online' }, 'Online'), h('option', { value: 'away' }, 'Away (absence mode)'));
  status.value = S.me.status;
  const msg = h('input', { type: 'text', value: S.me.absenceMsg, maxLength: 200, placeholder: 'e.g. In a meeting, back at 4 pm' });
  modal('Your profile', [
    ...field('Display name', name), ...field('Department', dept, 'Teammates are grouped by department in the member list.'),
    ...field('Status', status), ...field('Away message', msg, 'While you are away, people who message you get this as an automatic reply.'),
    h('p', { class: 'hint code' }, 'Your ID: ' + S.me.id),
  ], { label: 'Save', run: () => call('setProfile', { name: name.value, dept: dept.value, status: status.value, absenceMsg: msg.value }) });
});

function openSettings() {
  const c = S.me.config;
  const team = h('input', { type: 'text', value: c.teamCode, maxLength: 100, placeholder: 'At least 8 characters, given to you by your team' });
  const relay = h('input', { type: 'text', value: c.relayUrl, placeholder: 'wss://relay.yourcompany.com' });
  const token = h('input', { type: 'password', value: c.relayToken });
  const extra = h('textarea', { rows: 2, value: (c.extraPeers || []).join('\n'), placeholder: '192.168.2.15\n10.0.5.255' });
  const dl = h('input', { type: 'text', value: c.downloadDir });
  const autostart = desk ? h('input', { type: 'checkbox' }) : null;
  const popup = desk ? h('input', { type: 'checkbox', checked: c.popup !== false }) : null;
  if (desk) desk.getAutostart().then((v) => { autostart.checked = v; });
  modal('Settings', [
    h('h3', null, 'Team'),
    ...field('Team code', team, 'Everyone in the team must enter exactly the same code. Without the right code a computer cannot see the team, join it or read anything. Keep it secret and never post it publicly.'),
    h('h3', null, 'Remote teammates (optional)'),
    ...field('Relay address', relay, 'Only needed for people outside the office network. Leave empty for LAN only.'),
    ...field('Relay token', token),
    h('h3', null, 'Network'),
    ...field('Extra addresses to search', extra, 'One IP or broadcast address per line, for other subnets or VPNs where automatic discovery does not reach.'),
    h('h3', null, 'Files'),
    ...field('Save received files to', dl),
    desk && h('label', null, popup, ' Show a popup on screen when a message arrives'),
    desk && h('label', null, autostart, ' Start TeamLink when I sign in to this computer'),
    desk && h('h3', null, 'Updates'),
    desk && updateRow(),
  ], { label: 'Save', run: async () => {
    await call('setConfig', { teamCode: team.value, relayUrl: relay.value, relayToken: token.value, extraPeers: extra.value, downloadDir: dl.value, popup: popup ? popup.checked : undefined });
    if (desk) desk.setAutostart(autostart.checked);
  } });
}
$('settingsBtn').addEventListener('click', openSettings);
$('banner').addEventListener('click', openSettings);

function groupDialog(conv) {
  const name = h('input', { type: 'text', value: conv ? conv.name : '', maxLength: 60, placeholder: 'e.g. Sales team' });
  const current = new Set(conv ? conv.members.map((m) => m.id) : []);
  const people = [...S.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  const boxes = people.map((p) => {
    const cb = h('input', { type: 'checkbox', value: p.id, checked: current.has(p.id) });
    return h('label', null, cb, avatar(p.id, p.name, dotOf(p)), h('span', null, p.name + (p.dept ? ' · ' + p.dept : '')));
  });
  const picked = () => boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
  const leave = conv && h('button', { class: 'ghost danger', onclick: async () => { await call('leaveGroup', { conv: conv.id }); $('modal').hidden = true; } }, 'Leave group');
  modal(conv ? 'Group settings' : 'New group', [
    ...field('Group name', name), h('label', null, 'Members'),
    people.length ? h('div', { class: 'pick' }, boxes) : h('p', { class: 'hint' }, 'No teammates found yet.'),
  ], { label: conv ? 'Save' : 'Create', run: async () => {
    if (!picked().length) { toast('Pick at least one member'); throw new Error('none'); }
    if (conv) await call('updateGroup', { conv: conv.id, name: name.value, members: picked() });
    else { const g = await call('createGroup', { name: name.value, members: picked() }); S.convs.set(g.id, g); openConv(g.id); }
  } }, leave);
}
// One message to a few chosen people. Each of them gets it as a normal private message
// (they do not see who else received it), unlike a group where everyone sees everything.
function multiDialog() {
  const people = [...S.peers.values()].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  const boxes = people.map((p) => h('label', null, h('input', { type: 'checkbox', value: p.id }), avatar(p.id, p.name, dotOf(p)),
    h('span', null, p.name + (p.dept ? ' · ' + p.dept : '') + (p.online ? '' : ' (offline)'))));
  const picked = () => boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
  const count = h('p', { class: 'hint' }, 'Nobody selected yet.');
  const pick = h('div', { class: 'pick', onchange: () => { const n = picked().length; count.textContent = n ? `${n} selected. Each person gets a private message.` : 'Nobody selected yet.'; } }, boxes);
  const text = h('textarea', { rows: 4, maxLength: 20000, placeholder: 'Write your message' });
  const sealed = h('input', { type: 'checkbox' });
  // attachments: real paths in the desktop app, local uploads in browser mode
  const files = [];
  const chips = h('div', { id: 'multiFiles' });
  const drawFiles = () => chips.replaceChildren(...files.map((f, i) => h('div', { class: 'chip' }, h('span', { title: f.name }, f.name + (f.path ? '' : ' (adding…)')),
    h('button', { type: 'button', title: 'Remove', onclick: () => { files.splice(i, 1); drawFiles(); } }, '×'))));
  const addPicked = (paths) => { for (const p of paths || []) files.push({ name: p.split(/[\\/]/).pop(), path: p }); drawFiles(); };
  const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: async (e) => {
    for (const file of [...e.target.files]) {
      const item = { name: file.name };
      files.push(item); drawFiles();
      try {
        const r = await fetch(`/upload?token=${TOKEN}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
        if (!r.ok) throw new Error('Could not add ' + file.name);
        item.path = (await r.json()).path;
      } catch (err) { files.splice(files.indexOf(item), 1); toast(err.message); }
      drawFiles();
    }
    e.target.value = '';
  } });
  const attachRow = h('div', { class: 'attach-row' },
    h('button', { class: 'ghost', type: 'button', onclick: async () => { if (desk) addPicked(await desk.pickFiles()); else input.click(); } }, '📎 Attach files'),
    desk && h('button', { class: 'ghost', type: 'button', onclick: async () => addPicked(await desk.pickFolder()) }, '📁 Attach a folder'), input);
  modal('Message several people', [
    h('label', null, 'Send to'),
    people.length ? pick : h('p', { class: 'hint' }, 'No teammates found yet.'), count,
    ...field('Message', text),
    attachRow, chips,
    h('label', null, sealed, ' 🔒 Sealed: each person must click to open it, and you see when they do'),
  ], { label: 'Send', run: async () => {
    const ids = picked();
    if (!ids.length) { toast('Pick at least one person'); throw new Error('none'); }
    if (files.some((f) => !f.path)) { toast('Still adding attachments…'); throw new Error('busy'); }
    if (!text.value.trim() && !files.length) { toast('Write a message or attach a file first'); throw new Error('empty'); }
    for (const id of ids) await call('send', { conv: 'dm:' + id, text: text.value, sealed: sealed.checked, paths: files.map((f) => f.path) });
    toast(`Sent to ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`);
  } });
}
$('multiBtn').addEventListener('click', multiDialog);
$('newGroupBtn').addEventListener('click', () => groupDialog(null));
$('groupEditBtn').addEventListener('click', () => groupDialog(S.convs.get(S.active)));

// ---------------------------------------------------------------- updates (desktop app only)
let upd = null, updLine = null;
function updateText() {
  if (!upd) return '';
  const v = 'Version ' + upd.current;
  switch (upd.status) {
    case 'dev': return v + ' (development copy, updates are off)';
    case 'checking': return v + ' · checking for updates…';
    case 'latest': return v + ' · you have the latest version';
    case 'downloading': return `${v} · downloading ${upd.version} (${upd.percent}%)`;
    case 'ready': return `${v} · ${upd.version} is ready to install`;
    case 'available': return `${v} · ${upd.version} is available`;
    case 'error': return v + ' · could not check for updates: ' + upd.error;
    default: return v;
  }
}
function renderUpdate() {
  if (updLine) updLine.textContent = updateText();
  const b = $('updateBanner');
  const action = upd && (upd.status === 'ready' || upd.status === 'available');
  b.hidden = !(upd && (action || upd.status === 'downloading'));
  b.classList.toggle('action', !!action);
  if (!upd) return;
  b.textContent = upd.status === 'ready' ? `TeamLink ${upd.version} is ready. Click to restart and update.`
    : upd.status === 'available' ? `TeamLink ${upd.version} is available. Click to download it.`
      : `Downloading update ${upd.version}… ${upd.percent}%`;
}
function updateRow() {
  updLine = h('p', { class: 'hint' }, updateText());
  return h('div', null, updLine, h('button', { class: 'ghost', type: 'button', onclick: async () => { upd = await desk.checkUpdate(); renderUpdate(); } }, 'Check for updates'));
}
if (desk && desk.onOpenConv) desk.onOpenConv((conv) => openConv(conv));
if (desk && desk.getUpdate) {
  desk.getUpdate().then((u) => { upd = u; renderUpdate(); });
  desk.onUpdate((u) => { upd = u; renderUpdate(); });
  $('updateBanner').addEventListener('click', () => { if (upd && (upd.status === 'ready' || upd.status === 'available')) desk.installUpdate(); });
}

// ---------------------------------------------------------------- notifications
function updateTitle() {
  const n = [...S.convs.values()].reduce((a, c) => a + (c.unread || 0), 0);
  document.title = (n ? `(${n}) ` : '') + 'TeamLink';
  if (desk) desk.setUnread(n);
}
function notify(d) {
  if (desk) return; // the desktop app shows its own on-screen popup
  if (document.hasFocus() && d.conv === S.active) return;
  const c = S.convs.get(d.conv);
  if (!c || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const title = c.type === 'dm' ? peerName(d.from) : `${memberName(c, d.from)} in ${convName(c)}`;
  const n = new Notification(title, { body: (c.last && c.last.preview) || 'New message', tag: d.conv, silent: false });
  n.onclick = () => { if (desk) desk.focus(); else window.focus(); openConv(d.conv); };
}
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}

connect();
