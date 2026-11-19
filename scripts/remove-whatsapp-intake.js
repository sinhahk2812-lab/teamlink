#!/usr/bin/env node
'use strict';
// Removes the WhatsApp Intake feature from the source tree.
//   node scripts/remove-whatsapp-intake.js          (dry run: shows what would change)
//   node scripts/remove-whatsapp-intake.js --apply  (does it)
// Every line the feature added to shared files carries the marker WHATSAPP-INTAKE; whole blocks sit
// between "WHATSAPP-INTAKE: begin" and "WHATSAPP-INTAKE: end". The feature's own files are deleted.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const apply = process.argv.includes('--apply');
const OWN = ['core/intake.js', 'ui/intake.js', 'ui/intake.css', 'docs/whatsapp-intake.md', 'scripts/remove-whatsapp-intake.js'];
const SHARED = ['core/messenger.js', 'core/server.js', 'ui/app.js', 'ui/index.html', 'electron/main.js', 'test/e2e.js'];

for (const rel of SHARED) {
  const file = path.join(root, rel);
  const out = []; let inBlock = false, removed = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.includes('WHATSAPP-INTAKE: begin')) { inBlock = true; removed++; continue; }
    if (line.includes('WHATSAPP-INTAKE: end')) { inBlock = false; removed++; continue; }
    if (inBlock || line.includes('WHATSAPP-INTAKE')) { removed++; continue; }
    out.push(line);
  }
  if (inBlock) { console.error(`${rel}: a "begin" marker has no "end". Nothing was changed.`); process.exit(1); }
  console.log(`${apply ? 'cleaned ' : 'would clean'} ${rel}: ${removed} line(s)`);
  if (apply && removed) fs.writeFileSync(file, out.join('\n'));
}
for (const rel of OWN) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue;
  console.log(`${apply ? 'deleted ' : 'would delete'} ${rel}`);
  if (apply) fs.rmSync(file);
}
console.log(apply ? '\nDone. Run "npm test", raise the version in package.json and push to release a build without the feature.'
  : '\nDry run only. Add --apply to make these changes.');
