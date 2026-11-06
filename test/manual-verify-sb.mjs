import { execRemote } from '../lib/ssh.js';

const srv = {
  name: 'staging', host: '119.29.10.202', port: 22, user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const script = `
set -uo pipefail
echo "=== ZIP INTEGRITY (unzip -t) ==="
unzip -t /tmp/safety-backup-20261104025944.zip 2>&1 | tail -3
echo "UNZIP_T_RC=\${PIPESTATUS[0]}"
echo "=== ZIP CONTENT COUNTS ==="
unzip -l /tmp/safety-backup-20261104025944.zip 2>/dev/null | awk 'END{print "total lines:", NR}'
echo -n "filestore entries: "
unzip -Z1 /tmp/safety-backup-20261104025944.zip 2>/dev/null | grep -c '^filestore/' || echo "0 (unzip -Z1 unavailable)"
echo -n "has dump.sql: "
unzip -Z1 /tmp/safety-backup-20261104025944.zip 2>/dev/null | grep -c '^dump.sql$' || echo 0
echo -n "has manifest.json: "
unzip -Z1 /tmp/safety-backup-20261104025944.zip 2>/dev/null | grep -c '^manifest.json$' || echo 0
echo "=== ZIP SHA256 ==="
sha256sum /tmp/safety-backup-20261104025944.zip 2>&1
echo "=== END ==="
`;
const r = await execRemote(srv, script, { timeoutMs: 600000 });
console.log(r.stdout);
console.log('--- STDERR ---');
console.log(r.stderr.slice(-400));
