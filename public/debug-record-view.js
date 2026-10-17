import { escapeHtml } from './core/dom.js';

const e = value => escapeHtml(String(value ?? ''));

export function debugResultsHtml(data) {
  const votes = Object.entries(data.votes || {});
  const max = Math.max(1, ...votes.map(([, count]) => Number(count) || 0));
  return `<section class="record-debug-results"><div class="record-section-heading"><h3>本场互评得票</h3><span>${data.anonymous === undefined ? '历史记录' : data.anonymous ? '匿名互评' : '实名互评'}</span></div>` +
    (votes.length ? `<div class="record-vote-bars">${votes.map(([name, count]) => `<div class="record-vote-row"><span>${e(name)}</span><div class="record-vote-track"><i style="width:${Math.max(0, Math.min(100, (Number(count) || 0) / max * 100))}%"></i></div><b>${e(count)}<small>票</small></b></div>`).join('')}</div>` : '<p class="record-muted">未记录结构化票数</p>') +
    (data.judgeResult?.winner ? `<p class="record-muted">裁判选出：${e(data.judgeResult.winner)}</p>` : '') + '</section>';
}

export function debugTranscriptHtml(data) {
  const source = `<a class="record-link" href="/api/records/${encodeURIComponent(data.id)}/markdown" target="_blank" rel="noopener">查看原始 Markdown</a>`;
  if (data.legacy) return `<p class="record-muted record-archive-note">历史 Markdown 记录。未保存的运行参数、回答位置和结构化票数不作推断。</p>${source}<pre class="record-transcript record-legacy-text">${e(data.rawMarkdown)}</pre>`;
  const history = (data.history || []).map((entry, index) => `<details class="record-speech" ${index === 0 ? 'open' : ''}><summary>第 ${e(entry.step || index + 1)} 步 · ${e(entry.model)}${entry.label ? ' · ' + e(entry.label) : ''}</summary><pre class="record-transcript">${e(entry.content)}</pre></details>`).join('');
  const evaluations = (data.evaluations || []).map(evaluation => {
    const chosen = data.individualVotes?.find(vote => vote.voter === evaluation.model)?.chosen;
    return `<details class="record-speech"><summary>${e(evaluation.model)} · ${chosen ? '投给 ' + e(chosen) : '无有效投票'}</summary><pre class="record-transcript">${e(evaluation.evaluation)}</pre></details>`;
  }).join('');
  return (data.recordFile ? source : '') + `<h3 class="record-subheading">模型回答</h3>${history || '<p class="record-muted">未保存回答内容</p>'}` +
    `<h3 class="record-subheading">模型互评</h3>${evaluations || '<p class="record-muted">未进行互评或互评前已中断</p>'}` +
    (data.judgeResult?.judgeText ? `<h3 class="record-subheading">裁判评价</h3><pre class="record-transcript record-judge-text">${e(data.judgeResult.judgeText)}</pre>` : '');
}
