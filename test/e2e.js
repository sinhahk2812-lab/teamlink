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
  ok('sealed message stays hidden until opened; sender gets the open notice');

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

  assert.equal(A.search({ text: 'friday' }).length, 1);
  assert.equal(A.search({ text: 'report.bin' }).length, 1);
  ok('history search (text and file names)');

  for (const m of [A, B, C, X]) await m.stop();
  relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nAll ${step} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
