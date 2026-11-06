import { readFileSync } from 'node:fs';

const f = 'K:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js';
let s;
try {
  s = readFileSync(f, 'utf8');
} catch (e) {
  console.log('READ_ERR', e.code, e.message.slice(0, 120));
  process.exit(0);
}
console.log('LEN', s.length);

const kws = ['plugins.bundle.config', 'bundles.has', 'ledger.bundles', 'view === "page"', 'view: "page"', 'configLedger'];
for (const kw of kws) {
  const hits = [];
  let i = -1;
  while ((i = s.indexOf(kw, i + 1)) !== -1) hits.push(i);
  console.log(`${kw} -> ${hits.length}`);
  for (const pos of hits.slice(0, 3)) {
    console.log('   ...' + s.slice(Math.max(0, pos - 260), pos + 200).replace(/\s+/g, ' ') + '...');
  }
}
