'use strict';
/* WHATSAPP-INTAKE: the whole "WhatsApp Inbox" interface lives in this file (plus intake.css).
   It uses the helpers of app.js (h, $, S, rpc, call, modal, toast, field, avatar, peerName, fmtWhen, fmtTime, linkify).
   To remove the feature see docs/whatsapp-intake.md. */
const I = { view: 'mine', type: '', sender: '', chat: '', status: 'open', assignee: '', q: '', items: [], senders: [], chats: [], open: null, thread: [], unread: 0, shown: false };
const I_TYPES = { review: ['Review', '#7c3aed'], update: ['Update', '#0891b2'], new_task: ['New task', '#16a34a'], deadline: ['Deadline', '#dc2626'], question: ['Question', '#ca8a04'], file: ['File', '#475569'] };
const I_STATUS = { new: 'New', in_progress: 'In progress', done: 'Done' };
const iName = (id) => (id ? peerName(id) : 'Nobody');

function intakeBadge() {
  const b = $('inboxBadge');
  b.hidden = !I.unread; b.textContent = String(I.unread);
  $('inboxBtn').classList.toggle('active', I.shown);
}
function intakeInit(st) { I.unread = st.intakeUnread || 0; $('inboxNav').hidden = false; intakeBadge(); if (I.shown) intakeLoad(); }
function intakeClose() { if (!I.shown) return; I.shown = false; $('inbox').hidden = true; intakeBadge(); }

async function intakeOpen(focusId) {
  if (S.active) closeChat();
  I.shown = true;
  if (focusId) { I.view = 'team'; I.status = ''; I.open = focusId; }
  document.body.classList.add('in-chat');
  $('empty').hidden = true; $('chat').hidden = true; $('inbox').hidden = false;
  intakeBadge();
  await intakeLoad();
  if (focusId) { await intakeExpand(focusId, true); const el = document.querySelector(`[data-item="${CSS.escape(focusId)}"]`); if (el) el.scrollIntoView({ block: 'center' }); }
}

async function intakeLoad() {
  const r = await call('intakeList', { view: I.view, type: I.type, sender: I.sender, chat: I.chat, status: I.status, assignee: I.assignee, q: I.q });
  Object.assign(I, { items: r.items, senders: r.senders, chats: r.chats });
  intakeRender();
}
let intakeTimer;
function intakeRefresh() {
  clearTimeout(intakeTimer);
  intakeTimer = setTimeout(async () => {
    try { I.unread = (await rpc('intakeState')).unread; } catch {}
    intakeBadge();
    if (!I.shown) return;
    await intakeLoad();
    if (I.open) { try { I.thread = (await rpc('intakeGet', { id: I.open })).thread; intakeRender(); } catch {} }
  }, 250);
}
// Events pushed by the engine: live refresh, and a notice for high-priority or newly assigned items.
function intakeEvent(event, d) {
  if (event === 'intake') return intakeRefresh();
  if (event === 'intakeAlert') toast(d.reason === 'assigned' ? `Assigned to you: ${d.title}` : `High priority from ${d.sender}: ${d.title}`);
}

async function intakeExpand(id, keepOpen) {
  if (I.open === id && !keepOpen) { I.open = null; return intakeRender(); }
  I.open = id; I.thread = [];
  intakeRender();
  const it = I.items.find((x) => x.id === id);
  if (it && !it.seen) { it.seen = true; rpc('intakeSeen', { id }).catch(() => {}); }
  try { I.thread = (await rpc('intakeGet', { id })).thread; } catch {}
  if (I.open === id) intakeRender();
}

