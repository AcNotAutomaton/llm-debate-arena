#!/usr/bin/env node
// tally.cjs — LLM 辩论投票统计脚本（方案 A：只统计带 win_res 的新文件）
//
// 用法:
//   node scripts/tally.cjs                     # 统计默认目录 debates/
//   node scripts/tally.cjs debates/glm         # 统计指定目录
//   node scripts/tally.cjs debates/ --csv      # 输出 CSV(重定向 > result.csv)
//   node scripts/tally.cjs --help              # 帮助
//
// 仅统计含 win_res 行的辩论文件，保证统计结果准确。

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const helpIdx = args.indexOf('--help');
if (helpIdx >= 0 || args.indexOf('-h') >= 0) {
  console.log('用法: node scripts/tally.cjs [目录路径] [--csv]');
  console.log('  默认目录: debates/');
  console.log('  --csv  : 以 CSV 格式输出，方便导入 Excel');
  process.exit(0);
}

// 解析参数
let dirArg = 'debates';
const csvIdx = args.indexOf('--csv');
if (csvIdx >= 0) args.splice(csvIdx, 1);
if (args.length > 0) dirArg = args[0];

const ROOT = path.resolve(__dirname, '..');
const dir = path.isAbsolute(dirArg) ? dirArg : path.join(ROOT, dirArg);

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error('错误: 目录不存在 → ' + dir);
  process.exit(1);
}

