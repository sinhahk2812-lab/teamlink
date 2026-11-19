'use strict';
/* TeamLink UI. Talks to the local engine over a WebSocket; `window.desktop` exists only inside the desktop app. */
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const desk = window.desktop || null;
const $ = (id) => document.getElementById(id);
const S = { me: null, net: {}, peers: new Map(), convs: new Map(), active: null, msgs: [], pending: [], sealed: false, locked: false, replyTo: null, sub: '', progress: new Map(), results: null };

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
  // a profile picture, when this person has set one
  const ver = S.me && seed === S.me.id ? S.me.avatar : (S.peers.get(seed) || {}).avatar;
  if (ver) { a.textContent = ''; a.classList.add('photo'); a.style.backgroundImage = `url("/avatar/${seed}?token=${TOKEN}&v=${ver}")`; }
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
  else if (event === 'incoming') { pingAt.set(d.conv, Date.now()); renderSide(); notify(d); }
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
// First paint: list rows slide in one after another. Re-renders during that second resume, not restart.
function staggerBoot() {
  if (!bootAt || Date.now() - bootAt > 1100) return;
  const elapsed = Date.now() - bootAt;
  document.querySelectorAll('#lists .item').forEach((el, i) => { el.style.animationDelay = `${i * 45 - elapsed}ms`; });
}
let booted = false, bootAt = 0;
function renderAll() {
  renderMe(); renderNet(); renderSide(); updateTitle();
  if (!booted) { booted = true; bootAt = Date.now(); document.body.classList.add('boot'); staggerBoot(); setTimeout(() => document.body.classList.remove('boot'), 1100); }
}

// ---------------------------------------------------------------- appearance (theme, colour, font, size, wallpaper)
const DEFAULT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
// Ready-made themes. "classic" keeps the built-in light/dark colours; the others bring their own.
const PRESETS = {
  classic:  { name: 'Classic',  mode: 'system', accent: '#0d9488', pv: ['#1f2937', '#f4f5f7', '#ffffff'] },
  midnight: { name: 'Midnight', mode: 'dark',  accent: '#38bdf8', bg: '#0b1020', panel: '#131a2e', side: '#070b18', side2: '#141c33', sideText: '#e2e8f0', sideDim: '#8c9ab5', text: '#e6ecf7', dim: '#93a0b8', line: '#222c47', theirs: '#18213a', blobs: ['#6366f1', '#0ea5e9', '#a855f7'] },
  ocean:    { name: 'Ocean',    mode: 'dark',  accent: '#22d3ee', bg: '#06202b', panel: '#0b2d3b', side: '#041820', side2: '#0d3443', sideText: '#e0f2f7', sideDim: '#86aab6', text: '#e3f4f8', dim: '#8fb2bd', line: '#164352', theirs: '#0f3442', blobs: ['#0ea5e9', '#14b8a6', '#3b82f6'] },
  sunset:   { name: 'Sunset',   mode: 'dark',  accent: '#fb923c', bg: '#1d1024', panel: '#2a1733', side: '#160b1c', side2: '#33193c', sideText: '#f6e8f2', sideDim: '#b596b3', text: '#f7ebf3', dim: '#bb9db8', line: '#44264d', theirs: '#321c3c', blobs: ['#ec4899', '#f59e0b', '#8b5cf6'] },
  forest:   { name: 'Forest',   mode: 'dark',  accent: '#4ade80', bg: '#0c1a13', panel: '#13261b', side: '#08130d', side2: '#173021', sideText: '#e3f3e8', sideDim: '#8db09a', text: '#e5f4ea', dim: '#93b3a0', line: '#213b2b', theirs: '#172d20', blobs: ['#16a34a', '#84cc16', '#0d9488'] },
  amoled:   { name: 'Black',    mode: 'dark',  accent: '#a3e635', bg: '#000000', panel: '#0c0c0c', side: '#000000', side2: '#161616', sideText: '#f2f2f2', sideDim: '#8f8f8f', text: '#f2f2f2', dim: '#9a9a9a', line: '#242424', theirs: '#151515', blobs: ['#3f3f46', '#27272a', '#52525b'] },
  rose:     { name: 'Rose',     mode: 'light', accent: '#e11d74', bg: '#fdf2f6', panel: '#ffffff', side: '#fbe4ed', side2: '#f6d2e0', sideText: '#4a1830', sideDim: '#946a7c', text: '#3b1226', dim: '#8a6274', line: '#f1d5e0', theirs: '#ffffff', blobs: ['#fb7185', '#f0abfc', '#fda4af'] },
  lavender: { name: 'Lavender', mode: 'light', accent: '#7c3aed', bg: '#f5f2fe', panel: '#ffffff', side: '#e9e3fb', side2: '#dbd1f6', sideText: '#2e1f56', sideDim: '#7a6c9c', text: '#251848', dim: '#74679a', line: '#e0d8f5', theirs: '#ffffff', blobs: ['#a78bfa', '#60a5fa', '#f0abfc'] },
  sand:     { name: 'Sand',     mode: 'light', accent: '#c2410c', bg: '#faf5ec', panel: '#fffdf8', side: '#f1e6d2', side2: '#e7d8bd', sideText: '#3f2f17', sideDim: '#8b7858', text: '#33260f', dim: '#857254', line: '#eadfc9', theirs: '#fffdf8', blobs: ['#f59e0b', '#fb923c', '#fde68a'] },
};
const PRESET_VARS = { bg: '--bg', panel: '--panel', side: '--side', side2: '--side-2', sideText: '--side-text', sideDim: '--side-dim', text: '--text', dim: '--dim', line: '--line', theirs: '--theirs' };

function applyAppearance(a) {
  const root = document.documentElement;
  const preset = PRESETS[a.preset] && a.preset !== 'classic' ? PRESETS[a.preset] : null;
  const mode = preset ? preset.mode : a.mode;
  root.dataset.preset = preset ? a.preset : 'classic';
  if (mode === 'system') delete root.dataset.theme; else root.dataset.theme = mode;
  for (const [key, cssVar] of Object.entries(PRESET_VARS)) { if (preset) root.style.setProperty(cssVar, preset[key]); else root.style.removeProperty(cssVar); }
  ['--b2', '--b3', '--b4'].forEach((v, i) => { if (preset) root.style.setProperty(v, preset.blobs[i]); else root.style.removeProperty(v); });
  root.style.setProperty('--accent', a.accent);
  root.style.setProperty('--font', a.font ? `"${a.font}", ${DEFAULT_FONT}` : DEFAULT_FONT);
  root.style.setProperty('--msg-size', a.msgSize + 'px');
  root.style.zoom = a.zoom === 100 ? '' : String(a.zoom / 100);
  document.body.dataset.wall = a.wall;
  document.body.dataset.style = a.style;
  document.body.dataset.motion = a.motion ? 'on' : 'off';
  const veil = `color-mix(in srgb, var(--bg) ${a.dim}%, transparent)`;
  $('messages').style.backgroundImage = a.wall === 'image' ? `linear-gradient(${veil}, ${veil}), url("/wallpaper?token=${TOKEN}&v=${a.wallVer}")`
    : a.wall === 'paper' ? `linear-gradient(${veil}, ${veil}), url("/wall-paper.jpg")` : '';
}

