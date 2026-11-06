import { guardHostKey } from '../lib/ssh.js';

const base = {
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

console.log('=== A. 未配置指纹 → 必须拒绝 ===');
const a = await guardHostKey(base);
console.log('  ok =', a.ok, '| kind =', a.ok ? '(UNEXPECTED)' : a.error.kind);

console.log('\n=== B. 错误指纹 → 必须拒绝 ===');
const b = await guardHostKey({ ...base, pinnedFingerprint: 'SHA256:WRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRO' });
console.log('  ok =', b.ok, '| kind =', b.ok ? '(UNEXPECTED)' : b.error.kind);

console.log('\n=== C. 正确指纹 → 必须通过 ===');
const c = await guardHostKey({
  ...base,
  pinnedFingerprint: 'SHA256:uOmOzd32qk8nGbHznwaA2QKQ0FnT6vm/DvTyA/o+38w',
});
console.log('  ok =', c.ok, '| mode =', c.mode, '| matched =', c.matched?.type);

console.log('\n=== D. sshConfigAlias → 交给用户 config ===');
const d = await guardHostKey({ sshConfigAlias: 'toogel-vault' });
console.log('  ok =', d.ok, '| mode =', d.mode);
