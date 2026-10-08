const fs = require('node:fs');
const path = require('node:path');

function updateRankingSummary(root = path.resolve(__dirname, '../..')) {
  const dir = path.join(root, 'experiments');
  const rows = [];
  for (const filename of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(filename)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8'));
      if (data.status !== 'completed' || !Array.isArray(data.ranking) ||
          !Array.isArray(data.models) || data.ranking.length !== data.models.length ||
          data.ranking.length < 2 || data.ranking.length > 4 ||
          new Set(data.ranking).size !== data.ranking.length ||
          !data.ranking.every(name => typeof name === 'string' && data.models.some(model => model.name === name))) continue;
      rows.push({ ...data, filename });
    } catch { /* 损坏的单个记录不影响其他完整排名。 */ }
  }
  rows.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)) || a.filename.localeCompare(b.filename));
  const cell = value => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '&#124;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const time = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
  };
  const lines = ['# 排名实验汇总', '', '自动汇总已完成且排名完整的实验，最新结果在前。时间为北京时间；未参加的名次用 — 表示。',
    '本文件由 experiments/ 中的 JSON 记录生成，请勿手动编辑；原始实验记录保留不变。', '',
    '| 完成时间 | 第1名 | 第2名 | 第3名 | 第4名 | 题目摘要 | 方式 | 实验编号 / 详细结果 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of rows) {
    const prompt = (row.questions || []).join(' / ').replace(/\s+/g, ' ').trim();
    const excerpt = prompt.length > 100 ? prompt.slice(0, 100) + '…' : prompt;
    const mode = row.protocol === 'same-question-v6' ? '同题回答' : row.protocol === 'reciprocal-qa-v5' ? '对称问答' : '旧讨论方式';
    lines.push(`| ${time(row.updatedAt || row.createdAt)} | ${[0, 1, 2, 3].map(i => cell(row.ranking[i] || '—')).join(' | ')} | ${cell(excerpt)} | ${mode} | [${row.filename.slice(0, -5)}](../experiments/${row.filename}) |`);
  }
  if (!rows.length) lines.push('', '暂无已完成的完整排名。');
  const outputDir = path.join(root, 'debates');
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, '排名实验汇总.md');
  const content = lines.join('\n') + '\n';
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content, 'utf8');
  return file;
}

module.exports = { updateRankingSummary };
if (require.main === module) console.log(updateRankingSummary());