const ACCENTS = ['#0d9488', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#475569'];
const FONTS = ['', 'Segoe UI', 'Calibri', 'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Comic Sans MS'];
function appearanceDialog() {
  const a = { ...S.me.config.appearance };
  const save = (patch) => { document.body.classList.add('theming'); clearTimeout(save.t); save.t = setTimeout(() => document.body.classList.remove('theming'), 600); Object.assign(a, patch); S.me.config.appearance = { ...a }; applyAppearance(a); rpc('setAppearance', patch).catch((e) => toast(e.message)); draw(); };
  const mode = h('select', { onchange: () => save({ mode: mode.value }) }, h('option', { value: 'system' }, 'Same as the computer'), h('option', { value: 'light' }, 'Light'), h('option', { value: 'dark' }, 'Dark'));
  const look = h('select', { onchange: () => save({ style: look.value }) }, h('option', { value: 'glass' }, 'Glass (see-through panels, moving colours)'), h('option', { value: 'solid' }, 'Solid (plain, lightest on old PCs)'));
  const motion = h('input', { type: 'checkbox', onchange: () => save({ motion: motion.checked }) });
  const themes = h('div', { class: 'themes' });
  const themeCard = (id, t) => {
    const [side, bg, bubble] = t.pv || [t.side, t.bg, t.theirs];
    const part = (tag, color) => { const e = h(tag); e.style.background = color; return e; };
    const body = part('b', bg); body.append(part('u', bubble), part('s', t.accent));
    return h('button', { class: 'theme' + (a.preset === id ? ' on' : ''), type: 'button', onclick: () => save(id === 'classic' ? { preset: id, accent: t.accent } : { preset: id, accent: t.accent, mode: t.mode }) },
      h('div', { class: 'pv' }, part('i', side), body), h('span', null, t.name));
  };
  const swatches = h('div', { class: 'swatches' });
  const custom = h('input', { type: 'color', title: 'Any colour', onchange: () => save({ accent: custom.value }) });
  const font = h('select', { onchange: () => { if (font.value === '?') { other.hidden = false; other.focus(); } else { other.hidden = true; save({ font: font.value }); } } },
    ...FONTS.map((f) => h('option', { value: f }, f || 'Default')), h('option', { value: '?' }, 'Other font installed on this computer…'));
  const other = h('input', { type: 'text', hidden: true, maxLength: 60, placeholder: 'Type the font name, e.g. Poppins', onchange: () => save({ font: other.value }) });
  const slider = (key, min, max, unit) => {
    const out = h('output', null, a[key] + unit);
    const r = h('input', { type: 'range', min, max, step: 1, value: a[key], oninput: () => { out.textContent = r.value + unit; }, onchange: () => save({ [key]: Number(r.value) }) });
    return h('div', { class: 'range-row' }, r, out);
  };
  const wall = h('select', { onchange: () => { if (wall.value === 'image' && !a.wallVer) return pick.click(); save({ wall: wall.value }); } },
    h('option', { value: 'none' }, 'None'), h('option', { value: 'gradient' }, 'Soft colour gradient'), h('option', { value: 'dots' }, 'Dots'), h('option', { value: 'paper' }, 'White paper'), h('option', { value: 'image' }, 'My own picture'));
  const pick = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: async () => {
    const file = pick.files[0]; pick.value = '';
    if (!file) return draw();
    const r = await fetch(`/wallpaper?token=${TOKEN}`, { method: 'POST', headers: { 'content-type': file.type }, body: file });
    if (!r.ok) { toast((await r.json().catch(() => ({}))).error || 'Could not use that picture'); return draw(); }
    Object.assign(a, { wall: 'image', wallVer: Date.now() % 1e9 }); // the engine saved the same; refresh comes with its event
    const st = await rpc('getState'); Object.assign(a, st.me.config.appearance); S.me = st.me; applyAppearance(a); draw();
  } });
  function draw() {
    mode.value = a.mode; wall.value = a.wall; custom.value = a.accent; look.value = a.style; motion.checked = a.motion;
    mode.disabled = a.preset !== 'classic';
    themes.replaceChildren(...Object.entries(PRESETS).map(([id, t]) => themeCard(id, t)));
    if (FONTS.includes(a.font)) { font.value = a.font; other.hidden = true; } else { font.value = '?'; other.hidden = false; other.value = a.font; }
    swatches.replaceChildren(...ACCENTS.map((c) => { const b = h('button', { class: 'swatch' + (c === a.accent ? ' on' : ''), type: 'button', title: c, onclick: () => save({ accent: c }) }); b.style.background = c; return b; }), custom);
  }
  draw();
  modal('Appearance', [
    h('p', { class: 'hint' }, 'Changes apply straight away and only on this computer.'),
    h('label', null, 'Theme'), themes,
    ...field('Light or dark (Classic theme only)', mode),
    ...field('Style', look),
    h('label', null, motion, ' Animations'),
    h('label', null, 'Colour'), swatches,
    ...field('Font', font), other,
    h('label', null, 'Message text size'), slider('msgSize', 11, 26, ' px'),
    h('label', null, 'Size of everything (zoom)'), slider('zoom', 75, 160, ' %'),
    h('h3', null, 'Chat wallpaper'),
    ...field('Background', wall),
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', type: 'button', onclick: () => pick.click() }, 'Choose a picture…'), pick),
    h('label', null, 'Fade the wallpaper (for easier reading)'), slider('dim', 0, 90, ' %'),
  ], { label: 'Done', run: async () => {} },
  h('button', { class: 'ghost danger', type: 'button', onclick: async () => { await call('setAppearance', { reset: true }); const st = await rpc('getState'); S.me = st.me; applyAppearance(S.me.config.appearance); $('modal').hidden = true; } }, 'Reset'));
}

