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
  // @mentions: tag one member, or everyone; only people in the group can be tagged
  const tagEvents = []; C.on('event', (e, d) => { if (e === 'incoming' && d.conv === g.id) tagEvents.push(d.mention); });
  const tm = await B.send({ conv: g.id, text: '@Chen please check the logo', mentions: [C.me.id, X.me.id, 'nonsense'] });
  assert.deepEqual(tm.mentions, [C.me.id]); // the outsider and the junk id were dropped
  await until('mention arrives', () => msgs(C, g.id).some((m) => m.id === tm.id) && msgs(A, g.id).some((m) => m.id === tm.id));
  assert.ok(msgs(C, g.id).find((m) => m.id === tm.id).mentionsMe && !msgs(A, g.id).find((m) => m.id === tm.id).mentionsMe);
  assert.deepEqual([C.getState().convs.find((c) => c.id === g.id).mentions, A.getState().convs.find((c) => c.id === g.id).mentions], [1, 0]);
  assert.equal(tagEvents[tagEvents.length - 1], true);
  C.markRead(g.id);
  assert.equal(C.getState().convs.find((c) => c.id === g.id).mentions, 0);
  const ta = await B.send({ conv: g.id, text: '@all meeting at 5', mentions: ['all'] });
  await until('@all arrives', () => msgs(A, g.id).some((m) => m.id === ta.id && m.mentionsMe) && msgs(C, g.id).some((m) => m.id === ta.id && m.mentionsMe));
  assert.ok(!ta.mentionsMe);
  assert.deepEqual((await A.send({ conv: 'dm:' + B.me.id, text: '@Bilal hi', mentions: [B.me.id] })).mentions, []); // no tags in private chats
  A.markRead(g.id); C.markRead(g.id);
  ok('group chat reaches LAN and relay members; @mention tags one member or @all, with a mention count');
  A.updateGroup({ conv: g.id, name: 'Design Team', members: [B.me.id] });
  await until('group update', () => B.store.conv(g.id).name === 'Design Team' && C.store.conv(g.id).left_group === 1);
  await assert.rejects(C.send({ conv: g.id, text: 'still here?' }));
  // group admins: the creator is admin; a plain member cannot rename the group or add people, but can leave
  const ga = A.createGroup({ name: 'Admins only', members: [B.me.id] });
  await until('ga synced', () => B.store.conv(ga.id));
  const viewOf = (m) => m.getState().convs.find((c) => c.id === ga.id);
  assert.ok(viewOf(A).canManage && !viewOf(B).canManage && viewOf(B).members.find((x) => x.id === A.me.id).admin);
  assert.throws(() => B.updateGroup({ conv: ga.id, name: 'B was here' }), /Only a group admin/);
  // even a forged frame from the plain member is refused by the others
  const forged = B.store.conv(ga.id); forged.members.push({ ...B.memberInfo(C.me.id), admin: false });
  B.sendJson(A.me.id, { t: 'group', id: 'gv:forged', gid: ga.id, name: 'Forged', members: forged.members, version: forged.version + 5 });
  await sleep(250);
  assert.deepEqual([A.store.conv(ga.id).name, A.store.conv(ga.id).members.length], ['Admins only', 2]);
  A.updateGroup({ conv: ga.id, members: [B.me.id, C.me.id], admins: [B.me.id] }); // the admin adds C and makes B an admin too
  await until('C added, B admin', () => C.store.conv(ga.id) && viewOf(B).canManage && viewOf(C).members.length === 3 && !viewOf(C).canManage);
  B.updateGroup({ conv: ga.id, name: 'Renamed by B' });
  await until('admin B renamed', () => A.store.conv(ga.id).name === 'Renamed by B');
  C.leaveGroup(ga.id); // a plain member may still leave
  await until('C left', () => A.store.conv(ga.id).members.length === 2);
  assert.throws(() => A.createGroup({ name: 'too big', members: Array.from({ length: 300 }, (_, i) => String(i).padStart(20, '0')) }), /at most 256|Unknown member/);
  ok('rename group and remove a member; only group admins can rename or add members, any member can leave');

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

  // cancel a download half way: the partial file is removed, the sender stops, and it can be downloaded again
  const bigC = path.join(tmp, 'huge.bin'); fs.writeFileSync(bigC, crypto.randomBytes(40 * 1024 * 1024));
  const cm = await A.send({ conv: 'dm:' + C.me.id, paths: [bigC] });
  const cfile = await until('big file offer', () => C.store.filesOf(cm.id)[0]);
  const cancelEvents = []; C.on('event', (e, d) => { if (e === 'file' && d.fid === cfile.fid) cancelEvents.push(d); });
  const cTarget = path.join(tmp, 'Chen', 'cancel me.bin');
  await C.download(cfile.fid, cTarget);
  await until('some of it arrived', () => cancelEvents.some((d) => d.state === 'downloading' && d.progress > 0.02), 20000);
  assert.equal(C.cancelDownload(cfile.fid), true);
  await until('cancelled', () => cancelEvents.some((d) => d.error === 'Download cancelled'));
  await sleep(300);
  assert.ok(!fs.existsSync(cTarget) && !fs.existsSync(cTarget + '.part') && C.store.file(cfile.fid).state === 'remote' && C.downloads.size === 0);
  assert.equal(C.cancelDownload(cfile.fid), false); // nothing left to cancel
  await C.download(cfile.fid, cTarget);
  await until('second try completes', () => C.store.file(cfile.fid).state === 'done', 40000);
  assert.equal(sha(cTarget), sha(bigC));
  ok('a download can be cancelled half way (partial file removed, sender stops) and started again');

  // the sender saved the file again after sending it (a new export with the same name): the download still works
  const reexport = path.join(tmp, 'final_export.mp4'); fs.writeFileSync(reexport, crypto.randomBytes(300000));
  const rm2 = await A.send({ conv: 'dm:' + C.me.id, paths: [reexport] });
  const rfile = await until('offer', () => C.store.filesOf(rm2.id)[0]);
  fs.writeFileSync(reexport, crypto.randomBytes(450000)); // exported again, different size
  await C.download(rfile.fid, path.join(tmp, 'Chen', 'final_export.mp4'));
  await until('changed file downloads', () => C.store.file(rfile.fid).state === 'done');
  assert.equal(sha(path.join(tmp, 'Chen', 'final_export.mp4')), sha(reexport));
  assert.equal(C.store.file(rfile.fid).size, 450000);
  // a deleted file gives a clear message instead of a time-out
  const gone = path.join(tmp, 'deleted.bin'); fs.writeFileSync(gone, crypto.randomBytes(1000));
  const gm = await A.send({ conv: 'dm:' + C.me.id, paths: [gone] });
  const gfile = await until('offer 2', () => C.store.filesOf(gm.id)[0]);
  fs.rmSync(gone);
  const goneErr = []; C.on('event', (e, d) => { if (e === 'file' && d.fid === gfile.fid && d.error) goneErr.push(d.error); });
  await C.download(gfile.fid, path.join(tmp, 'Chen', 'deleted.bin'));
  await until('clear error', () => goneErr.length === 1);
  assert.match(goneErr[0], /moved or deleted this file/);
  // history pages: scrolling up must reach every older message, with none skipped or repeated
  for (let i = 1; i <= 150; i++) B.store.addMessage({ id: 'hist' + String(i).padStart(4, '0'), conv: 'dm:' + X.me.id, sender: B.me.id, ts: 1000 + Math.floor(i / 10), body: 'old ' + i, recipients: [] });
  let page = B.getMessages({ conv: 'dm:' + X.me.id, limit: 40 }), all = [...page];
  while (page.length) { page = B.getMessages({ conv: 'dm:' + X.me.id, limit: 40, beforeId: all[0].id }); all = [...page, ...all]; }
  assert.deepEqual(all.map((m) => m.body), Array.from({ length: 150 }, (_, i) => 'old ' + (i + 1)));
  ok('downloads survive a re-saved file, report a deleted one clearly; history pages reach every older message');

  // typing hint: reaches the other person in a private chat and the members of a group, never the Everyone channel
  const typed = []; const listen = (m, tag) => m.on('event', (e, d) => { if (e === 'typing') typed.push(tag + ':' + d.conv + ':' + d.from.slice(0, 4)); });
  listen(A, 'A'); listen(B, 'B'); listen(C, 'C');
  B.typing({ conv: 'dm:' + A.me.id }); B.typing({ conv: g.id }); B.typing({ conv: 'all' });
  await until('typing hints', () => typed.length >= 2);
  await sleep(250);
  assert.deepEqual(typed.sort(), ['A:' + g.id + ':' + B.me.id.slice(0, 4), 'A:dm:' + B.me.id + ':' + B.me.id.slice(0, 4)].sort());
  assert.equal(A.store.pendingFor(B.me.id).filter((r) => r.frame.t === 'typing').length + B.store.pendingFor(A.me.id).filter((r) => r.frame.t === 'typing').length, 0); // never queued
  ok('typing hint reaches the chat\'s members only, is never queued, and is not sent to Everyone');

  // forwarding: text + attachment go to another person and a group; sealed messages cannot be forwarded
  const src = msgs(B, 'dm:' + A.me.id).find((m) => m.id === im.id);
  assert.equal(await B.forward({ id: src.id, convs: ['dm:' + C.me.id] }), 1);
  const fw = await until('forwarded arrives', () => msgs(C, 'dm:' + B.me.id).find((m) => m.fwd));
  assert.equal(fw.files.length, 1);
  const fwFile = await until('forwarded image', () => { const f = C.store.file(fw.files[0].fid); return f.state === 'done' && f; });
  assert.equal(sha(fwFile.path), sha(png));
  await assert.rejects(B.forward({ id: s1.id, convs: ['dm:' + C.me.id] }), /cannot be forwarded/);
  ok('forward a message with its attachment; sealed messages are refused');

  // emoji reactions: one per person, toggle, replace, shared with the whole chat (the group is A and B by now)
  const rx = await B.send({ conv: g.id, text: 'logo final ho gaya' });
  await until('rx arrives', () => msgs(A, g.id).some((m) => m.id === rx.id));
  const rv = (m) => msgs(m, g.id).find((x) => x.id === rx.id).reactions;
  const reactedEvents = []; B.on('event', (e, d) => { if (e === 'reacted') reactedEvents.push(d.emoji); });
  A.react({ id: rx.id, emoji: '👍' }); B.react({ id: rx.id, emoji: '👍' });
  await until('two thumbs on both', () => [A, B].every((m) => rv(m).length === 1 && rv(m)[0].count === 2 && rv(m)[0].mine));
  assert.deepEqual(reactedEvents, ['👍']); // the author is told about A's reaction, not about their own
  A.react({ id: rx.id, emoji: '❤️' }); // changing replaces my reaction
  await until('replaced', () => [A, B].every((m) => rv(m).length === 2 && rv(m).every((r) => r.count === 1)));
  A.react({ id: rx.id, emoji: '❤️' }); // same emoji again takes it back
  await until('removed', () => [A, B].every((m) => rv(m).length === 1 && rv(m)[0].emoji === '👍' && rv(m)[0].count === 1));
  // C was removed from this group earlier: its reaction frame is ignored
  C.sendJson(A.me.id, { t: 'react', id: 'react:forced', mid: rx.id, emoji: '😂', ts: Date.now() });
  await sleep(250);
  assert.equal(rv(A).length, 1);
  assert.throws(() => A.react({ id: s1.id, emoji: '👍' }), /Sealed/);
  ok('emoji reactions: add, replace and remove sync to the chat; outsiders and sealed messages are refused');

  // pin (shared), star (personal), reply privately (quote a group message in the author's private chat)
  const pinOf = (m) => m.getState().convs.find((c) => c.id === g.id).pins.map((p) => p.id);
  A.pin({ id: rx.id, on: true });
  await until('pin reaches B', () => pinOf(B)[0] === rx.id && msgs(B, g.id).find((m) => m.id === rx.id).pinned);
  assert.deepEqual(pinOf(A), [rx.id]);
  B.pin({ id: rx.id, on: false }); // anyone in the chat can unpin
  await until('unpin reaches A', () => pinOf(A).length === 0 && !msgs(A, g.id).find((m) => m.id === rx.id).pinned);
  assert.throws(() => A.pin({ id: s1.id, on: true }), /Sealed/);
  A.star({ id: rx.id, on: true });
  assert.ok(msgs(A, g.id).find((m) => m.id === rx.id).starred && A.starred().map((m) => m.id).includes(rx.id));
  await sleep(200);
  assert.ok(!msgs(B, g.id).find((m) => m.id === rx.id).starred && B.starred().length === 0); // a star is never shared
  A.star({ id: rx.id, on: false });
  assert.equal(A.starred().length, 0);
  const pr = await A.send({ conv: 'dm:' + B.me.id, text: 'privately: looks great', replyTo: rx.id });
  assert.deepEqual(pr.quote, { id: rx.id, sender: B.me.id, text: 'logo final ho gaya' });
  assert.equal((await A.send({ conv: 'dm:' + C.me.id, text: 'not the author', replyTo: rx.id })).quote, null); // only into the author's own chat
  ok('pin syncs to the chat, star stays personal, reply privately quotes a group message for its author only');

  // edit my own message: everyone sees the new text, marked edited; nobody else can edit it
  const ed = await B.send({ conv: g.id, text: 'meeting at 4' });
  await until('ed arrives', () => msgs(A, g.id).some((m) => m.id === ed.id));
  assert.throws(() => A.editMessage({ id: ed.id, text: 'hacked' }), /only edit your own/);
  A.sendJson(B.me.id, { t: 'edit', id: 'edit:forced', mid: ed.id, body: 'hacked', ts: Date.now() + 5000 }); // a forged edit from a non-author
  B.editMessage({ id: ed.id, text: 'meeting at 5' });
  await until('edit reaches A', () => msgs(A, g.id).find((m) => m.id === ed.id).body === 'meeting at 5');
  assert.ok(msgs(A, g.id).find((m) => m.id === ed.id).edited && msgs(B, g.id).find((m) => m.id === ed.id).body === 'meeting at 5');
  assert.throws(() => B.editMessage({ id: ed.id, text: '   ' }), /cannot be empty/);
  assert.equal(A.search({ text: 'meeting at 4' }).length, 0);
  ok('edit: the author\'s new text replaces the old one for everyone; others cannot edit it');

  // delete for everyone / delete for me
  const dPng = path.join(tmp, 'secret.png'); fs.writeFileSync(dPng, crypto.randomBytes(20000));
  const dm1 = await B.send({ conv: g.id, text: 'wrong price 4500, ignore', paths: [dPng] });
  await until('to be deleted arrives', () => msgs(A, g.id).some((m) => m.id === dm1.id) && A.store.filesOf(dm1.id)[0]?.state === 'done');
  const cachedA = A.store.filesOf(dm1.id)[0].path;
  assert.throws(() => A.deleteMessage({ id: dm1.id, everyone: true }), /only delete your own/);
  B.deleteMessage({ id: dm1.id, everyone: true });
  await until('deleted on A', () => msgs(A, g.id).find((m) => m.id === dm1.id).deleted);
  for (const m of [A, B]) {
    const v = msgs(m, g.id).find((x) => x.id === dm1.id);
    assert.deepEqual([v.deleted, v.body, v.files.length], [true, '', 0]);
    assert.equal(m.search({ text: 'wrong price' }).length, 0);
    assert.ok(!JSON.stringify(m.getState().convs).includes('4500'));
  }
  await until('auto-fetched picture removed', () => !fs.existsSync(cachedA));
  // a delete that arrives before its message (forged order): the message shows up already deleted
  const lateId = 'ab'.repeat(12);
  B.sendJson(A.me.id, { t: 'del', id: 'del:' + lateId, mid: lateId });
  await until('tomb stored', () => A.store.hasTomb(lateId, B.me.id));
  B.sendJson(A.me.id, { t: 'msg', id: lateId, conv: g.id, ts: Date.now(), body: 'should never be readable' });
  await until('late message arrives deleted', () => msgs(A, g.id).some((m) => m.id === lateId && m.deleted && m.body === ''));
  // delete for me: only my copy goes
  const dm2 = await B.send({ conv: g.id, text: 'keep this on B' });
  await until('dm2 arrives', () => msgs(A, g.id).some((m) => m.id === dm2.id));
  A.deleteMessage({ id: dm2.id, everyone: false });
  await sleep(200);
  assert.ok(!msgs(A, g.id).some((m) => m.id === dm2.id) && msgs(B, g.id).some((m) => m.id === dm2.id && !m.deleted));
  ok('delete for everyone empties the message and files on every computer; delete for me removes only my copy');

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
  let waN = 0;
  const wa = (over) => ({ source_id: 'm-' + (++waN), title: 'Review reel v3', type: 'review', from: 'Client Rohan', chat: "Axit's Creatives", time: '2026-11-19T14:30:00+05:30',
    text: 'Bhai reel v3 dekh lo, aaj shaam tak feedback chahiye', links: ['https://www.instagram.com/reel/abc', 'javascript:alert(1)'], priority: 'high', ...over });
  const has = (m, id) => !!m.intake.item(id);
  const settle = () => sleep(350); // long enough for a frame that should NOT arrive to have arrived
  assert.equal((await post(ipA, null, { items: [wa()] })).status, 401);
  assert.equal((await post(ipA, 'tlk_wrong', { items: [wa()] })).status, 401);
  assert.equal((await post(ipA, keyA, null, '{not json')).status, 400);
  assert.equal((await post(ipA, keyA, { items: [] })).status, 400);
  const badType = await post(ipA, keyA, { items: [wa({ type: 'meme' })] });
  assert.ok(badType.status === 400 && badType.body.field === 'type' && badType.body.index === 0);
  assert.equal((await post(ipA, keyA, { items: [wa({ time: '19 Nov 2:30pm' })] })).body.field, 'time');
  assert.equal(A.intake.list().items.length, 0);
  ok('intake API rejects missing/wrong keys (401) and bad payloads (400) without storing anything');

  // 1. No rule: the item is private. Only A (the reporter) has it; same API contract as before.
  const p1 = await post(ipA, keyA, { items: [wa({ source_id: 'priv-1' }), wa({ source_id: 'priv-2', title: 'New banner', type: 'new_task', priority: 'normal' })] });
  assert.deepEqual([p1.status, p1.body.created, p1.body.skipped, p1.body.ids.length], [200, 2, 0, 2]);
  const dupe = await post(ipA, keyA, { items: [wa({ source_id: 'priv-1' })] });
  assert.deepEqual([dupe.body.created, dupe.body.skipped, dupe.body.ids[0]], [0, 1, p1.body.ids[0]]);
  const id1 = p1.body.ids[0];
  await settle();
  assert.ok(has(A, id1) && !has(B, id1) && !has(C, id1));
  assert.ok(A.intake.list({ view: 'mine' }).items.some((x) => x.id === id1) && B.intake.list().items.length === 0 && C.intake.list().items.length === 0);
  assert.deepEqual([A.intake.item(id1).assignee, A.intake.audience(A.intake.item(id1))], [A.me.id, [A.me.id]]);
  assert.equal(A.intake.item(id1).links.length, 1); // the javascript: link was dropped
  ok('privacy: an item with no rule stays on the reporter\'s computer only (B and C get nothing); API contract unchanged');

  // 2. Assigning to B shares it with B and nobody else; comments go only to A and B.
  const alertsB = []; B.on('event', (e, d) => { if (e === 'intakeAlert') alertsB.push(d); });
  A.intake.comment({ id: id1, text: 'note written before B was involved' });
  A.intake.update({ id: id1, assignee: B.me.id });
  await until('B receives the assigned item with its history', () => has(B, id1) && B.intake.get({ id: id1 }).thread.length === 1);
  assert.equal(B.intake.get({ id: id1 }).thread[0].author, A.me.id);
  B.intake.comment({ id: id1, text: 'B working on it' });
  await until('comment reaches A', () => A.intake.get({ id: id1 }).thread.length === 2);
  B.intake.update({ id: id1, status: 'in_progress', due: '2026-11-21T18:00:00+05:30' });
  await until('status reaches A', () => A.intake.item(id1).status === 'in_progress' && A.intake.item(id1).due === Date.parse('2026-11-21T18:00:00+05:30'));
  await settle();
  assert.ok(!has(C, id1) && C.store.get('SELECT COUNT(*) n FROM intake_comments').n === 0);
  assert.ok(alertsB.some((a) => a.id === id1 && a.reason === 'assigned'));
  B.intake.markSeen({ id: id1 });
  assert.ok(B.intake.item(id1).seen); // "seen" is per user and never sent
  ok('privacy: assigning to B shares the item, its comments and status with B only; C still has nothing');

  // 3. Reassigning B -> C: B's copy is deleted, C gets the item with the comments so far.
  A.intake.update({ id: id1, assignee: C.me.id });
  await until('C has it, B lost it', () => has(C, id1) && !has(B, id1) && C.intake.get({ id: id1 }).thread.length === 2);
  assert.equal(B.store.get('SELECT COUNT(*) n FROM intake_comments').n, 0);
  ok('privacy: reassigning removes the item from the previous assignee and gives it to the new one');

  // 4. "Share with...": explicit, per person; "Shared with me" view; unsharing deletes the copy.
  const id2 = p1.body.ids[1];
  A.intake.share({ id: id2, users: [B.me.id] });
  await until('shared with B', () => has(B, id2));
  assert.deepEqual(B.intake.item(id2).shared_with, [B.me.id]);
  assert.deepEqual(B.intake.list({ view: 'shared' }).items.map((x) => x.id), [id2]);
  assert.equal(B.intake.list({ view: 'mine' }).items.length, 0);
  assert.equal(A.intake.list({ view: 'shared' }).items.length, 0);
  await settle(); assert.ok(!has(C, id2));
  assert.throws(() => A.intake.share({ id: id2, users: ['0'.repeat(20)] }), /Unknown member/);
  A.intake.share({ id: id2, users: [] });
  await until('unshared: B lost it', () => !has(B, id2));
  assert.ok(has(A, id2));
  ok('privacy: Share with adds one teammate, shows under "Shared with me", and unsharing removes their copy');

  // 5. Receiving side: a frame for an item I have no part in is dropped, as is a delete request from an outsider.
  const foreign = { ...A.intake.item(id2) }; delete foreign.seen;
  A.intake.send([B.me.id], { t: 'iitem', id: 'iitem:forced:1', item: foreign }); // what an old version would have sent to everyone
  C.intake.send([A.me.id], { t: 'irevoke', id: 'irevoke:forced:1', itemId: id2 }); // C is not in id2's audience
  C.intake.send([A.me.id], { t: 'icom', id: 'icom:forced:1', comment: { id: 'ab'.repeat(10), item: id2, author: C.me.id, ts: Date.now(), text: 'outsider' } });
  await until('forced frames were acknowledged', () => A.store.pendingFor(B.me.id).length === 0 && C.store.pendingFor(A.me.id).length === 0);
  assert.ok(!has(B, id2) && has(A, id2) && A.intake.get({ id: id2 }).thread.length === 0);
  ok('privacy: receivers drop items, comments and delete requests from people outside the item\'s audience');

  // 6. Admin rules: sender -> member, and a chat rule with members [A, C]. New items in that chat go to A and C only.
  A.intake.claimAdmin();
  A.intake.updateTeam({ rules: [{ kind: 'sender', match: 'chinmay', user: C.me.id }, { kind: 'chat', match: 'Launch Group', project: 'Launch', members: [A.me.id, C.me.id] }] });
  await until('rules reach B and C', () => B.intake.team().rules.length === 2 && C.intake.team().rules.length === 2 && B.intake.team().admins[0] === A.me.id);
  assert.throws(() => B.intake.updateTeam({ enabled: false }), /Only a team admin/);
  assert.equal(A.intake.team().defaultAudience, 'private');
  const p6 = await post(ipA, keyA, { items: [wa({ source_id: 'rule-1', chat: 'Launch Group', title: 'Launch checklist' })] });
  const id6 = p6.body.ids[0];
  await until('rule members get it', () => has(C, id6));
  await settle();
  assert.ok(has(A, id6) && !has(B, id6));
  assert.deepEqual([C.intake.item(id6).project, C.intake.item(id6).assignee], ['Launch', A.me.id]);
  assert.deepEqual(C.intake.list({ view: 'shared' }).items.map((x) => x.id), [id6]);
  // sender rule: Chinmay's messages are assigned to C, so C (and only C) gets a copy
  const p6b = await post(ipA, keyA, { items: [wa({ source_id: 'dup-1', from: 'Chinmay' })] });
  const id7 = p6b.body.ids[0];
  await until('assignee by sender rule', () => has(C, id7) && C.intake.item(id7).assignee === C.me.id);
  // B's agent reports the same group message: one item, both reporters, for everyone who holds it
  const viaB = await post(ipB, keyB, { items: [wa({ source_id: 'dup-1', from: 'Chinmay' })] });
  assert.equal(viaB.body.ids[0], id7);
  await until('both reporters on A, B and C', () => [A, B, C].every((m) => has(m, id7) && m.intake.item(id7).reporters.length === 2));
  ok('admin rules: chat members [A, C] see that chat\'s items, B does not; same message from two agents is one item with two reporters');

  // 7. Admin setting "Whole team": only then does a new item go to everyone, as an explicit list.
  A.intake.updateTeam({ defaultAudience: 'team' });
  await until('setting reaches B', () => B.intake.team().defaultAudience === 'team');
  const p7 = await post(ipA, keyA, { items: [wa({ source_id: 'team-1', title: 'Office closed Friday', type: 'update' })] });
  await until('whole team has it', () => has(B, p7.body.ids[0]) && has(C, p7.body.ids[0]));
  assert.ok(A.intake.item(p7.body.ids[0]).shared_with.includes(B.me.id) && A.intake.item(p7.body.ids[0]).shared_with.includes(C.me.id));
  A.intake.updateTeam({ defaultAudience: 'private' });
  const p7b = await post(ipA, keyA, { items: [wa({ source_id: 'team-2' })] });
  await settle();
  assert.ok(!has(B, p7b.body.ids[0]) && !has(C, p7b.body.ids[0]));
  ok('admin setting: "Whole team" shares new items with everyone; back on the default they are private again');

  // 8. One-time clean-up of data left by older versions: other people's items disappear, mine stay.
  const stray = { ...A.intake.item(id2), id: 'f'.repeat(32), source_id: 'old-1', shared_with: [] };
  B.intake.insert(stray); B.store.run('INSERT INTO intake_comments(id,item,author,ts,text) VALUES(?,?,?,?,?)', 'cd'.repeat(10), stray.id, A.me.id, Date.now(), 'old comment');
  const keepB = B.intake.list().items.map((x) => x.id).sort();
  B.intake.save({ privacyMigrated: false }); // as on a computer that was just updated from an older version
  assert.equal(B.intake.privacyMigration(), 1);
  assert.ok(!has(B, stray.id) && B.store.get('SELECT COUNT(*) n FROM intake_comments WHERE item=?', stray.id).n === 0 && B.cfg.intake.privacyMigrated === true);
  assert.deepEqual(B.intake.list().items.map((x) => x.id).sort(), keepB.filter((x) => x !== stray.id));
  assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, 'Bilal', 'config.json'), 'utf8')).intake.privacyMigrated); // saved in config
  B.intake.insert(stray);
  assert.equal(B.intake.privacyMigration(), 0); // the flag stops a second run
  B.intake.forget(stray.id);
  ok('migration: items this computer has no part in are deleted once; its own items stay; the flag stops a second run');

  // any member's key works on any running endpoint (one machine can serve the team later); filters and search
  const viaA = await post(ipA, keyB, { items: [wa({ source_id: 'm-2001', title: 'Deadline Friday', type: 'deadline' })] });
  assert.equal(viaA.body.created, 1);
  await until('B gets the item reported with its key', () => has(B, viaA.body.ids[0]));
  assert.deepEqual(B.intake.item(viaA.body.ids[0]).reporters, [B.me.id]);
  assert.ok(!has(A, viaA.body.ids[0])); // A only carried it: no copy stays on A
  assert.deepEqual((await post(ipA, keyB, { items: [wa({ source_id: 'm-2001', title: 'Deadline Friday', type: 'deadline' })] })).body.created, 0);
  assert.equal(A.intake.list({ q: 'banner' }).items.length, 1);
  assert.equal(B.intake.list({ type: 'deadline', status: 'open' }).items.length, 1);

  // admin sees members' intakes, can revoke a key and switch the team off; a member can switch theirs off
  await until('admin sees B', () => A.intake.state().members.some((x) => x.user === B.me.id && x.hasKey && x.last > 0));
  A.intake.revokeFor({ user: B.me.id });
  await until('B key revoked', () => !B.intake.conf().keyHash);
  assert.equal((await post(ipB, keyB, { items: [wa()] })).status, 401);
  assert.equal((await post(ipA, keyB, { items: [wa()] })).status, 401);
  const keyA2 = A.intake.newKey().key;
  assert.equal((await post(ipA, keyA, { items: [wa()] })).status, 401); // regenerating replaces the old key
  A.intake.updateTeam({ enabled: false });
  assert.equal((await post(ipA, keyA2, { items: [wa()] })).status, 403);
  A.intake.updateTeam({ enabled: true });
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await post(ipA, keyA2, { items: [wa({ source_id: 'priv-1' })] })).status === 429) limited++;
  assert.ok(limited >= 5 && limited <= 40, 'rate limit hits: ' + limited); // 60 per minute per key, some already used above
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
