import { execRemote, testConnection } from '../lib/ssh.js';

const srv = {
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const r1 = await execRemote(srv, 'echo HELLO; hostname', { timeoutMs: 20000 });
console.log('simple: code=%d stdout=%j', r1.code, r1.stdout);

const script = ['read -r A', 'read -r B', 'echo "A=$A B=$B"'].join('\n');
const r2 = await execRemote(srv, script, { stdin: 'val1\nval2\n', timeoutMs: 20000 });
console.log('stdin: code=%d stdout=%j stderr=%j', r2.code, r2.stdout, r2.stderr.slice(0, 200));

const r3 = await testConnection(srv);
console.log('testConnection:', JSON.stringify(r3, null, 2));