function renderMe() {
  applyAppearance(S.me.config.appearance);
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
    return recent(pingAt, c.id, 1300, h('li', { class: 'item' + (c.id === S.active ? ' active' : ''), onclick: () => openConv(c.id) },
      avatar(c.type === 'dm' ? c.id.slice(3) : c.id, c.type === 'all' ? '📢' : convName(c), dm ? dotOf(dm) : null),
      h('div', { class: 'body' },
        h('div', { class: 'top' }, h('span', { class: 'name' }, convName(c)), last && h('span', { class: 'time' }, fmtWhen(last.ts))),
        h('div', { class: 'sub' }, sub)),
      c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null), 'ping');
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
  staggerBoot();
}

function renderResults() {
  const q = $('search').value.trim().toLowerCase();
  const people = [...S.peers.values()].filter((p) => p.name.toLowerCase().includes(q) || p.dept.toLowerCase().includes(q));
  const nodes = people.map((p) => h('li', { class: 'item', onclick: () => { clearSearch(); openConv('dm:' + p.id); } },
    avatar(p.id, p.name, dotOf(p)), h('div', { class: 'body' }, h('div', { class: 'top' }, h('span', { class: 'name' }, p.name)), h('div', { class: 'sub' }, p.dept || p.host))));
  for (const m of S.results) {
    const c = S.convs.get(m.conv);
    if (!c) continue;
    nodes.push(h('li', { class: 'item', onclick: () => openConv(m.conv, m.id, m.sub || '') },
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
async function openConv(id, focusMsg, sub) {
  if (id.startsWith('dm:') && !S.convs.has(id)) S.convs.set(id, { id, type: 'dm', members: [], unread: 0, last: null });
  const changed = S.active !== id;
  S.active = id;
  if (changed || sub !== undefined) S.sub = sub || '';
  if (desk && desk.setActiveConv) desk.setActiveConv(id);
  if (changed) { S.pending = []; S.sealed = false; S.locked = false; S.replyTo = null; renderPending(); renderReply(); }
  document.body.classList.add('in-chat');
  $('empty').hidden = true; $('chat').hidden = false;
  renderSide(); renderHead();
  const wantSub = S.sub;
  S.msgs = await call('getMessages', { conv: id, sub: wantSub, limit: focusMsg ? 200 : 80 });
  if (S.active !== id || S.sub !== wantSub) return;
  renderMessages(true);
  if (changed) { const box = $('messages'); box.classList.remove('swap'); void box.offsetWidth; box.classList.add('swap'); }
  if (focusMsg) {
    const el = document.querySelector(`[data-id="${CSS.escape(focusMsg)}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2500); }
  }
  markRead();
  if (!matchMedia('(max-width: 720px)').matches) $('input').focus();
}
function closeChat() {
  S.active = null; S.msgs = [];
  if (desk && desk.setActiveConv) desk.setActiveConv(null);
  document.body.classList.remove('in-chat');
  $('chat').hidden = true; $('empty').hidden = false;
  renderSide();
}
function markRead() {
  const c = S.convs.get(S.active);
  if (!c || !document.hasFocus()) return;
  const sub = (c.subs || []).find((x) => x.id === S.sub);
  const waiting = S.sub ? sub && sub.unread : (c.unreadMain === undefined ? c.unread : c.unreadMain);
  if (waiting) rpc('markRead', { conv: S.active, sub: S.sub || undefined }).catch(() => {});
}

// ---------------------------------------------------------------- sub-chats (topics inside a conversation)
function renderSubs() {
  const c = S.convs.get(S.active), bar = $('subBar');
  if (!c || c.left) { bar.hidden = true; return; }
  const subs = c.subs || [];
  if (S.sub && !subs.some((x) => x.id === S.sub)) S.sub = '';
  const tab = (id, label, unread) => h('button', { class: 'stab' + (S.sub === id ? ' on' : ''), onclick: () => { if (S.sub !== id) openConv(c.id, null, id); } },
    h('span', null, label), unread ? h('b', null, String(unread)) : null,
    id && S.sub === id ? h('i', { title: 'Remove this sub-chat', onclick: (e) => { e.stopPropagation(); removeSub(c, id, label); } }, '×') : null);
  bar.hidden = false;
  bar.replaceChildren(
    ...(subs.length ? [tab('', 'Main', c.unreadMain), ...subs.map((x) => tab(x.id, x.name, x.unread))] : []),
    h('button', { class: 'stab add', title: 'A sub-chat keeps one topic (a project, a client) separate inside this chat', onclick: () => newSub(c) }, subs.length ? '＋' : '＋ Sub-chat'));
}
function newSub(c) {
  const name = h('input', { type: 'text', maxLength: 40, placeholder: 'e.g. Physiomove project, Invoices' });
  modal('New sub-chat', [...field('Name', name, `A separate thread inside your chat with ${convName(c)}. Everyone in this chat sees it.`)],
    { label: 'Create', run: async () => { const sub = await call('createSub', { conv: c.id, name: name.value }); setTimeout(() => openConv(c.id, null, sub.id), 0); } });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('modalCard').querySelector('.actions .primary').click(); });
}
function removeSub(c, id, label) {
  modal(`Remove "${label}"?`, [h('p', { class: 'hint' }, 'Its messages are not deleted: they move to the Main chat. This only changes your computer.')],
    { label: 'Remove', danger: true, run: async () => { await call('deleteSub', { conv: c.id, sub: id }); setTimeout(() => openConv(c.id, null, ''), 0); } });
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
  renderSubs();
  $('groupEditBtn').hidden = c.type !== 'group' || c.left;
  $('chatMenuBtn').hidden = c.type === 'all';
  $('sealBtn').hidden = c.type !== 'dm';
  $('sealBtn').classList.toggle('on', S.sealed);
  $('lockBtn').hidden = c.type !== 'dm';
  $('lockBtn').classList.toggle('on', S.locked);
  $('composer').hidden = !!c.left;
  $('input').placeholder = S.locked ? 'Locked message: the receiver must type their lock password to open it.' : S.sealed ? 'Sealed message: the receiver must click to open it.' : 'Write a message. Paste a screenshot with Ctrl+V.';
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
  if (f.image && ready) {
    const base = f.name.split(/[\\/]/).pop();
    return h('div', { class: 'shot-wrap' },
      h('img', { class: 'shot', src: fileUrl(f.fid), alt: f.name, title: 'Click to enlarge', loading: 'lazy', onclick: () => { viewing = f; $('viewerImg').src = fileUrl(f.fid); $('viewer').hidden = false; } }),
      h('div', { class: 'shot-bar' }, h('span', { title: base }, `${base} · ${fmtSize(f.size)}`),
        desk ? h('button', { onclick: () => saveImage(f) }, 'Save') : h('a', { href: fileUrl(f.fid, true), download: base }, 'Save')));
  }
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
  if (desk && S.me.config.askSave !== false) {
    saveAs = await desk.pickSave(f.name.split(/[\\/]/).pop());
    if (!saveAs) return;
  }
  call('download', { fid: f.fid, saveAs }).catch(() => {});
}

// Save a copy of an image shown in the chat (received or sent) to a place the user picks.
let viewing = null;
async function saveImage(f) {
  if (!desk) { const a = h('a', { href: fileUrl(f.fid, true), download: f.name.split(/[\\/]/).pop() }); document.body.append(a); a.click(); a.remove(); return; }
  const saveAs = await desk.pickSave(f.name.split(/[\\/]/).pop());
  if (!saveAs) return;
  await call('saveCopy', { fid: f.fid, saveAs });
  toast('Image saved');
}

// Several files (or a folder) in one message: pick the folder once, everything lands there with its sub-folders.
async function downloadAll(m) {
  let dir;
  if (desk && S.me.config.askSave !== false) {
    dir = await desk.pickSaveFolder();
    if (!dir) return;
  }
  call('downloadAll', { msg: m.id, dir }).catch(() => {});
}

// New messages pop in. The list is rebuilt on every update, so the animation is resumed from the
// message's age instead of restarting each time.
const freshAt = new Map(), seenAt = new Map(), pingAt = new Map();
// Adds `cls` while an event recorded in `map` is younger than `ms`, resuming the animation from its age.
function recent(map, id, ms, node, cls) {
  const at = map.get(id);
  if (!at) return node;
  const age = Date.now() - at;
  if (age > ms) { map.delete(id); return node; }
  node.classList.add(cls); node.style.setProperty('--age', `-${age}ms`);
  return node;
}
function freshClass(m, node) {
  const born = freshAt.get(m.id);
  if (!born) return node;
  const age = Date.now() - born;
  if (age > 420) { freshAt.delete(m.id); return node; }
  node.classList.add('fresh');
  node.style.setProperty('--age', `-${age}ms`);
  return node;
}

function msgNode(m, c, showWho) {
  const bubble = h('div', { class: 'bubble' });
  // one to three emoji and nothing else: show them big, without a bubble
  if (!m.hidden && !m.files.length && !m.quote && !m.sealed && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(m.body) && [...m.body.matchAll(/\p{Extended_Pictographic}/gu)].length <= 3 && /\p{Extended_Pictographic}/u.test(m.body)) bubble.classList.add('jumbo');
  if (m.hidden) {
    bubble.append(h('div', { class: 'sealed-card' }, m.locked ? '🔑 Locked message' : '🔒 Sealed message',
      h('button', { onclick: () => (m.locked ? openLocked(m) : call('openSealed', { id: m.id })) }, 'Open')));
  } else {
    if (m.sealed) bubble.append(h('span', { class: 'tag' }, m.locked ? '🔑 Locked' : '🔒 Sealed'));
    if (m.quote) bubble.append(h('span', { class: 'quote', onclick: () => jumpTo(m.quote.id) }, h('b', null, memberName(c, m.quote.sender)), h('span', null, m.quote.text)));
    if (m.auto) bubble.append(h('span', { class: 'tag' }, 'Automatic reply'));
    if (m.fwd) bubble.append(h('span', { class: 'tag' }, '↪ Forwarded'));
    if (m.body) bubble.append(...linkify(m.body));
    for (const f of m.files) bubble.append(fileNode(m, f));
    const waiting = m.mine ? 0 : m.files.filter((f) => f.state === 'remote' && !(S.progress.get(f.fid) || {}).state).length;
    if (waiting > 1) bubble.append(h('div', { class: 'file-all' }, h('button', { onclick: () => downloadAll(m) }, `Download all ${waiting} files`)));
  }
  // WhatsApp-style stamp inside the bubble: time, then ticks for my own messages.
  //   ✓ grey = sent, waiting for them to come online   ✓✓ grey = delivered   ✓✓ blue = seen / opened
  let ticks = null, detail = fmtDay(m.ts) + ' ' + fmtTime(m.ts);
  if (m.mine && m.recipients) {
    const seenAll = m.recipients <= 1 ? !!m.readAt : m.seen >= m.recipients;
    const deliveredAll = m.delivered >= m.recipients;
    ticks = recent(seenAt, m.id, 800, h('span', { class: 'ticks' + (seenAll ? ' seen' : '') }, deliveredAll || seenAll ? '✓✓' : '✓'), 'pop');
    if (m.recipients <= 1) detail = m.readAt ? `${m.sealed ? 'Opened' : 'Seen'} ${fmtTime(m.readAt)}` : m.delivered ? (m.sealed ? 'Delivered, not opened yet' : 'Delivered, not seen yet') : 'Waiting for them to come online';
    else detail = `Delivered to ${m.delivered} of ${m.recipients}` + (m.seen ? ` · Seen by ${m.seen}` : '');
  }
  bubble.append(h('span', { class: 'stamp', title: detail, onclick: () => toast(detail) }, fmtTime(m.ts), ticks));
  const acts = !m.hidden && !m.sealed && h('div', { class: 'acts' },
    !c.left && h('button', { title: 'Reply with a quote', onclick: () => { S.replyTo = m; renderReply(); $('input').focus(); } }, '↩'),
    h('button', { title: 'Forward to other people', onclick: () => forwardDialog(m) }, '↪'));
  return freshClass(m, h('div', { class: 'msg' + (m.mine ? ' mine' : ''), 'data-id': m.id },
    showWho && h('div', { class: 'who' }, memberName(c, m.sender)), h('div', { class: 'line' }, bubble, acts)));
}

// Forward a message (text and attachments) to people and groups.
function forwardDialog(m) {
  const people = [...S.peers.values()].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  const groups = [...S.convs.values()].filter((c) => c.type === 'group' && !c.left);
  const row = (conv, seed, label, dot) => h('label', null, h('input', { type: 'checkbox', value: conv }), avatar(seed, label, dot), h('span', null, label));
  const boxes = [
    ...people.map((p) => row('dm:' + p.id, p.id, p.name + (p.dept ? ' · ' + p.dept : '') + (p.online ? '' : ' (offline)'), dotOf(p))),
    ...groups.map((g) => row(g.id, g.id, convName(g) + ' (group)')),
  ];
  const picked = () => boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
  const what = m.body.trim() ? m.body.trim().slice(0, 140) : '';
  const fileNote = m.files.length ? (m.files.length === 1 ? m.files[0].name.split('/').pop() : m.files.length + ' files') : '';
  modal('Forward message', [
    h('div', { class: 'quote' }, h('b', null, 'Message'), h('span', null, [what, fileNote && '📎 ' + fileNote].filter(Boolean).join(' · '))),
    h('label', null, 'Forward to'),
    boxes.length ? h('div', { class: 'pick' }, boxes) : h('p', { class: 'hint' }, 'No teammates found yet.'),
  ], { label: 'Forward', run: async () => {
    const convs = picked();
    if (!convs.length) { toast('Pick at least one person or group'); throw new Error('none'); }
    const n = await call('forward', { id: m.id, convs });
    toast(`Forwarded to ${n} ${n === 1 ? 'chat' : 'chats'}`);
  } });
}

function jumpTo(id) {
  const el = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return toast('That message is further back in the history');
  el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2000);
}

function renderReply() {
  const m = S.replyTo, c = S.convs.get(S.active);
  $('replyBar').hidden = !m;
  if (!m || !c) return;
  $('replyBar').replaceChildren(h('span', { class: 'rtext' }, h('b', null, 'Replying to ' + memberName(c, m.sender) + ': '), m.body.trim() || 'Attachment'),
    h('button', { title: 'Cancel reply', onclick: () => { S.replyTo = null; renderReply(); } }, '×'));
}

// Locked message: the receiver proves it is really them by typing their own lock password.
function lockPasswordDialog(after) {
  const cur = S.me.hasLock ? h('input', { type: 'password', autocomplete: 'off' }) : null;
  const next = h('input', { type: 'password', autocomplete: 'off' }), again = h('input', { type: 'password', autocomplete: 'off' });
  modal(S.me.hasLock ? 'Change lock password' : 'Set your lock password', [
    h('p', { class: 'hint' }, 'You type this password to open locked messages people send you. It stays on this computer; nobody else needs to know it.'),
    ...(cur ? field('Current password', cur) : []), ...field('New password', next), ...field('Repeat new password', again),
  ], { label: 'Save', run: async () => {
    if (next.value !== again.value) { toast('The two passwords do not match'); throw new Error('mismatch'); }
    await call('setLockPassword', { current: cur ? cur.value : '', next: next.value });
    S.me.hasLock = true;
    toast('Lock password saved');
    if (after) setTimeout(after, 0);
  } });
  (cur || next).focus();
}
function openLocked(m) {
  if (!S.me.hasLock) return lockPasswordDialog(() => openLocked(m));
  const pw = h('input', { type: 'password', autocomplete: 'off' });
  modal('Locked message', [...field('Your lock password', pw, 'The sender is told when you open it.')],
    { label: 'Open', run: () => call('openSealed', { id: m.id, password: pw.value }) });
  pw.focus();
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('modalCard').querySelector('.actions .primary').click(); });
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
  if (m.conv !== S.active || (m.sub || '') !== S.sub) return;
  const i = S.msgs.findIndex((x) => x.id === m.id);
  if (i < 0) freshAt.set(m.id, Date.now());
  const seenNow = (x) => (x.recipients <= 1 ? !!x.readAt : x.seen >= x.recipients);
  if (i >= 0 && m.mine && seenNow(m) && !seenNow(S.msgs[i])) seenAt.set(m.id, Date.now());
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
    await call('send', { conv: S.active, text, sealed: S.sealed, locked: S.locked, replyTo: S.replyTo ? S.replyTo.id : undefined, sub: S.sub || undefined, paths: S.pending.map((a) => a.path) });
    $('input').value = ''; autoGrow(); toggleEmoji(false);
    const sb = $('sendBtn'); sb.classList.remove('launch', 'ready'); void sb.offsetWidth; sb.classList.add('launch'); setTimeout(() => sb.classList.remove('launch'), 600);
    S.pending = []; S.sealed = false; S.locked = false; S.replyTo = null; renderPending(); renderReply(); renderHead();
  } catch {} finally { sending = false; $('sendBtn').disabled = false; $('input').focus(); }
}
function autoGrow() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 140) + 'px'; }
$('input').addEventListener('input', autoGrow);
$('input').addEventListener('input', () => $('sendBtn').classList.toggle('ready', !!$('input').value.trim()));
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$('sendBtn').addEventListener('click', send);
$('sealBtn').addEventListener('click', () => { S.sealed = !S.sealed; if (!S.sealed) S.locked = false; renderHead(); });
$('lockBtn').addEventListener('click', () => { S.locked = !S.locked; S.sealed = S.locked || S.sealed; renderHead(); });
// ---------------------------------------------------------------- emoji picker
const emojiSections = [];
function buildEmoji() {
  if (emojiSections.length || !window.EMOJI) return;
  const tabs = [h('button', { title: 'Recently used', 'data-i': 0 }, '🕘')];
  const grid = $('emojiGrid');
  const recent = h('section', null, h('h5', null, 'Recently used'), h('div', { class: 'egrid', id: 'emojiRecent' }));
  grid.append(recent); emojiSections.push(recent);
  window.EMOJI.forEach(([name, icon, lines], gi) => {
    const cells = lines.split('\n').map((l) => { const [e, n] = l.split('|'); return h('button', { class: 'e', title: n, 'data-n': n }, e); });
    const sec = h('section', null, h('h5', null, name), h('div', { class: 'egrid' }, cells));
    grid.append(sec); emojiSections.push(sec);
    tabs.push(h('button', { title: name, 'data-i': gi + 1 }, icon));
  });
  grid.append(h('section', { id: 'emojiFound', hidden: true }, h('h5', null, 'Results'), h('div', { class: 'egrid' })));
  $('emojiTabs').append(...tabs);
  drawRecentEmoji();
}
function drawRecentEmoji() {
  const list = (S.me && S.me.config.recentEmoji) || [];
  $('emojiRecent').replaceChildren(...list.map((e) => h('button', { class: 'e' }, e)));
  emojiSections[0].hidden = !list.length || !!$('emojiSearch').value.trim();
}
function toggleEmoji(show) {
  const pop = $('emojiPop');
  const open = show === undefined ? pop.hidden : show;
  if (open) { buildEmoji(); drawRecentEmoji(); }
  pop.hidden = !open;
  $('emojiBtn').classList.toggle('on', open);
  if (open && !matchMedia('(max-width: 720px)').matches) $('emojiSearch').focus();
}
function insertEmoji(e) {
  const t = $('input'), a = t.selectionStart ?? t.value.length, b = t.selectionEnd ?? t.value.length;
  t.value = t.value.slice(0, a) + e + t.value.slice(b);
  t.selectionStart = t.selectionEnd = a + e.length;
  autoGrow();
  const list = [e, ...((S.me.config.recentEmoji || []).filter((x) => x !== e))].slice(0, 24);
  S.me.config.recentEmoji = list;
  rpc('setRecentEmoji', { list }).catch(() => {});
}
$('emojiBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleEmoji(); });
$('emojiGrid').addEventListener('click', (e) => { const b = e.target.closest('button.e'); if (b) insertEmoji(b.textContent); });
$('emojiTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $('emojiSearch').value = ''; filterEmoji();
  const sec = emojiSections[Number(b.dataset.i)];
  if (sec && !sec.hidden) $('emojiGrid').scrollTop = sec.offsetTop - $('emojiGrid').offsetTop;
});
function filterEmoji() {
  const q = $('emojiSearch').value.trim().toLowerCase(), found = $('emojiFound');
  for (const sec of emojiSections) sec.hidden = !!q;
  found.hidden = !q;
  if (!q) return drawRecentEmoji();
  const hits = [...$('emojiGrid').querySelectorAll('section:not(#emojiFound) button.e[data-n]')].filter((b) => b.dataset.n.includes(q)).slice(0, 240);
  found.lastChild.replaceChildren(...hits.map((b) => h('button', { class: 'e', title: b.dataset.n }, b.textContent)));
  found.firstChild.textContent = hits.length ? 'Results' : 'No emoji found';
  $('emojiGrid').scrollTop = 0;
}
$('emojiSearch').addEventListener('input', filterEmoji);
document.addEventListener('mousedown', (e) => { if (!$('emojiPop').hidden && !e.target.closest('#emojiPop, #emojiBtn')) toggleEmoji(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('emojiPop').hidden) { toggleEmoji(false); $('input').focus(); } });

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
$('viewerSave').addEventListener('click', (e) => { e.stopPropagation(); if (viewing) saveImage(viewing).catch(() => {}); });
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

// Profile photo cropper: drag to position, slider (or mouse wheel) to zoom; the circle is what teammates see.
function cropPhoto(file) {
  return new Promise((resolve, reject) => {
    const V = 264, OUT = 256, url = URL.createObjectURL(file);
    const img = h('img', { alt: '', draggable: false });
    const view = h('div', { class: 'crop-view' }, img);
    const zoom = h('input', { type: 'range', min: 100, max: 500, value: 100, step: 1 });
    let w = 0, hgt = 0, s0 = 1, ox = 0, oy = 0;
    const scale = () => s0 * zoom.value / 100;
    const place = () => {
      const W = w * scale(), H = hgt * scale();
      ox = Math.min(0, Math.max(V - W, ox)); oy = Math.min(0, Math.max(V - H, oy));
      Object.assign(img.style, { width: W + 'px', height: H + 'px', transform: `translate(${ox}px, ${oy}px)` });
    };
    const rezoom = (before) => { const k = scale() / before; ox = V / 2 - (V / 2 - ox) * k; oy = V / 2 - (V / 2 - oy) * k; place(); };
    let last = scale();
    zoom.addEventListener('input', () => { rezoom(last); last = scale(); });
    view.addEventListener('wheel', (e) => { e.preventDefault(); zoom.value = Math.min(500, Math.max(100, Number(zoom.value) - Math.sign(e.deltaY) * 12)); rezoom(last); last = scale(); }, { passive: false });
    let drag = null;
    view.addEventListener('pointerdown', (e) => { drag = { x: e.clientX - ox, y: e.clientY - oy }; view.setPointerCapture(e.pointerId); });
    view.addEventListener('pointermove', (e) => { if (drag) { ox = e.clientX - drag.x; oy = e.clientY - drag.y; place(); } });
    view.addEventListener('pointerup', () => { drag = null; });
    const done = (v) => { layer.remove(); URL.revokeObjectURL(url); resolve(v); };
    const layer = h('div', { id: 'crop' }, h('div', { class: 'crop-card' },
      h('h2', null, 'Adjust your photo'), view,
      h('p', { class: 'hint' }, 'Drag the picture to move it. Use the slider to zoom.'),
      h('div', { class: 'range-row' }, h('span', null, '−'), zoom, h('span', null, '+')),
      h('div', { class: 'actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button', { class: 'primary', type: 'button', onclick: () => {
          const cv = h('canvas', { width: OUT, height: OUT }), k = scale();
          cv.getContext('2d').drawImage(img, -ox / k, -oy / k, V / k, V / k, 0, 0, OUT, OUT);
          cv.toBlob((b) => done(b), 'image/jpeg', 0.88);
        } }, 'Use this photo'))));
    img.onload = () => { w = img.naturalWidth; hgt = img.naturalHeight; s0 = V / Math.min(w, hgt); ox = (V - w * s0) / 2; oy = (V - hgt * s0) / 2; last = scale(); place(); };
    img.onerror = () => { layer.remove(); reject(new Error('Could not open that picture')); };
    img.src = url;
    document.body.append(layer);
  });
}

$('meBtn').addEventListener('click', () => {
  const name = h('input', { type: 'text', value: S.me.name, maxLength: 40 });
  // Department: pick one the team already uses (keeps the member list tidy), or type a new one.
  const known = [...new Set([...S.peers.values()].map((p) => p.dept).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const deptCustom = h('input', { type: 'text', maxLength: 40, placeholder: 'Type your department, e.g. Video Editing', hidden: true });
  const deptPick = h('select', { onchange: () => { deptCustom.hidden = deptPick.value !== '\u0000'; if (!deptCustom.hidden) deptCustom.focus(); } },
    h('option', { value: '' }, 'No department'), ...known.map((d) => h('option', { value: d }, d)), h('option', { value: '\u0000' }, 'Custom department…'));
  if (!S.me.dept || known.includes(S.me.dept)) deptPick.value = S.me.dept;
  else { deptPick.value = '\u0000'; deptCustom.hidden = false; deptCustom.value = S.me.dept; }
  const dept = { get value() { return deptPick.value === '\u0000' ? deptCustom.value : deptPick.value; } };
  const status = h('select', null, h('option', { value: 'online' }, 'Online'), h('option', { value: 'away' }, 'Away (absence mode)'));
  status.value = S.me.status;
  const msg = h('input', { type: 'text', value: S.me.absenceMsg, maxLength: 200, placeholder: 'e.g. In a meeting, back at 4 pm' });
  // profile picture: cropped to a square and shrunk in the browser before it is sent to the team
  const preview = h('span', null, avatar(S.me.id, S.me.name));
  const photo = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: async () => {
    const file = photo.files[0]; photo.value = '';
    if (!file) return;
    try {
      const blob = await cropPhoto(file);
      if (!blob) return;
      const r = await fetch(`/avatar?token=${TOKEN}`, { method: 'POST', body: blob });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not use that picture');
      S.me = (await rpc('getState')).me; renderMe(); preview.replaceChildren(avatar(S.me.id, S.me.name));
    } catch (e) { toast(e.message || 'Could not use that picture'); }
  } });
  const photoRow = h('div', { class: 'photo-row' }, preview,
    h('button', { class: 'ghost', type: 'button', onclick: () => photo.click() }, 'Choose a photo…'),
    h('button', { class: 'ghost', type: 'button', onclick: async () => { await call('removeAvatar'); S.me = (await rpc('getState')).me; renderMe(); preview.replaceChildren(avatar(S.me.id, S.me.name)); } }, 'Remove'), photo);
  modal('Your profile', [
    h('label', null, 'Profile photo'), photoRow,
    ...field('Display name', name), h('label', null, 'Department'), deptPick, deptCustom,
    h('p', { class: 'hint' }, 'Teammates are grouped by department in the member list. The list shows departments your team already uses; choose Custom to add a new one.'),
    ...field('Status', status), ...field('Away message', msg, 'While you are away, people who message you get this as an automatic reply.'),
    h('label', null, 'Lock password'),
    h('button', { class: 'ghost', type: 'button', onclick: () => lockPasswordDialog() }, S.me.hasLock ? 'Change lock password' : 'Set lock password'),
    h('p', { class: 'hint' }, 'Needed to open locked (🔑) messages that people send you.'),
    h('p', { class: 'hint code' }, 'Your ID: ' + S.me.id),
  ], { label: 'Save', run: () => call('setProfile', { name: name.value, dept: dept.value, status: status.value, absenceMsg: msg.value }) });
});

// ---------------------------------------------------------------- backup and restore
function backupKeyDialog(after) {
  const k1 = h('input', { type: 'password', autocomplete: 'off' }), k2 = h('input', { type: 'password', autocomplete: 'off' });
  modal(S.me.hasBackupKey ? 'Change backup key' : 'Set a backup key', [
    h('p', { class: 'hint' }, 'Backups are locked with this key. Keep it simple enough to remember (at least 4 characters) and write it down: without it a backup cannot be opened.'),
    ...field('Backup key', k1), ...field('Repeat it', k2),
  ], { label: 'Save', run: async () => {
    if (k1.value !== k2.value) { toast('The two keys do not match'); throw new Error('mismatch'); }
    await call('setBackupKey', { key: k1.value });
    S.me.hasBackupKey = true;
    toast('Backup key saved');
    if (after) setTimeout(after, 0);
  } });
}
async function backupNow() {
  if (!S.me.hasBackupKey) return backupKeyDialog(backupNow);
  let target;
  if (desk) { target = await desk.pickSave(`TeamLink-backup-${new Date().toISOString().slice(0, 10)}.tlbackup`); if (!target) return; }
  const file = await call('createBackup', { target });
  modal('Backup saved', [h('p', null, 'Your chats, settings and identity are saved in:'), h('p', { class: 'hint code' }, file),
    h('p', { class: 'hint' }, 'Copy this file to a pen drive or another computer to be safe. Received files are not part of the backup.')], { label: 'OK', run: async () => {} });
}
function restoreDialog(path, fileName) {
  const key = h('input', { type: 'password', autocomplete: 'off' });
  modal('Restore from backup', [
    h('p', { class: 'hint' }, `File: ${fileName}`),
    ...field('Backup key', key, 'Restoring replaces the chats and settings on this computer with the ones from the backup. The current data is kept once, in case you need to go back.'),
  ], { label: 'Restore', danger: true, run: async () => {
    const info = await call('restoreBackup', { path, key: key.value });
    setTimeout(() => modal('Restore ready', [h('p', null, `Backup of ${info.name || 'your account'}${info.made ? ' from ' + new Date(info.made).toLocaleString() : ''} is ready.`),
      h('p', { class: 'hint' }, desk ? 'TeamLink will restart to finish.' : 'Close and start TeamLink again to finish.')],
    { label: desk ? 'Restart now' : 'OK', run: async () => { if (desk) desk.restart(); } }), 0);
  } });
  key.focus();
}
function backupBox() {
  const pick = h('input', { type: 'file', accept: '.tlbackup', hidden: true, onchange: async () => {
    const file = pick.files[0]; pick.value = '';
    if (!file) return;
    try {
      const r = await fetch(`/upload?token=${TOKEN}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      if (!r.ok) throw new Error('Could not read that file');
      restoreDialog((await r.json()).path, file.name);
    } catch (e) { toast(e.message); }
  } });
  const status = !S.me.hasBackupKey ? 'No backup key set yet, so nothing is being backed up.'
    : S.me.lastBackup ? `Last backup: ${new Date(S.me.lastBackup).toLocaleString()}` : 'Backup key is set. No backup made yet.';
  return h('div', null,
    h('p', { class: 'hint' }, status),
    h('div', { class: 'btn-row' },
      h('button', { class: 'ghost', type: 'button', onclick: backupNow }, 'Back up now'),
      h('button', { class: 'ghost', type: 'button', onclick: () => pick.click() }, 'Restore from a backup…'),
      h('button', { class: 'ghost', type: 'button', onclick: () => backupKeyDialog() }, S.me.hasBackupKey ? 'Change backup key' : 'Set backup key'), pick),
    h('p', { class: 'hint' }, `With a key set, TeamLink also saves a backup by itself once a day in: ${S.me.backupDir}`));
}

// ---------------------------------------------------------------- popup settings (desktop app)
function popupDialog() {
  const p = { ...S.me.config.popupPrefs };
  let timer;
  const save = (patch) => {
    Object.assign(p, patch); S.me.config.popupPrefs = { ...p };
    rpc('setPopupPrefs', patch).then(() => { clearTimeout(timer); timer = setTimeout(() => desk && desk.testPopup(), 150); }).catch((e) => toast(e.message));
    draw();
  };
  const POS = [['top-left', '↖'], ['top-center', '↑'], ['top-right', '↗'], [null], ['middle-center', '●'], [null], ['bottom-left', '↙'], ['bottom-center', '↓'], ['bottom-right', '↘']];
  const grid = h('div', { class: 'posgrid' });
  const sel = (key, options) => { const el = h('select', { onchange: () => save({ [key]: /^\d+$/.test(el.value) ? Number(el.value) : el.value }) }, options.map(([v, label]) => h('option', { value: v }, label))); return el; };
  const size = sel('size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Extra large']]);
  const design = sel('design', [['glass', 'Liquid glass'], ['solid', 'Solid card'], ['minimal', 'Minimal pill'], ['neon', 'Neon']]);
  const tone = sel('tone', [['auto', 'Same as my theme'], ['dark', 'Dark'], ['light', 'Light']]);
  const hide = sel('hideAfter', [['0', 'Stay until I click it'], ['5', 'Hide after 5 seconds'], ['10', 'Hide after 10 seconds'], ['20', 'Hide after 20 seconds'], ['60', 'Hide after 1 minute']]);
  const swatches = h('div', { class: 'swatches' });
  const custom = h('input', { type: 'color', title: 'Any colour', onchange: () => save({ color: custom.value }) });
  const sound = h('input', { type: 'checkbox', onchange: () => save({ sound: sound.checked }) });
  const text = h('input', { type: 'checkbox', onchange: () => save({ showText: text.checked }) });
  function draw() {
    size.value = p.size; design.value = p.design; tone.value = p.tone; hide.value = String(p.hideAfter); sound.checked = p.sound; text.checked = p.showText;
    custom.value = p.color || S.me.config.appearance.accent;
    grid.replaceChildren(...POS.map(([id, arrow]) => (id ? h('button', { class: 'pos' + (p.pos === id ? ' on' : ''), type: 'button', title: id.replace('-', ' '), onclick: () => save({ pos: id }) }, arrow) : h('span'))));
    const themeDot = h('button', { class: 'swatch theme-dot' + (!p.color ? ' on' : ''), type: 'button', title: 'Same as my theme', onclick: () => save({ color: '' }) }, 'A');
    swatches.replaceChildren(themeDot, ...ACCENTS.map((c) => { const b = h('button', { class: 'swatch' + (c === p.color ? ' on' : ''), type: 'button', title: c, onclick: () => save({ color: c }) }); b.style.background = c; return b; }), custom);
  }
  draw();
  modal('Popup settings', [
    h('p', { class: 'hint' }, 'Every change shows a test popup on your screen.'),
    h('label', null, 'Where on the screen'), grid,
    ...field('Size', size), ...field('Design', design),
    h('label', null, 'Colour'), swatches,
    ...field('Light or dark', tone),
    ...field('How long it stays', hide),
    h('label', null, sound, ' Play a sound'),
    h('label', null, text, ' Show the message text (off: only who sent it)'),
  ], { label: 'Done', run: async () => {} },
  h('button', { class: 'ghost', type: 'button', onclick: () => desk.testPopup() }, 'Show test popup'));
}

