#!/usr/bin/env node
'use strict';
// Headless mode: run the messenger without Electron and use it from a browser on the same machine.
//   node core/cli.js [--data <dir>] [--port <n>] [--name <display name>]
const os = require('os');
const path = require('path');
const { Messenger } = require('./messenger');
const { startServer } = require('./server');

const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };

(async () => {
  const overrides = {};
  for (const k of ['name', 'teamCode', 'relayUrl']) if (arg(k) !== undefined) overrides[k] = arg(k);
  for (const k of ['udpPort', 'tcpPort']) if (arg(k) !== undefined) overrides[k] = Number(arg(k));
  if (arg('peers')) overrides.extraPeers = arg('peers').split(',');
  const m = new Messenger(arg('data') || path.join(os.homedir(), '.teamlink'), overrides);
  await m.start();
  const s = await startServer(m, { port: Number(arg('port')) || 0, token: arg('token') });
  console.log('TeamLink is running. Open: ' + s.url);
  const quit = async () => { s.close(); await m.stop(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
})();
