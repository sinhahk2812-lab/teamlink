'use strict';
// End-to-end test of the engine: three members on one machine.
// A and B find each other over the "LAN" (UDP/TCP on localhost); C is remote and only reachable via the relay.
process.removeAllListeners('warning');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Messenger } = require('../core/messenger');
const { startRelay } = require('../relay/server');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamlink-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(40); }
  throw new Error('timeout waiting for: ' + what);
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let step = 0;
const ok = (s) => console.log(`  ok ${++step} - ${s}`);

(async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', token: 'relay-secret' });
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const base = 39000 + Math.floor(Math.random() * 500) * 4;
  const mk = (name, udpPort, extra = {}) => new Messenger(path.join(tmp, name), {
    name, udpPort, teamCode: 'acme-2026', relayUrl, relayToken: 'relay-secret', downloadDir: path.join(tmp, name, 'dl'), ...extra });
  const A = mk('Asha', base, { extraPeers: [`127.0.0.1:${base + 1}`] });
  let B = mk('Bilal', base + 1, { extraPeers: [`127.0.0.1:${base}`] });
  const C = mk('Chen', base + 2);
  const X = mk('Outsider', base + 3, { teamCode: 'other-team', extraPeers: [`127.0.0.1:${base}`] });
  for (const m of [A, B, C, X]) await m.start();
  const peer = (m, other) => m.getState().peers.find((p) => p.id === other.me.id);
  const msgs = (m, conv) => m.getMessages({ conv });

  await until('discovery', () => peer(A, B)?.online && peer(B, A)?.online && peer(A, C)?.online && peer(C, A)?.online && peer(B, C)?.online);
  assert.equal(peer(A, B).via, 'lan'); assert.equal(peer(A, C).via, 'relay'); assert.equal(peer(A, B).name, 'Bilal');
  ok('members discover each other (A-B over LAN, C over relay)');
  await sleep(300);
  assert.ok(!peer(A, X) && !peer(X, A));
  ok('a device with a different team code stays invisible');
  const N = new Messenger(path.join(tmp, 'NoCode'), { name: 'NoCode', udpPort: base, teamCode: '' });
  await N.start();
  assert.ok(N.netState().locked && !N.lan.udpOk && N.lan.tcpPort === 0);
  await assert.rejects(N.setConfig({ teamCode: 'short' }), /at least 8/);
  await N.stop();
  ok('without a team code the app does no networking; short codes are refused');

  // profile picture travels to LAN and relay members; clearing it clears it everywhere
  const dp = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(20000)]);
  A.setAvatar(dp);
  await until('avatar sync', () => peer(B, A).avatar && peer(C, A).avatar);
  assert.equal(peer(B, A).avatar, A.getState().me.avatar);
  assert.ok(fs.readFileSync(B.avatarPath(A.me.id)).equals(dp) && fs.readFileSync(C.avatarPath(A.me.id)).equals(dp));
  assert.throws(() => A.setAvatar(Buffer.from('<svg onload=alert(1)>')), /small PNG or JPG/);
  A.setAvatar(null);
  await until('avatar cleared', () => !peer(B, A).avatar && !fs.existsSync(B.avatarPath(A.me.id)));
  ok('profile picture reaches teammates and can be removed');

  // direct messages + delivery receipt
  const m1 = await A.send({ conv: 'dm:' + B.me.id, text: 'Hello Bilal' });
  await until('dm delivery', () => msgs(B, 'dm:' + A.me.id).some((m) => m.body === 'Hello Bilal'));
  await until('dm ack', () => msgs(A, 'dm:' + B.me.id).find((m) => m.id === m1.id).delivered === 1);
  assert.equal(B.getState().convs.find((c) => c.id === 'dm:' + A.me.id).unread, 1);
  ok('direct message over LAN, delivery receipt, unread count');
  assert.ok(!msgs(A, 'dm:' + B.me.id).find((m) => m.id === m1.id).readAt);
  B.markRead('dm:' + A.me.id); // Bilal opens the chat
  await until('seen notice', () => msgs(A, 'dm:' + B.me.id).find((m) => m.id === m1.id).readAt);
  assert.equal(B.getState().convs.find((c) => c.id === 'dm:' + A.me.id).unread, 0);
  ok('sender is told when the message has been seen');

  await C.send({ conv: 'dm:' + A.me.id, text: 'Hi from home' });
  await until('relay dm', () => msgs(A, 'dm:' + C.me.id).some((m) => m.body === 'Hi from home'));
  ok('direct message over relay');

  // sealed message
  const s1 = await A.send({ conv: 'dm:' + B.me.id, text: 'salary sheet password: 1234', sealed: true });
  const got = await until('sealed arrives', () => msgs(B, 'dm:' + A.me.id).find((m) => m.id === s1.id));
  assert.ok(got.hidden && got.body === '');
  assert.equal(B.search({ text: 'salary' }).length, 0);
  B.openSealed(s1.id);
  assert.equal(msgs(B, 'dm:' + A.me.id).find((m) => m.id === s1.id).body, 'salary sheet password: 1234');
  await until('open notice', () => msgs(A, 'dm:' + B.me.id).find((m) => m.id === s1.id).readAt);
  // secure everywhere: sender's own view, chat list on both sides, search after opening, and it hides again
  assert.ok(msgs(A, 'dm:' + B.me.id).find((m) => m.id === s1.id).hidden && s1.body === '');
  for (const m of [A, B]) assert.ok(!JSON.stringify(m.getState().convs).includes('salary'));
  assert.equal(B.search({ text: 'salary' }).length + A.search({ text: 'salary' }).length, 0);
  B.hideSealed();
  const rehidden = msgs(B, 'dm:' + A.me.id).find((m) => m.id === s1.id);
  assert.ok(rehidden.hidden && rehidden.opened && rehidden.body === '');
  B.openSealed(s1.id); A.openSealed(s1.id);
  assert.equal(msgs(B, 'dm:' + A.me.id).find((m) => m.id === s1.id).body, 'salary sheet password: 1234');
  assert.equal(msgs(A, 'dm:' + B.me.id).find((m) => m.id === s1.id).body, 'salary sheet password: 1234');
  A.hideSealed(); B.hideSealed();
  ok('sealed message stays hidden until opened; sender gets the open notice; it hides again and never shows in lists or search');

  // locked message: needs the receiver's own password
  const l1 = await A.send({ conv: 'dm:' + B.me.id, text: 'bank OTP 554433', locked: true });
  await until('locked arrives', () => msgs(B, 'dm:' + A.me.id).find((m) => m.id === l1.id));
  assert.throws(() => B.openSealed(l1.id, 'x'), /Set your lock password/);
  assert.throws(() => B.setLockPassword({ next: 'abc' }), /at least 4/);
  B.setLockPassword({ next: 'bilal-secret' });
  assert.throws(() => B.openSealed(l1.id, 'wrong'), /Wrong password/);
  assert.ok(msgs(B, 'dm:' + A.me.id).find((m) => m.id === l1.id).hidden);
  B.openSealed(l1.id, 'bilal-secret');
  assert.equal(msgs(B, 'dm:' + A.me.id).find((m) => m.id === l1.id).body, 'bank OTP 554433');
  await until('locked open notice', () => msgs(A, 'dm:' + B.me.id).find((m) => m.id === l1.id).readAt);
  B.hideSealed();
  assert.throws(() => B.openSealed(l1.id, 'wrong'), /Wrong password/); // the password is needed again for every view
  assert.ok(msgs(B, 'dm:' + A.me.id).find((m) => m.id === l1.id).hidden);
  assert.throws(() => B.setLockPassword({ current: 'nope', next: 'new-one' }), /current password is wrong/);
  assert.ok(!JSON.stringify(B.getState()).includes('bilal-secret') && !fs.readFileSync(path.join(tmp, 'Bilal', 'config.json'), 'utf8').includes('bilal-secret'));
  ok('locked message opens only with the receiver\'s lock password');

  // reply with quote
  const r1 = await B.send({ conv: 'dm:' + A.me.id, text: 'Hello Asha', replyTo: m1.id });
  const gotR = await until('quoted reply', () => msgs(A, 'dm:' + B.me.id).find((m) => m.id === r1.id));
  assert.deepEqual(gotR.quote, { id: m1.id, sender: A.me.id, text: 'Hello Bilal' });
  const r2 = await B.send({ conv: 'dm:' + A.me.id, text: 'no leak', replyTo: s1.id });
  assert.equal(r2.quote, null);
  ok('reply carries a quote of the original; sealed messages are never quoted');

  // groups
  const g = A.createGroup({ name: 'Design', members: [B.me.id, C.me.id] });
  await until('group sync', () => B.store.conv(g.id) && C.store.conv(g.id));
  await B.send({ conv: g.id, text: 'standup at 10' });
  await until('group msg', () => msgs(A, g.id).length === 1 && msgs(C, g.id).length === 1);
  B.markRead(g.id); // nothing of B's own to confirm
  A.markRead(g.id); C.markRead(g.id);
  await until('group seen', () => msgs(B, g.id)[0].seen === 2);
  ok('group chat reaches LAN and relay members');
  A.updateGroup({ conv: g.id, name: 'Design Team', members: [B.me.id] });
  await until('group update', () => B.store.conv(g.id).name === 'Design Team' && C.store.conv(g.id).left_group === 1);
  await assert.rejects(C.send({ conv: g.id, text: 'still here?' }));
  ok('rename group and remove a member');

  // broadcast
  await A.send({ conv: 'all', text: 'Office closed on Friday' });
  await until('broadcast', () => msgs(B, 'all').length === 1 && msgs(C, 'all').length === 1);
  ok('broadcast to everyone');

  // files: a plain file over relay (pull), an image over LAN (auto), a folder over LAN
  const big = path.join(tmp, 'report.bin'); fs.writeFileSync(big, crypto.randomBytes(3 * 1024 * 1024 + 123));
  const fm = await A.send({ conv: 'dm:' + C.me.id, text: 'report', paths: [big] });
  const cf = await until('file offer', () => msgs(C, 'dm:' + A.me.id).find((m) => m.id === fm.id));
  assert.equal(cf.files[0].state, 'remote');
  const picked = path.join(tmp, 'Chen', 'picked', 'my report.bin'); // what the "Save as" dialog would return
  await C.download(cf.files[0].fid, picked);
  const done = await until('relay download', () => { const f = C.store.file(cf.files[0].fid); return f.state === 'done' && f; }, 20000);
  assert.equal(sha(done.path), sha(big));
  assert.equal(done.path, picked);
  ok('3 MB file pulled over relay to a chosen location, checksum matches');
  B.store.saveFile({ fid: cf.files[0].fid, msg: 'none', owner: A.me.id, name: 'report.bin', size: cf.files[0].size, state: 'remote' });
  const errs = []; B.on('event', (e, d) => { if (e === 'file' && d.error) errs.push(d.error); });
  await B.download(cf.files[0].fid);
  await until('refusal', () => errs.length === 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'Bilal', 'dl', 'report.bin')));
  ok('a non-recipient cannot fetch someone else\'s attachment');

  const png = path.join(tmp, 'shot.png'); fs.writeFileSync(png, crypto.randomBytes(50000));
  const im = await A.send({ conv: 'dm:' + B.me.id, paths: [png] });
  const img = await until('image auto download', () => { const f = B.store.filesOf(im.id)[0]; return f && f.state === 'done' && f; });
  assert.equal(sha(img.path), sha(png));
  const copy = path.join(tmp, 'Bilal', 'saved logo.png');
  await B.saveCopy(img.fid, copy);
  assert.equal(sha(copy), sha(png));
  await assert.rejects(B.saveCopy('nope', copy));
  ok('pasted image is fetched automatically and can be saved elsewhere');

  const dir = path.join(tmp, 'project'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A'); fs.writeFileSync(path.join(dir, 'src', 'b.txt'), 'BB');
  const dm = await A.send({ conv: 'dm:' + B.me.id, paths: [dir] });
  const offered = await until('folder offer', () => { const f = B.store.filesOf(dm.id); return f.length === 2 && f; });
  const chosen = path.join(tmp, 'Bilal', 'client work'); fs.mkdirSync(path.join(chosen, 'project'), { recursive: true }); // a "project" folder is already there
  assert.equal(await B.downloadAll(dm.id, chosen), 2);
  await until('folder download', () => B.store.filesOf(dm.id).every((f) => f.state === 'done'));
  assert.equal(fs.readFileSync(path.join(chosen, 'project (2)', 'src', 'b.txt'), 'utf8'), 'BB');
  assert.equal(fs.readFileSync(path.join(chosen, 'project (2)', 'a.txt'), 'utf8'), 'A');
  ok('download all: a folder lands in the chosen place with its structure, without overwriting');

  // forwarding: text + attachment go to another person and a group; sealed messages cannot be forwarded
  const src = msgs(B, 'dm:' + A.me.id).find((m) => m.id === im.id);
  assert.equal(await B.forward({ id: src.id, convs: ['dm:' + C.me.id] }), 1);
  const fw = await until('forwarded arrives', () => msgs(C, 'dm:' + B.me.id).find((m) => m.fwd));
  assert.equal(fw.files.length, 1);
  const fwFile = await until('forwarded image', () => { const f = C.store.file(fw.files[0].fid); return f.state === 'done' && f; });
  assert.equal(sha(fwFile.path), sha(png));
  await assert.rejects(B.forward({ id: s1.id, convs: ['dm:' + C.me.id] }), /cannot be forwarded/);
  ok('forward a message with its attachment; sealed messages are refused');

  // sub-chats: a named topic inside a conversation, shared by both sides
  const sub = A.createSub({ conv: 'dm:' + B.me.id, name: 'Invoices' });
  await until('sub-chat sync', () => B.getState().convs.find((c) => c.id === 'dm:' + A.me.id).subs.some((x) => x.id === sub.id && x.name === 'Invoices'));
  const before = msgs(B, 'dm:' + A.me.id).length;
  const sm = await A.send({ conv: 'dm:' + B.me.id, text: 'invoice 42 attached', sub: sub.id });
  await until('sub message', () => B.getMessages({ conv: 'dm:' + A.me.id, sub: sub.id }).some((m) => m.id === sm.id));
  assert.equal(B.getMessages({ conv: 'dm:' + A.me.id, sub: '' }).some((m) => m.id === sm.id), false);
  assert.equal(B.getState().convs.find((c) => c.id === 'dm:' + A.me.id).subs[0].unread, 1);
  B.markRead('dm:' + A.me.id, sub.id);
  assert.equal(B.getState().convs.find((c) => c.id === 'dm:' + A.me.id).subs[0].unread, 0);
  B.deleteSub({ conv: 'dm:' + A.me.id, sub: sub.id });
  assert.ok(B.getMessages({ conv: 'dm:' + A.me.id, sub: '' }).some((m) => m.id === sm.id) && msgs(B, 'dm:' + A.me.id).length === before + 1);
  ok('sub-chat: shared topic with its own messages and unread count; deleting it keeps the messages');

  // absence auto reply
  B.setProfile({ status: 'away', absenceMsg: 'In a meeting till 4' });
  await A.send({ conv: 'dm:' + B.me.id, text: 'ping' }); await A.send({ conv: 'dm:' + B.me.id, text: 'ping again' });
  await until('auto reply', () => msgs(A, 'dm:' + B.me.id).some((m) => m.auto && m.body === 'In a meeting till 4'));
  await sleep(300);
  assert.equal(msgs(A, 'dm:' + B.me.id).filter((m) => m.auto).length, 1);
  assert.equal(peer(A, B).status, 'away');
  ok('absence mode auto-replies once');

  // offline queue: B goes away, A writes, B comes back with the same data dir
  await B.stop();
  await until('B offline', () => !peer(A, B).online);
  const q = await A.send({ conv: 'dm:' + B.me.id, text: 'read this when you are back' });
  assert.equal(q.delivered, 0);
  B = mk('Bilal', base + 1, { extraPeers: [`127.0.0.1:${base}`] });
  await B.start();
  await until('queued delivery', () => msgs(B, 'dm:' + A.me.id).some((m) => m.id === q.id));
  await until('queued ack', () => msgs(A, 'dm:' + B.me.id).find((m) => m.id === q.id).delivered === 1);
  ok('message sent while the peer was offline is delivered when it returns');

  // WHATSAPP-INTAKE: begin (real HTTP requests against A's and B's endpoints)
  const post = async (port, key, body, raw) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/intake/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: raw || JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const ipA = base + 20, ipB = base + 21;
  A.cfg.intake = { port: ipA, host: '127.0.0.1' }; B.cfg.intake = { port: ipB, host: '127.0.0.1' };
  await A.intake.setEnabled(true); await B.intake.setEnabled(true);
  const keyA = A.intake.newKey().key, keyB = B.intake.newKey().key;
  assert.ok(/^tlk_/.test(keyA) && !JSON.stringify(A.cfg).includes(keyA) && A.cfg.intake.keyHash.length === 64);
  const wa = (over) => ({ source_id: 'm-1001', title: 'Review reel v3', type: 'review', from: 'Chinmay', chat: "Axit's Creatives", time: '2026-11-19T14:30:00+05:30',
    text: 'Bhai reel v3 dekh lo, aaj shaam tak feedback chahiye', links: ['https://www.instagram.com/reel/abc', 'javascript:alert(1)'], priority: 'high', ...over });
  assert.equal((await post(ipA, null, { items: [wa()] })).status, 401);
  assert.equal((await post(ipA, 'tlk_wrong', { items: [wa()] })).status, 401);
  assert.equal((await post(ipA, keyA, null, '{not json')).status, 400);
  assert.equal((await post(ipA, keyA, { items: [] })).status, 400);
  const badType = await post(ipA, keyA, { items: [wa({ type: 'meme' })] });
  assert.ok(badType.status === 400 && badType.body.field === 'type' && badType.body.index === 0);
  assert.equal((await post(ipA, keyA, { items: [wa({ time: '19 Nov 2:30pm' })] })).body.field, 'time');
  assert.equal(A.intake.list().items.length, 0);
  ok('intake API rejects missing/wrong keys (401) and bad payloads (400) without storing anything');

  await until('team admin + rules', () => { try { A.intake.claimAdmin(); return true; } catch { return true; } });
  A.intake.updateTeam({ rules: [{ kind: 'sender', match: 'chinmay', user: C.me.id }, { kind: 'chat', match: "Axit's Creatives", project: 'Creatives' }] });
  await until('rules reach B', () => B.intake.team().rules.length === 2 && B.intake.team().admins[0] === A.me.id);
  assert.throws(() => B.intake.updateTeam({ enabled: false }), /Only a team admin/);
  const alerts = []; C.on('event', (e, d) => { if (e === 'intakeAlert') alerts.push(d); });
  const first = await post(ipA, keyA, { items: [wa(), wa({ source_id: 'm-1002', title: 'New banner', type: 'new_task', from: 'RS Mahima', priority: 'normal' })] });
  assert.deepEqual([first.status, first.body.created, first.body.skipped, first.body.ids.length], [200, 2, 0, 2]);
  const again = await post(ipA, keyA, { items: [wa()] });
  assert.deepEqual([again.body.created, again.body.skipped, again.body.ids[0]], [0, 1, first.body.ids[0]]);
  const idA = first.body.ids[0];
  await until('item synced to B and C', () => B.intake.item(idA) && C.intake.item(idA));
  // B's agent reports the same group message: still one item, now with two reporters, on every computer
  const dupe = await post(ipB, keyB, { items: [wa()] });
  assert.deepEqual([dupe.body.created, dupe.body.skipped, dupe.body.ids[0]], [0, 1, idA]);
  await until('both reporters everywhere', () => [A, B, C].every((m) => m.intake.item(idA).reporters.length === 2));
  assert.equal(A.intake.list().items.length, 2);
  const itA = A.intake.get({ id: idA });
  assert.deepEqual([itA.assignee, itA.project, itA.links.length, itA.priority], [C.me.id, 'Creatives', 1, 'high']); // mapped sender -> Chen, chat -> project, unsafe link dropped
  assert.equal(A.intake.item(first.body.ids[1]).assignee, A.me.id); // unmapped sender -> the reporter
  await until('alert for the assignee', () => alerts.some((a) => a.id === idA));
  ok('intake creates once across members, records both reporters, maps sender/chat, and alerts the assignee');

  // any member's key works on any running endpoint (one machine can serve the team later)
  const viaA = await post(ipA, keyB, { items: [wa({ source_id: 'm-2001', title: 'Deadline Friday', type: 'deadline' })] });
  assert.equal(viaA.body.created, 1);
  assert.deepEqual(A.intake.item(viaA.body.ids[0]).reporters, [B.me.id]);
  // per-user seen, shared status / assignee / due / comments
  B.intake.markSeen({ id: idA });
  assert.ok(B.intake.item(idA).seen && !A.intake.item(idA).seen && !C.intake.item(idA).seen);
  C.intake.update({ id: idA, status: 'in_progress', due: '2026-11-21T18:00:00+05:30' });
  await until('status sync', () => A.intake.item(idA).status === 'in_progress' && B.intake.item(idA).status === 'in_progress');
  B.intake.update({ id: idA, assignee: B.me.id });
  await until('reassign sync', () => A.intake.item(idA).assignee === B.me.id && C.intake.item(idA).assignee === B.me.id);
  assert.equal(A.intake.item(idA).due, Date.parse('2026-11-21T18:00:00+05:30'));
  C.intake.comment({ id: idA, text: 'Feedback bhej diya' });
  await until('comment sync', () => A.intake.get({ id: idA }).thread.length === 1 && B.intake.get({ id: idA }).thread[0].author === C.me.id);
  assert.equal(B.intake.list({ view: 'mine' }).items.some((x) => x.id === idA), true);
  assert.equal(A.intake.list({ q: 'banner' }).items.length, 1);
  assert.equal(A.intake.list({ type: 'deadline', status: 'open' }).items.length, 1);
  ok('per-user seen; status, assignee, due date and comments sync; filters and search work');

  // admin sees members' intakes, can revoke a key and switch the team off; a member can switch theirs off
  await until('admin sees B', () => A.intake.state().members.some((x) => x.user === B.me.id && x.hasKey && x.last > 0));
  A.intake.revokeFor({ user: B.me.id });
  await until('B key revoked', () => !B.intake.conf().keyHash);
  assert.equal((await post(ipB, keyB, { items: [wa({ source_id: 'm-3001' })] })).status, 401);
  assert.equal((await post(ipA, keyB, { items: [wa({ source_id: 'm-3001' })] })).status, 401);
  const keyA2 = A.intake.newKey().key;
  assert.equal((await post(ipA, keyA, { items: [wa({ source_id: 'm-3002' })] })).status, 401); // regenerating replaces the old key
  A.intake.updateTeam({ enabled: false });
  assert.equal((await post(ipA, keyA2, { items: [wa({ source_id: 'm-3002' })] })).status, 403);
  A.intake.updateTeam({ enabled: true });
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await post(ipA, keyA2, { items: [wa()] })).status === 429) limited++;
  assert.ok(limited >= 5 && limited <= 30, 'rate limit hits: ' + limited); // 60 per minute per key, some already used above
  assert.ok(A.intake.state().log.some((l) => l.status === 429) && A.store.get('SELECT COUNT(*) n FROM intake_log WHERE status=401').n >= 2);
  await A.intake.setEnabled(false);
  await assert.rejects(post(ipA, keyA2, { items: [wa()] }));
  ok('admin can revoke keys and disable team intake; regenerate, rate limit (429), logging and the off switch work');
  // WHATSAPP-INTAKE: end

  // backup with an easy key, then restore into an empty data folder
  assert.throws(() => A.setBackupKey({ key: 'abc' }), /at least 4/);
  await assert.rejects(A.createBackup(path.join(tmp, 'x.tlbackup')), /Set a backup key/);
  A.cfg.autoBackup = false; A.setBackupKey({ key: 'asha2026' });
  const bfile = await A.createBackup(path.join(tmp, 'asha.tlbackup'));
  assert.ok(!fs.readFileSync(bfile).includes(Buffer.from('Hello Bilal')) && !fs.readFileSync(bfile).includes(Buffer.from(A.me.priv.slice(0, 24))));
  const R0 = new Messenger(path.join(tmp, 'Restored'), { name: 'fresh', udpPort: base + 9, teamCode: '' });
  assert.throws(() => R0.restoreBackup({ path: bfile, key: 'wrong' }), /Wrong backup key/);
  assert.throws(() => R0.restoreBackup({ path: png, key: 'asha2026' }), /not a TeamLink backup/);
  assert.equal(R0.restoreBackup({ path: bfile, key: 'asha2026' }).name, 'Asha');
  R0.store.close();
  assert.equal(Messenger.applyPendingRestore(path.join(tmp, 'Restored')), true);
  const R = new Messenger(path.join(tmp, 'Restored'), { udpPort: base + 9, teamCode: '' });
  assert.equal(R.me.id, A.me.id);
  assert.ok(R.getMessages({ conv: 'dm:' + B.me.id }).some((m) => m.body === 'Hello Bilal'));
  assert.equal(R.store.convs().length, A.getState().convs.length);
  R.store.close();
  ok('encrypted backup restores identity, settings and history; wrong key is refused');

  assert.equal(A.search({ text: 'friday' }).length, 1);
  assert.equal(A.search({ text: 'report.bin' }).length, 1);
  ok('history search (text and file names)');

  for (const m of [A, B, C, X]) await m.stop();
  relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${step} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
