/**
 * Task 11 交接检查：Handoff 与知识库中的事实一致性（静态比对，只读）。
 */
import { readFileSync } from 'node:fs';

const V = 'H:/odoo/toogel.cn/vault/04-ubuntu系统运维/备份恢复/';
const H = 'H:/odoo/toogel.cn/vault/04-ubuntu系统运维/备份恢复/handoff/';

const handoff = readFileSync(H + '2026-11-05-DSH-Odoo备份恢复插件-Handoff.md', 'utf8');
const index = readFileSync(V + '索引.md', 'utf8');
const t10 = readFileSync(V + '2026-11-05-Task10最终集成验收记录.md', 'utf8');
const pre = readFileSync(V + '2026-11-05-发布前规范核查记录.md', 'utf8');
const t9 = readFileSync(V + '2026-11-05-Task9验收记录.md', 'utf8');
const t7 = readFileSync(V + '2026-11-04-Task7阶段性验收记录.md', 'utf8');

const results = [];
const chk = (n, ok, d = '') => results.push([n, ok, d]);

// 版本号一致
const ver = '@local/dsh-odoo-backup@0.1.0';
chk('Handoff 版本号 = ' + ver, handoff.includes(ver));
chk('索引指向 Handoff 链接', index.includes('2026-11-05-DSH-Odoo备份恢复插件-Handoff'));

// commit 事实一致（无 git / 无 commit）
chk('Handoff 明确写「无 git 仓库」', /不是 git 仓库/.test(handoff));
chk('Handoff 明确写「无 commit」', /无 commit/.test(handoff));
chk('Handoff 未编造 commit hash', !/[0-9a-f]{7,40}/i.test(handoff.split('git 仓库')[1]?.split('##')[0] ?? ''));

// 测试数据一致
chk('Handoff 写 156/156', handoff.includes('156 / 156'));
chk('发布前核查记录写 146/146（U4 前当时值）', /146/.test(pre));
chk('Task 10 记录写 142/142（当时值）', /142 \/ 142/.test(t10));
chk('Task 9 记录写 132/132（当时值）', /132 \/ 132/.test(t9));
chk('Task 7 记录写 89/89（当时值）', /89 \/ 89/.test(t7));
chk('Task 11 记录 §7 追加说明 156/156', /156\/156/.test(readFileSync(V + '2026-11-05-Task11验收记录.md', 'utf8')));

// 未完成事项一致
const missing = ['真实 R1', '浏览器', '生产'];
for (const k of missing) {
  chk(`Handoff 列明「${k}」未完成`, handoff.includes(k));
}
chk('索引口径列明三项未完成', index.includes('真实 R1') && index.includes('浏览器') && index.includes('生产部署尚未授权'));
chk('Task 10 列明 R1 未测试', /NOT TESTED|未测试|未执行/.test(t10));
chk('发布前核查列明 R1 未测试', /仍未测试|未测试/.test(pre));

// 加密门槛：U4 已决定为 Fail-closed 并修复
chk('Handoff 有加密门槛章节', handoff.includes('加密门槛'));
chk('Handoff 标注 U4 已决定为 Fail-closed', /Fail-closed/.test(handoff) && /U4/.test(handoff));
chk('Handoff 说明无口令即拒绝备份（不再是缺口）', /拒绝备份/.test(handoff) && /不生成明文/.test(handoff));
chk('索引口径反映 U4 已解决', /156\/156/.test(index) && /U4/.test(index));
chk('Handoff 不再把 U4 列为待决', !/U4 \|.*待决/.test(handoff));

// 下一步只剩事项
chk('Handoff 明确「版本冻结」已取消', handoff.includes('取消该关卡') || handoff.includes('取消这两个关卡'));
chk('Handoff 明确「首版发布」已完成', /已发布/.test(handoff) && /v0\.1\.0/.test(handoff));
chk('Handoff 不再把 U5/U6 列为待办', !/U5 \|.*待办|U6 \|.*待办/.test(handoff));
chk('Handoff 有发布制品章节', handoff.includes('内部首版发布制品') && handoff.includes('odoo-plugin-releases'));
chk('Handoff 记录安装包 SHA256', handoff.includes('dfa0fb62300fb243087719673a430153540efa35c36e5ffac0b457544cf8f270'));

// 发布记录存在且 frontmatter 完整
const releaseSrc = readFileSync(V + '2026-11-05-v0.1.0内部首版发布记录.md', 'utf8');
chk('发布记录 frontmatter 完整', /^---[\s\S]*?type:\s*release/.test(releaseSrc));
chk('发布记录含包内容校验 43/43', /43\/43/.test(releaseSrc));

// 互链完整性（索引中引用的文档都存在）
const links = [
  '2026-11-05-Task10最终集成验收记录.md',
  '2026-11-05-发布前规范核查记录.md',
  '2026-11-05-Task9验收记录.md',
  '2026-11-04-Task7阶段性验收记录.md',
  '2026-11-03-DSH-Odoo备份恢复插件实施计划.md',
];
import { existsSync } from 'node:fs';
for (const f of links) chk('索引/Handoff 引用文档存在: ' + f, existsSync(V + f));
chk('Handoff 文件存在', existsSync(H + '2026-11-05-DSH-Odoo备份恢复插件-Handoff.md'));

// frontmatter 完整性
for (const [name, txt] of [['Handoff', handoff], ['索引', index], ['Task10', t10], ['Task9', t9], ['发布前核查', pre]]) {
  chk(`${name} 有 frontmatter 且 type 正确`, /^---[\s\S]*?type:\s*\S+/.test(txt));
}

console.log('=== Task 11 交接一致性检查 ===');
let all = true;
for (const [n, ok, d] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  → ' + d}`);
  if (!ok) all = false;
}
console.log(`\n共 ${results.length} 项`);
console.log(all ? 'HANDOFF_CHECK=PASS' : 'HANDOFF_CHECK=FAIL');