function intakeSelect(key, options, title) {
  const el = h('select', { title, onchange: () => { I[key] = el.value; intakeLoad(); } }, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = I[key];
  return el;
}

function intakeCard(it) {
  const [label, color] = I_TYPES[it.type] || ['Other', '#475569'];
  const badge = h('span', { class: 'ibadge' }, label); badge.style.background = color;
  const open = I.open === it.id;
  const overdue = it.due && it.status !== 'done' && it.due < Date.now();
  const head = h('div', { class: 'ihead', onclick: () => intakeExpand(it.id) },
    h('div', { class: 'itop' }, badge, it.priority === 'high' && h('span', { class: 'ihigh' }, 'High priority'), h('b', { class: 'ititle' }, it.title), h('span', { class: 'itime' }, fmtWhen(it.time))),
    h('div', { class: 'isub' }, h('span', null, it.from), ' · ', h('span', null, it.chat), it.project && [' · ', h('span', null, it.project)]),
    h('div', { class: 'ichips' },
      h('span', { class: 'ichip st-' + it.status }, I_STATUS[it.status] || it.status),
      h('span', { class: 'ichip' }, '👤 ' + iName(it.assignee)),
      it.due && h('span', { class: 'ichip' + (overdue ? ' late' : '') }, '📅 ' + new Date(it.due).toLocaleDateString([], { day: 'numeric', month: 'short' }) + (overdue ? ' (overdue)' : '')),
      it.comments ? h('span', { class: 'ichip' }, '💬 ' + it.comments) : null,
      it.reporters.length > 1 && h('span', { class: 'ichip', title: 'Reported by ' + it.reporters.map(iName).join(', ') }, `${it.reporters.length} reporters`)));
  const card = h('div', { class: 'icard' + (it.seen ? '' : ' unseen') + (it.priority === 'high' ? ' high' : '') + (open ? ' open' : '') + (it.status === 'done' ? ' done' : ''), 'data-item': it.id }, head);
  if (!open) return card;

  const people = [[S.me.id, S.me.name + ' (me)'], ...[...S.peers.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.id, p.name])];
  const assign = h('select', { onchange: () => call('intakeUpdate', { id: it.id, assignee: assign.value }) }, h('option', { value: '' }, 'Nobody'), people.map(([id, n]) => h('option', { value: id }, n)));
  assign.value = it.assignee || '';
  const status = h('select', { onchange: () => call('intakeUpdate', { id: it.id, status: status.value }) }, Object.entries(I_STATUS).map(([v, l]) => h('option', { value: v }, l)));
  status.value = it.status;
  const pad = (n) => String(n).padStart(2, '0'), d = it.due ? new Date(it.due) : null;
  const due = h('input', { type: 'date', value: d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '',
    onchange: () => call('intakeUpdate', { id: it.id, due: due.value ? new Date(due.value + 'T18:00:00').getTime() : null }) });
  const note = h('input', { type: 'text', maxLength: 4000, placeholder: 'Add a comment' });
  const addNote = async () => { if (!note.value.trim()) return; await call('intakeComment', { id: it.id, text: note.value }); note.value = ''; };
  note.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });
  card.append(h('div', { class: 'ibody' },
    h('div', { class: 'itext' }, linkify(it.text)),
    it.links.length ? h('div', { class: 'ilinks' }, it.links.map((l) => { let host = l; try { host = new URL(l).hostname.replace(/^www\./, ''); } catch {} return h('a', { href: l, target: '_blank', rel: 'noopener noreferrer', title: l }, '🔗 ' + host); })) : null,
    h('p', { class: 'hint' }, `WhatsApp message of ${new Date(it.time).toLocaleString()} · reported by ${it.reporters.map(iName).join(', ')}`),
    h('div', { class: 'iacts' },
      h('label', null, 'Assign to', assign), h('label', null, 'Status', status), h('label', null, 'Due date', due),
      it.status !== 'done' ? h('button', { class: 'primary', onclick: () => call('intakeUpdate', { id: it.id, status: 'done' }) }, 'Mark done') : h('button', { class: 'ghost', onclick: () => call('intakeUpdate', { id: it.id, status: 'in_progress' }) }, 'Reopen')),
    h('div', { class: 'ithread' }, I.thread.map((c) => h('div', { class: 'inote' }, h('b', null, iName(c.author)), h('span', { class: 'itime' }, fmtWhen(c.ts)), h('div', null, linkify(c.text))))),
    h('div', { class: 'inoterow' }, note, h('button', { class: 'ghost', onclick: addNote }, 'Comment'))));
  return card;
}