// 递归收集所有 .md 文件
function collectMd(d) {
  const out = [];
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...collectMd(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = collectMd(dir);

// 提取一个文件的投票信息
function analyzeFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const idx = content.indexOf('## 模型互评');
  if (idx < 0) return null; // 无互评段
  const section = content.substring(idx);

  // 取参与模型(找"参与模型"或"参与模型":> ... 这一行)
  let participants = [];
  const pmMatch = content.match(/\*\*参与模型\*\*[:：]\s*([^\n]+)/);
  if (pmMatch) {
    participants = pmMatch[1].split(/[,，]\s*/).map(s => s.trim()).filter(Boolean);
  }

  // 拆每个互评段: **模型名**: 内容
  const parts = section.split(/\*\*([^*]+?)\*\*[:：]/).filter(Boolean);
  // parts: [前导, name1, content1, name2, content2, ...]
  const votes = {}; // 胜者 => 票数
  const modelVotes = {}; // 互评者 => 其投的胜者
  let hasAnyWinRes = false;
  let usedAnonTag = false; // 匿名场（投票值是「参与者X」这种中立标识）

  // 匿名场把「参与者A/B/C…」按参与模型列表顺序映射回真实模型名
  // （文件头「参与模型: 模型1, 模型2」的顺序即字母序：A->0, B->1, …）
  const mapName = (raw) => {
    const mm = /^参与者([A-Z])$/.exec(raw);
    if (mm && participants.length) {
      const idx = mm[1].charCodeAt(0) - 65;
      if (idx >= 0 && idx < participants.length) return participants[idx];
    }
    return raw;
  };

  for (let i = 1; i + 1 < parts.length; i += 2) {
    const who = parts[i].trim();
    const txt = parts[i + 1] || '';
    const m = txt.match(/win_res[:：]\s*([^\n\r，。 ]+)/i);
    if (m) {
      hasAnyWinRes = true;
      const rawWin = m[1].trim();
      if (/^参与者[A-Z]$/.test(rawWin)) usedAnonTag = true;
      const win = mapName(rawWin);
      votes[win] = (votes[win] || 0) + 1;
      modelVotes[who] = win;
    } else {
      modelVotes[who] = '(未投票)';
    }
  }
  if (!hasAnyWinRes) return null; // 跳过无 win_res 的旧文件

  // 判定胜负
  const sorted = Object.keys(votes).map(k => ({ name: k, n: votes[k] })).sort((a, b) => b.n - a.n);
  let result;
  if (sorted.length === 0) result = '无投票';
  else if (sorted.length === 1) result = sorted[0].name + ' 胜';
  else if (sorted[0].n > sorted[1].n) result = sorted[0].name + ' 胜';
  else result = '平局';

  // 匿名场用于在明细里标注「A=真身 / B=真身」的对照
  const anonMapping = usedAnonTag && participants.length
    ? participants.map((p, i) => String.fromCharCode(65 + i) + '=' + p).join('/')
    : '';
  return { file: path.basename(file), participants, votes, modelVotes, result, sorted, anonymous: usedAnonTag, anonMapping };
}

// 分析所有文件
const stats = [];
let skipped = 0;
for (const f of files) {
  const r = analyzeFile(f);
  if (r) stats.push(r);
  else skipped++;
}

// 汇总所有投票
const totalVotes = {};
const matchResults = {};
for (const s of stats) {
  for (const k of Object.keys(s.votes)) totalVotes[k] = (totalVotes[k] || 0) + s.votes[k];
  matchResults[s.result] = (matchResults[s.result] || 0) + 1;
}
const totalSorted = Object.keys(totalVotes).map(k => ({ name: k, n: totalVotes[k] })).sort((a, b) => b.n - a.n);
const totalVoteCount = totalSorted.reduce((a, b) => a + b.n, 0);

// ====== 输出 ======
if (csvIdx >= 0) {
  // CSV
  console.log('文件,结果,' + (totalSorted.map(s => s.name + '得票').join(',')));
  for (const s of stats) {
    const row = [s.file, s.result];
    for (const ts of totalSorted) row.push(s.votes[ts.name] || 0);
    console.log(row.join(','));
  }
  console.log('');
  console.log('汇总,' + (Object.keys(matchResults).map(k => k + ':' + matchResults[k]).join('|')));
  process.exit(0);
}

// 文本报告
const bar = (n, max) => {
  const maxLen = 24;
  const ratio = max === 0 ? 0 : n / max;
  return '█'.repeat(Math.round(ratio * maxLen));
};

console.log('');
console.log('========================================');
console.log('  LLM 辩论投票统计');
console.log('  目录: ' + path.relative(ROOT, dir));
console.log('========================================');
console.log('扫描文件: ' + files.length + '  | 含 win_res: ' + stats.length + '  | 跳过(无win_res): ' + skipped);
console.log('');

if (stats.length === 0) {
  console.log('⚠️ 该目录下没有含 win_res 的辩论文件。');
  console.log('   请先跑一场新辩论（互评会自动生成 win_res 行），再运行本脚本。');
  console.log('   含 win_res 的文件才被统计，旧文件(无投票格式)会被跳过——这是预期行为。');
  console.log('');
  process.exit(0);
}

// 匿名场对照表：凡是出现「参与者X」投票的场次，统一在顶部列出 A/B/... = 真身
const anonMatches = stats.filter(s => s.anonymous && s.anonMapping);
const anonSet = {};
for (const s of anonMatches) anonSet[s.anonMapping] = true;
const anonLines = Object.keys(anonSet);
if (anonLines.length > 0) {
  console.log('【匿名场真身对照】');
  for (const line of anonLines) console.log('  参与者 ' + line);
  console.log('');
}

if (totalVoteCount > 0) {
  console.log('【参与模型得票总数】');
  const maxN = totalSorted.length > 0 ? totalSorted[0].n : 1;
  for (const s of totalSorted) {
    const pct = totalVoteCount === 0 ? 0 : Math.round(s.n / totalVoteCount * 1000) / 10;
    console.log('  ' + s.name.padEnd(20) + ' : ' + s.n + ' 票  ' + bar(s.n, maxN) + ' ' + pct + '%');
  }
  console.log('');
}

console.log('【按场次明细】');
for (const s of stats) {
  const parts = s.sorted.map(t => t.name + '(' + t.n + ')').join(' vs ');
  // 匿名场附带真身对照，让「参与者A vs 参与者B」一眼可读
  const tag = s.anonMapping ? '  [' + s.anonMapping + ']' : '';
  console.log('  ' + s.file + '  ' + parts + '  → ' + s.result + tag);
}
console.log('');

console.log('【场次汇总】');
const keys = Object.keys(matchResults);
if (keys.length === 0) console.log('  (无)');
else {
  for (const k of keys) console.log('  ' + k.padEnd(22) + ' : ' + matchResults[k] + ' 场');
}
console.log('');
if (skipped > 0) {
  console.log('ℹ️ 已跳过 ' + skipped + ' 个无 win_res 的旧文件(它们没有投票格式行，不属于本次统计)。');
  console.log('');
}