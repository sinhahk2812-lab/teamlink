'use strict';
// Identity + end-to-end encryption primitives.
// Each install owns one X25519 key pair. The user id is a hash of the public key,
// so an id cannot be claimed without the matching private key (the same idea as
// IP Messenger's "user-<pubkey fingerprint>" names, with modern primitives).
const crypto = require('crypto');

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(X25519_SPKI_PREFIX.length);
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  return { id: idFromPub(pub), pub: pub.toString('base64'), priv };
}

function idFromPub(pub) {
  const raw = Buffer.isBuffer(pub) ? pub : Buffer.from(pub, 'base64');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20);
}

function isValidPub(pubB64) {
  if (typeof pubB64 !== 'string' || pubB64.length > 64) return false;
  return Buffer.from(pubB64, 'base64').length === 32;
}

// Team key: everything on the wire is bound to the team code, so a device that
// does not know the code can neither appear in the member list nor exchange messages.
function teamKey(teamCode) {
  return crypto.createHash('sha256').update('teamlink-team-v1\0' + (teamCode || '')).digest();
}

function roomId(tKey) {
  return crypto.createHash('sha256').update('teamlink-room-v1\0').update(tKey).digest('hex').slice(0, 32);
}

function mac(tKey, text) {
  return crypto.createHmac('sha256', tKey).update(text).digest('base64');
}

function macEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Pairwise key: X25519 ECDH -> HKDF-SHA256 (salted with the team key) -> AES-256-GCM key.
function pairKey(myPrivB64, peerPubB64, tKey) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(myPrivB64, 'base64'), type: 'pkcs8', format: 'der' });
  const pub = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(peerPubB64, 'base64')]), type: 'spki', format: 'der',
  });
  const secret = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  return Buffer.from(crypto.hkdfSync('sha256', secret, tKey, 'teamlink-pair-v1', 32));
}

function seal(key, plain) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

function open(key, buf) {
  if (buf.length < 28) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

const rid = (n = 12) => crypto.randomBytes(n).toString('hex');

module.exports = { generateIdentity, idFromPub, isValidPub, teamKey, roomId, mac, macEqual, pairKey, seal, open, rid };
