const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateRankingSummary } = require('../src/reports/ranking-summary.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ranking-summary-'));
const dir = path.join(root, 'experiments');
const names = ['A', 'B', 'C', 'D'];
try {
  fs.mkdirSync(dir);
  const save = (n, status, ranking, date) => {
    const filename = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify({ status, ranking,
      models: names.slice(0, ranking.length).map(name => ({ name })),
      updatedAt: date, protocol: n === 1 ? 'same-question-v6' : 'reciprocal-qa-v5', questions: ['题目|含换行\n和代码 <div>'] }));
  };
  save(1, 'completed', names, '2026-10-04T10:00:00Z');
  save(2, 'completed', ['B', 'A'], '2026-10-05T10:00:00Z');
  save(3, 'running', names, '2026-10-06T10:00:00Z');
  save(4, 'tied', names, '2026-10-06T10:00:00Z');
  save(5, 'completed', ['A', 'A'], '2026-10-06T10:00:00Z');
  fs.writeFileSync(path.join(dir, '00000000-0000-0000-0000-000000000006.json'), '{broken');
  const file = updateRankingSummary(root);
  assert.equal(file, path.join(root, 'debates', '排名实验汇总.md'));
  const first = fs.readFileSync(file, 'utf8');
  assert.match(first, /2026-10-05 18:00:00 \| B \| A \| — \| —/);
  assert.match(first, /2026-10-04 18:00:00 \| A \| B \| C \| D/);
  assert.ok(first.indexOf('000000000002') < first.indexOf('000000000001'));
  for (const n of [3, 4, 5, 6]) assert.ok(!first.includes(String(n).padStart(12, '0')));
  assert.match(first, /题目&#124;含换行 和代码 &lt;div&gt;/);
  assert.match(first, /\]\(\.\.\/experiments\//);
  assert.match(first, /同题回答/);
  assert.match(first, /对称问答/);
  updateRankingSummary(root);
  assert.equal(fs.readFileSync(file, 'utf8'), first, '重复生成不得产生重复记录');
  console.log('PASS: 排名汇总顺序、北京时间、完整性过滤、表格转义与重复生成');
} finally {
  for (const filename of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, filename));
  fs.rmdirSync(dir);
  const summary = path.join(root, 'debates', '排名实验汇总.md');
  if (fs.existsSync(summary)) fs.unlinkSync(summary);
  fs.rmdirSync(path.join(root, 'debates'));
  fs.rmdirSync(root);
}