function openSettings() {
  const c = S.me.config;
  const team = h('input', { type: 'text', value: c.teamCode, maxLength: 100, placeholder: 'At least 8 characters, given to you by your team' });
  const relay = h('input', { type: 'text', value: c.relayUrl, placeholder: 'wss://relay.yourcompany.com' });
  const token = h('input', { type: 'password', value: c.relayToken });
  const extra = h('textarea', { rows: 2, value: (c.extraPeers || []).join('\n'), placeholder: '192.168.2.15\n10.0.5.255' });
  const dl = h('input', { type: 'text', value: c.downloadDir });
  const autostart = desk ? h('input', { type: 'checkbox' }) : null;
  const popup = desk ? h('input', { type: 'checkbox', checked: c.popup !== false }) : null;
  const askSave = desk ? h('input', { type: 'checkbox', checked: c.askSave !== false }) : null;
  let autostartWas = null; // stays null until the real value is known, so saving never changes it by accident
  if (desk) desk.getAutostart().then((v) => { autostart.checked = v; autostartWas = v; });
  modal('Settings', [
    h('button', { class: 'ghost', type: 'button', onclick: appearanceDialog }, '🎨 Appearance: theme, colour, font, text size, wallpaper…'),
    h('h3', null, 'Team'),
    ...field('Team code', team, 'Everyone in the team must enter exactly the same code. Without the right code a computer cannot see the team, join it or read anything. Keep it secret and never post it publicly.'),
    h('h3', null, 'Remote teammates (optional)'),
    ...field('Relay address', relay, 'Only needed for people outside the office network. Leave empty for LAN only.'),
    ...field('Relay token', token),
    h('h3', null, 'Network'),
    ...field('Extra addresses to search', extra, 'One IP or broadcast address per line, for other subnets or VPNs where automatic discovery does not reach.'),
    h('h3', null, 'Backup and restore'),
    backupBox(),
    h('h3', null, 'Files'),
    ...field('Save received files to', dl),
    desk && h('label', null, askSave, ' Ask where to save each file (off: save straight to the folder above)'),
    desk && h('label', null, popup, ' Show a popup on screen when a message arrives'),
    desk && h('button', { class: 'ghost', type: 'button', onclick: popupDialog }, '🔔 Popup settings: place, size, colour, design…'),
    desk && h('label', null, autostart, ' Start TeamLink when I sign in to this computer'),
    desk && h('h3', null, 'Updates'),
    desk && updateRow(),
  ], { label: 'Save', run: async () => {
    await call('setConfig', { teamCode: team.value, relayUrl: relay.value, relayToken: token.value, extraPeers: extra.value, downloadDir: dl.value, popup: popup ? popup.checked : undefined, askSave: askSave ? askSave.checked : undefined });
    if (desk && autostartWas !== null && autostart.checked !== autostartWas) desk.setAutostart(autostart.checked);
  } });
}
$('settingsBtn').addEventListener('click', openSettings);
$('themeBtn').addEventListener('click', appearanceDialog);
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
  const lockBox = h('input', { type: 'checkbox' });
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
    h('label', null, lockBox, ' 🔑 Locked: each person must also type their own lock password'),
  ], { label: 'Send', run: async () => {
    const ids = picked();
    if (!ids.length) { toast('Pick at least one person'); throw new Error('none'); }
    if (files.some((f) => !f.path)) { toast('Still adding attachments…'); throw new Error('busy'); }
    if (!text.value.trim() && !files.length) { toast('Write a message or attach a file first'); throw new Error('empty'); }
    for (const id of ids) await call('send', { conv: 'dm:' + id, text: text.value, sealed: sealed.checked, locked: lockBox.checked, paths: files.map((f) => f.path) });
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
if (desk && desk.onOpenSend) desk.onOpenSend(() => { if (S.me && S.me.config.teamCode) multiDialog(); });
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
