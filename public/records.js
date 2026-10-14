import { q, escapeHtml } from './core/dom.js';
import { fetchJSON, readExperiment } from './core/api.js';
import { experimentModeName } from './core/format.js';
import { answerOrderPolicyName, answerOrderText, stageOrderStatsHtml } from './answer-order.js';
import { RecordIconNodes } from './record-icons.js';

export function createRecordsUI() {
  const view = q('#recordsView');
  const list = q('#recordsList');
  const detail = q('#recordDetail');
  const search = q('#recordsSearch');
  const filter = q('#recordsStatusFilter');
  const sort = q('#recordsSort');
  const refresh = q('#refreshRecords');
  const labels = { completed: '已完成', running: '运行中', pending: '等待开始', tied: '出现并列', failed: '失败', interrupted: '已中断' };
  let records = [], selectedId = null, currentData = null, detailTab = 'stages';
  let listRequest = 0, detailRequest = 0;
  const e = value => escapeHtml(String(value ?? ''));
  const number = value => Number.isFinite(value) ? value : '—';
  const icon = name => `<span data-record-icon="${name}" aria-hidden="true"></span>`;

  function paintIcons(root) {
    for (const host of root.querySelectorAll('[data-record-icon]')) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
      for (const [tag, attributes] of RecordIconNodes[host.dataset.recordIcon] || []) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
        svg.appendChild(node);
      }
      host.replaceChildren(svg);
    }
  }

  function dateText(value, dateOnly = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未记录';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(date);
  }

  function statusHtml(status) {
    return `<span class="record-status" data-status="${Object.hasOwn(labels, status) ? status : 'unknown'}"><i></i>${e(labels[status] || status)}</span>`;
  }

  function notice(text) {
    q('#recordsNotice').textContent = text;
    q('#recordsNotice').hidden = !text;
  }

  function emptyHtml(title, subtitle = '') {
    return `<div class="records-empty">${icon('Archive')}<strong>${e(title)}</strong>${subtitle ? `<p>${e(subtitle)}</p>` : ''}</div>`;
  }

  function renderList() {
    const term = search.value.trim().toLocaleLowerCase();
    const matched = records.filter(record => {
      const statusMatches = filter.value === 'all' || (filter.value === 'active' ? ['pending', 'running'].includes(record.status) : record.status === filter.value);
      const text = [record.id, record.questionPreview, ...(record.models || [])].join(' ').toLocaleLowerCase();
      return statusMatches && (!term || text.includes(term));
    }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) * (sort.value === 'oldest' ? 1 : -1));
    q('#recordsMatchCount').textContent = matched.length === records.length ? `${records.length} 组实验` : `${matched.length} / ${records.length} 组实验`;
    list.replaceChildren();
    if (!matched.length) {
      list.innerHTML = emptyHtml(records.length ? '没有匹配的实验' : '暂无实验记录');
      if (records.length) {
        const reset = document.createElement('button');
        reset.className = 'record-text-button'; reset.textContent = '清除筛选'; reset.type = 'button';
        reset.onclick = () => { search.value = ''; filter.value = 'all'; renderList(); };
        list.querySelector('.records-empty').appendChild(reset);
      }
    }
    let lastDay = '';
    for (const record of matched) {
      const day = dateText(record.createdAt, true);
      if (day !== lastDay) {
        const heading = document.createElement('p'); heading.className = 'record-date-group'; heading.textContent = day;
        list.appendChild(heading); lastDay = day;
      }
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'record-row'; button.dataset.id = record.id;
      button.setAttribute('aria-pressed', String(record.id === selectedId));
      const title = record.questionPreview || (record.models || []).join(' / ') || '未命名实验';
      button.innerHTML = `<span class="record-row-meta">${statusHtml(record.status)}<time>${e(dateText(record.createdAt).split(' ')[1] || '')}</time></span>` +
        `<strong class="record-row-title">${e(title)}</strong><span class="record-row-models">${e((record.models || []).join(' · '))}</span>` +
        `<span class="record-row-footer"><span>${number(record.completedDebates)} / ${number(record.totalDebates)} 场</span><span>${record.ranking?.[0] ? `第一名 ${e(record.ranking[0])}` : '#' + e(record.id.slice(0, 8))}</span></span>`;
      button.title = title;
      button.onclick = () => selectRecord(record.id, true);
      list.appendChild(button);
    }
    paintIcons(list);
  }

  function renderRun(run, index) {
    const order = run.speakerOrder || [];
    const votes = run.votes || {};
    const complete = order.length > 0 && order.every(name => Number.isInteger(votes[name]) && votes[name] >= 0) && order.reduce((sum, name) => sum + votes[name], 0) === order.length;
    const max = Math.max(0, ...order.map(name => votes[name] || 0));
    const leaders = complete ? order.filter(name => votes[name] === max) : [];
    const result = !complete ? '互评票数不完整' : leaders.length === 1 ? `最高票：${leaders[0]}` : `最高票并列：${leaders.join('、')}`;
    const ballotHtml = run.individualVotes?.length ? `<details class="record-ballots"><summary>逐模型投票 ${icon('ChevronDown')}</summary><ul>${run.individualVotes.map(vote => `<li><span>${e(vote.voter)}</span><span>→ ${e(vote.chosen || '无有效投票')}</span></li>`).join('')}</ul></details>` : '';
    return `<article class="record-run"><div class="record-run-heading"><h4>第 ${index + 1} 场 <span>${run.tiebreak ? '加赛 ' + e(run.tiebreak) : '重复 ' + e(run.repeat)} · 辩题 ${e(run.questionIndex)} · ${number(run.discussionRounds)} 轮</span></h4>` +
      (run.recordFile ? `<a class="record-link" href="/api/debate-records/${encodeURIComponent(run.recordFile)}" target="_blank" rel="noopener">讨论记录 ${icon('ArrowUpRight')}</a>` : '<span class="record-muted">记录未保存</span>') +
      `</div><p class="record-run-caption">回答顺序与得票</p>` + (order.length ? `<ol class="record-run-order">${order.map((name, i) => `<li><span class="record-order-number">${i + 1}</span><span>${e(name)}</span><b>${number(votes[name])}<small>票</small></b></li>`).join('')}</ol>` : '<p class="record-muted">未记录回答顺序</p>') +
      `<div class="record-run-footer"><p>${e(result)}</p>${ballotHtml}</div></article>`;
  }

  function renderStage(stage, index) {
    const votes = Object.entries(stage.votes || {}).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...votes.map(([, count]) => Number(count) || 0));
    return `<details class="record-stage" ${index === 0 ? 'open' : ''}><summary><span class="record-stage-index">${e(stage.position)}</span><span class="record-stage-title">第 ${e(stage.position)} 阶段<strong>${e(stage.winner || '尚未选出')}</strong></span><span class="record-stage-meta">${(stage.runs || []).length} 场${stage.tiebreaks ? ' · 加赛 ' + e(stage.tiebreaks) : ''}</span>${icon('ChevronDown')}</summary><div class="record-stage-body">` +
      `<div class="record-vote-bars">${votes.map(([name, count]) => `<div class="record-vote-row" data-winner="${name === stage.winner}"><span>${e(name)}</span><div class="record-vote-track"><i style="width:${Math.max(0, Math.min(100, (Number(count) || 0) / max * 100))}%"></i></div><b>${number(count)}<small>票</small></b></div>`).join('')}</div>` +
      `<div class="record-runs">${(stage.runs || []).map(renderRun).join('') || '<p class="record-muted">尚未完成场次</p>'}</div></div></details>`;
  }

  function renderDetail(data) {
    const ranking = data.ranking || [];
    const models = data.models || [];
    const stages = data.stages || [];
    const questions = data.questions || [];
    const title = questions[0]?.split(/\r?\n/).find(line => line.trim()) || '实验详情';
    const meta = `${experimentModeName(data.protocol)} · ${answerOrderPolicyName(data.orderPolicy)}`;
    detail.innerHTML = `<div class="record-detail-heading"><button id="recordsBack" class="records-icon-button" title="返回实验列表" aria-label="返回实验列表">${icon('ChevronLeft')}</button><div class="record-detail-title"><div class="record-detail-meta">${statusHtml(data.status)}<span>${e(dateText(data.createdAt))} · 北京时间</span></div><h3>${e(title)}</h3><p>${e(meta)}</p></div><div class="record-detail-actions"><button id="copyRecordId" class="records-icon-button" title="复制实验编号" aria-label="复制实验编号">${icon('Copy')}</button><button id="exportRecord" class="records-icon-button" title="下载实验 JSON" aria-label="下载实验 JSON">${icon('Download')}</button></div></div>` +
      `<dl class="record-metrics"><div><dt>完成场次</dt><dd>${number(data.completedDebates)}<span> / ${number(data.totalDebates)}</span></dd></div><div><dt>参与模型</dt><dd>${models.length}<span> 个</span></dd></div><div><dt>每阶段循环</dt><dd>${number(data.repetitions)}<span> 次</span></dd></div><div><dt>基础回答轮数</dt><dd>${number(data.rounds)}<span> 轮</span></dd></div></dl>` +
      (data.tie ? `<p class="record-alert" data-tone="warning">第 ${e(data.tie.position)} 名并列：${e(data.tie.models.join('、'))}${data.tie.reason ? '。' + e(data.tie.reason) : ''}</p>` : '') +
      (data.error ? `<p class="record-alert" data-tone="error">${e(data.error)}</p>` : '') +
      `<section class="record-ranking"><div class="record-section-heading"><h3>${data.status === 'completed' ? '最终排名' : '已确定排名'}</h3><span>#${e(data.id.slice(0, 8))}</span></div>` +
      (ranking.length ? `<ol>${ranking.map((name, i) => `<li><span class="record-rank-number">${String(i + 1).padStart(2, '0')}</span><strong>${e(name)}</strong><span>${stages.find(stage => stage.winner === name) ? `${number(stages.find(stage => stage.winner === name).votes[name])} 票 · 第 ${i + 1} 阶段` : data.status === 'completed' && i === models.length - 1 ? '剩余模型' : ''}</span></li>`).join('')}</ol>` : '<p class="record-muted">尚未产生排名</p>') + '</section>' +
      `<div class="record-tabs" role="tablist" aria-label="实验详情"><button id="recordStagesTab" role="tab" data-record-tab="stages" aria-controls="recordStagesPanel">阶段票数</button><button id="recordPositionsTab" role="tab" data-record-tab="positions" aria-controls="recordPositionsPanel">回答位置</button><button id="recordSetupTab" role="tab" data-record-tab="setup" aria-controls="recordSetupPanel">原题与参数</button></div>` +
      `<section id="recordStagesPanel" role="tabpanel" aria-labelledby="recordStagesTab">${stages.map(renderStage).join('') || emptyHtml('暂无阶段结果')}</section>` +
      `<section id="recordPositionsPanel" role="tabpanel" aria-labelledby="recordPositionsTab">${stages.map(stage => { const stats = stageOrderStatsHtml({ ...stage, candidates: stage.candidates || Object.keys(stage.votes || {}) }); return stats ? `<section class="record-position-section"><h3>第 ${e(stage.position)} 阶段</h3>${stats}</section>` : ''; }).join('') || emptyHtml('暂无有效位置统计', '尚无完整投票或记录缺少回答顺序')}</section>` +
      `<section id="recordSetupPanel" role="tabpanel" aria-labelledby="recordSetupTab"><div class="record-section-heading"><h3>实验参数</h3></div><dl class="record-parameters">${[['回答方式', experimentModeName(data.protocol)], ['顺序策略', answerOrderPolicyName(data.orderPolicy)], ['温度', number(data.temperature)], ['输出预算', number(data.maxTokens) + ' Token'], ['创建时间', dateText(data.createdAt)], ['更新时间', dateText(data.updatedAt)]].map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl><h3 class="record-subheading">起始回答顺序</h3><p class="record-initial-order">${e(answerOrderText(models.map(model => model.name)))}</p><h3 class="record-subheading">原题与提示词</h3>${questions.map((question, i) => `<div class="record-question">${questions.length > 1 ? `<h4>问题 ${i + 1}</h4>` : ''}<pre>${e(question)}</pre></div>`).join('') || '<p class="record-muted">未记录题目</p>'}</section>`;
    paintIcons(detail);
    setTab(detailTab);
    for (const button of detail.querySelectorAll('[data-record-tab]')) {
      button.onclick = () => setTab(button.dataset.recordTab);
      button.onkeydown = event => {
        const tabs = [...detail.querySelectorAll('[data-record-tab]')];
        const index = tabs.indexOf(button);
        const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
        if (next) { event.preventDefault(); next.click(); next.focus(); }
      };
    }
    q('#recordsBack').onclick = () => { view.dataset.detail = 'false'; [...list.querySelectorAll('.record-row')].find(row => row.dataset.id === selectedId)?.focus(); };
    q('#copyRecordId').onclick = async () => {
      try { await navigator.clipboard.writeText(data.id); notice('实验编号已复制'); }
      catch { notice('复制失败：' + data.id); }
    };
    q('#exportRecord').onclick = () => {
      const saved = { ...data }; delete saved.liveChat;
      const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'experiment-' + data.id + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  }

  function setTab(tab) {
    detailTab = tab;
    for (const button of detail.querySelectorAll('[data-record-tab]')) {
      const selected = button.dataset.recordTab === tab;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      q('#' + button.getAttribute('aria-controls')).hidden = !selected;
    }
  }

  async function selectRecord(id, reveal = false) {
    const request = ++detailRequest;
    if (id !== selectedId) detailTab = 'stages';
    selectedId = id;
    if (reveal) view.dataset.detail = 'true';
    for (const row of list.querySelectorAll('.record-row')) row.setAttribute('aria-pressed', String(row.dataset.id === id));
    if (currentData?.id !== id) { detail.innerHTML = emptyHtml('正在读取实验…'); paintIcons(detail); }
    detail.setAttribute('aria-busy', 'true');
    try {
      const data = await readExperiment(id);
      if (request !== detailRequest) return;
      currentData = data; renderDetail(data);
    } catch (error) {
      if (request !== detailRequest) return;
      currentData = null;
      detail.innerHTML = `<button id="recordsBack" class="record-text-button" type="button">返回实验列表</button>` + emptyHtml('读取失败', error.message);
      q('#recordsBack').onclick = () => { view.dataset.detail = 'false'; };
      paintIcons(detail);
    } finally { if (request === detailRequest) detail.setAttribute('aria-busy', 'false'); }
  }

  async function load() {
    const request = ++listRequest;
    refresh.disabled = true; refresh.classList.add('is-loading'); notice('');
    if (!records.length) { list.innerHTML = emptyHtml('正在读取记录…'); paintIcons(list); }
    try {
      const { data } = await fetchJSON('/api/experiments', undefined, '无法读取实验记录');
      if (!Array.isArray(data)) throw new Error('实验记录格式异常');
      if (request !== listRequest) return;
      records = data;
      const completed = records.filter(record => record.status === 'completed').length;
      const active = records.filter(record => ['pending', 'running'].includes(record.status)).length;
      q('#recordsOverview').textContent = `${records.length} 组实验 · ${completed} 组完成${active ? ' · ' + active + ' 组运行中' : ''}`;
      if (selectedId && !records.some(record => record.id === selectedId)) { selectedId = null; currentData = null; }
      renderList();
      const nextId = selectedId || records[0]?.id;
      if (nextId) await selectRecord(nextId);
      else { ++detailRequest; detail.innerHTML = emptyHtml('暂无实验记录'); paintIcons(detail); view.dataset.detail = 'false'; }
    } catch (error) {
      if (request !== listRequest) return;
      notice(error.message + '，请稍后刷新');
      if (!records.length) { list.innerHTML = emptyHtml('记录暂时不可用'); paintIcons(list); }
    } finally {
      if (request === listRequest) { refresh.disabled = false; refresh.classList.remove('is-loading'); }
    }
  }

  search.addEventListener('input', renderList);
  filter.addEventListener('change', renderList);
  sort.addEventListener('change', renderList);
  refresh.onclick = load;
  paintIcons(view);
  return { load };
}