function intakeRender() {
  const tab = (id, label) => h('button', { class: 'stab' + (I.view === id ? ' on' : ''), onclick: () => { I.view = id; intakeLoad(); } }, label);
  const search = h('input', { type: 'search', placeholder: 'Search title, message, sender, group', value: I.q });
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { I.q = search.value; intakeLoad().then(() => { const s = $('inbox').querySelector('input[type=search]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 300); });
  const people = [[S.me.id, 'Me'], ...[...S.peers.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.id, p.name])];
  $('inbox').replaceChildren(
    h('header', { class: 'ibar' },
      h('button', { id: 'inboxBack', class: 'icon-btn', title: 'Back', onclick: () => { intakeClose(); document.body.classList.remove('in-chat'); $('empty').hidden = false; } }, '←'),
      h('b', { class: 'ihdr' }, '📥 WhatsApp Inbox'), tab('mine', 'Mine'), tab('team', 'Team'),
      h('span', { class: 'ispace' }),
      h('button', { class: 'ghost', onclick: async () => { await call('intakeSeen', { all: true }); } }, 'Mark all seen'),
      h('button', { class: 'icon-btn', title: 'WhatsApp Intake settings', onclick: intakeSettings }, '⚙')),
    h('div', { class: 'ifilters' }, search,
      intakeSelect('type', [['', 'All types'], ...Object.entries(I_TYPES).map(([v, [l]]) => [v, l])], 'Type'),
      intakeSelect('sender', [['', 'All senders'], ...I.senders.map((s) => [s, s])], 'Sender'),
      intakeSelect('chat', [['', 'All groups'], ...I.chats.map((s) => [s, s])], 'Group'),
      intakeSelect('status', [['open', 'Open'], ['', 'Any status'], ...Object.entries(I_STATUS)], 'Status'),
      intakeSelect('assignee', [['', 'Any assignee'], ['none', 'Unassigned'], ...people], 'Assignee')),
    h('div', { class: 'ilist' }, I.items.length ? I.items.map(intakeCard)
      : h('div', { class: 'notice' }, I.view === 'mine' ? 'Nothing here for you. Items assigned to you, or reported by you and not assigned to anyone, appear here.' : 'No WhatsApp items match these filters yet.')));
}

// ---------------------------------------------------------------- settings (mine + team admin)
async function intakeCopy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select the text and copy it'); } }

async function intakeSettings() {
  const st = await call('intakeState');
  const mine = st.mine, team = st.team, url = mine.urls[0];
  const onoff = h('input', { type: 'checkbox', checked: mine.enabled, onchange: async () => { await call('intakeSetEnabled', { on: onoff.checked }); intakeSettings(); } });
  const keyBox = h('div');
  const showKey = (key) => keyBox.replaceChildren(h('p', { class: 'hint' }, 'Copy your key now. It is shown only this once; TeamLink keeps just a fingerprint of it.'),
    h('div', { class: 'ikeyrow' }, h('input', { id: 'intakeKeyValue', type: 'text', readOnly: true, value: key, onfocus: (e) => e.target.select() }), h('button', { class: 'ghost', type: 'button', onclick: () => intakeCopy(key) }, 'Copy')));
  const curl = `curl -X POST "${url}" \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"items":[{"source_id":"test-1","title":"Test from curl","type":"new_task","from":"Chinmay","chat":"Axit\\u0027s Creatives","time":"${new Date().toISOString().slice(0, 19)}+05:30","text":"Yeh ek test message hai","links":["https://drive.google.com/"],"priority":"high"}]}'`;
  const body = [
    h('h3', null, 'My intake'),
    h('label', null, onoff, ' Receive WhatsApp items on this computer'),
    h('p', { class: 'hint' }, !mine.enabled ? 'Off. Nothing is listening and your key is not accepted.' : mine.running ? `On. Listening on port ${mine.port}.` : `Could not start: ${mine.error || 'unknown error'}`),
    h('label', null, 'My intake URL (give this to the agent)'),
    ...mine.urls.map((u) => h('div', { class: 'ikeyrow' }, h('input', { type: 'text', readOnly: true, value: u, onfocus: (e) => e.target.select() }), h('button', { class: 'ghost', type: 'button', onclick: () => intakeCopy(u) }, 'Copy'))),
    h('p', { class: 'hint' }, 'An agent on this same computer can use the 127.0.0.1 address. Other computers on the office network use the address with this computer\'s IP.'),
    h('label', null, 'My API key'),
    h('p', { class: 'hint' }, mine.hasKey ? `Active key starts with ${mine.keyPrefix}… (created ${new Date(mine.keyMade).toLocaleDateString()})` : 'No key yet.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'ghost', type: 'button', onclick: async () => { const r = await call('intakeNewKey'); showKey(r.key); } }, mine.hasKey ? 'Regenerate key (the old one stops working)' : 'Generate key'),
      mine.hasKey && h('button', { class: 'ghost', type: 'button', onclick: async () => { await call('intakeRevokeKey'); intakeSettings(); } }, 'Revoke key')),
    keyBox,
    h('p', { class: 'hint' }, mine.lastReceived ? `Last item received: ${new Date(mine.lastReceived).toLocaleString()}` : 'Nothing received yet.'),
    h('label', null, 'Test it'), h('textarea', { rows: 5, readOnly: true, class: 'code', value: curl, onfocus: (e) => e.target.select() }),
    h('h3', null, 'Team'),
  ];
  if (team.canClaim) body.push(h('p', { class: 'hint' }, 'The team has no intake admin yet. The admin sets who each WhatsApp sender and group maps to, sees everyone\'s intake, and can revoke keys. The first person to click this becomes the admin and can add others.'),
    h('button', { class: 'ghost', type: 'button', onclick: async () => { await call('intakeClaimAdmin'); intakeSettings(); } }, 'Become the team admin'));
  else if (!team.isAdmin) body.push(h('p', { class: 'hint' }, `Admin: ${team.admins.map(iName).join(', ')}. Team intake is ${team.enabled ? 'on' : 'switched off by the admin'}. ${team.rules.length} mapping rule(s).`));
  else body.push(...intakeAdmin(st));
  modal('WhatsApp Intake', body, { label: 'Done', run: async () => {} });
}

function intakeAdmin(st) {
  const team = st.team;
  const people = [[S.me.id, S.me.name + ' (me)'], ...[...S.peers.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.id, p.name])];
  const teamOn = h('input', { type: 'checkbox', checked: team.enabled, onchange: async () => { await call('intakeUpdateTeam', { enabled: teamOn.checked }); toast(teamOn.checked ? 'Team intake is on' : 'Team intake is off for everyone'); } });
  const rules = team.rules.map((r) => ({ ...r, members: [...(r.members || [])] }));
  const box = h('div', { class: 'irules' });
  const draw = () => box.replaceChildren(...rules.map((r, i) => {
    const kind = h('select', { onchange: () => { r.kind = kind.value; draw(); } }, h('option', { value: 'sender' }, 'Sender'), h('option', { value: 'chat' }, 'Group')); kind.value = r.kind;
    const match = h('input', { type: 'text', value: r.match, placeholder: r.kind === 'chat' ? 'WhatsApp group name' : 'WhatsApp sender name', oninput: () => { r.match = match.value; } });
    const user = h('select', { title: 'Assign to', onchange: () => { r.user = user.value; } }, h('option', { value: '' }, r.kind === 'chat' ? 'Assign: reporter' : 'Assign: (none)'), people.map(([id, n]) => h('option', { value: id }, n))); user.value = r.user || '';
    const project = h('input', { type: 'text', value: r.project || '', placeholder: 'Project', oninput: () => { r.project = project.value; } });
    const row = h('div', { class: 'irule' }, kind, match, user, project, h('button', { class: 'ghost', type: 'button', title: 'Remove', onclick: () => { rules.splice(i, 1); draw(); } }, '×'));
    if (r.kind !== 'chat') return row;
    const vis = h('select', { multiple: true, size: Math.min(4, people.length), title: 'Who sees items from this group. Select nobody for the whole team.', onchange: () => { r.members = [...vis.selectedOptions].map((o) => o.value); } }, people.map(([id, n]) => h('option', { value: id, selected: r.members.includes(id) }, n)));
    return h('div', null, row, h('div', { class: 'irulevis' }, h('span', { class: 'hint' }, 'Visible to (Ctrl+click; none selected = whole team):'), vis));
  }));
  draw();
  const admins = h('select', { multiple: true, size: Math.min(4, people.length), onchange: () => {} }, people.map(([id, n]) => h('option', { value: id, selected: team.admins.includes(id) }, n)));
  return [
    h('label', null, teamOn, ' WhatsApp Intake is on for the team'),
    h('label', null, 'Connected intakes'),
    h('div', { class: 'imembers' }, st.members.map((mb) => h('div', { class: 'imember' },
      h('b', null, iName(mb.user)), h('span', null, mb.hasKey ? `key ${mb.prefix}…` : 'no key'), h('span', null, mb.enabled ? 'on' : 'off'),
      h('span', null, mb.last ? 'last ' + fmtWhen(mb.last) + ' ' + fmtTime(mb.last) : 'never received'),
      mb.hasKey ? h('button', { class: 'ghost', type: 'button', onclick: async () => { await call('intakeRevokeFor', { user: mb.user }); toast('Key revoked'); intakeSettings(); } }, 'Revoke') : h('span')))),
    h('label', null, 'Mapping: who and which project each sender or group belongs to'),
    h('p', { class: 'hint' }, 'A sender rule assigns that person\'s messages to a member. A group rule sets the project and, if you choose, a default assignee and who can see the group\'s items. Anything unmapped goes to whoever reported it.'),
    box,
    h('div', { class: 'btn-row' },
      h('button', { class: 'ghost', type: 'button', onclick: () => { rules.push({ kind: 'sender', match: '', user: '', project: '', members: [] }); draw(); } }, '＋ Add rule'),
      h('button', { class: 'primary', type: 'button', onclick: async () => { await call('intakeUpdateTeam', { rules }); toast('Mapping saved for the team'); } }, 'Save mapping')),
    h('label', null, 'Admins (Ctrl+click to select several)'), admins,
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', type: 'button', onclick: async () => { await call('intakeUpdateTeam', { admins: [...admins.selectedOptions].map((o) => o.value) }); toast('Admins saved'); } }, 'Save admins')),
    h('label', null, 'Recent requests to this computer'),
    h('div', { class: 'ilog' }, st.log.length ? st.log.slice(0, 12).map((l) => h('div', null, `${new Date(l.ts).toLocaleTimeString()}  ${l.ip}  ${l.status}  ${l.user ? iName(l.user) : '-'}  ${l.status === 200 ? `created ${l.created}, skipped ${l.skipped}` : l.note}`)) : h('div', null, 'No requests yet.')),
  ];
}

$('inboxBtn').addEventListener('click', () => intakeOpen());
