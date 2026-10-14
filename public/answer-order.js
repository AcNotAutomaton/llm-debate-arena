import { state } from './core/state.js';
import { q, escapeHtml } from './core/dom.js';

export function modelIdentity(model) {
  return JSON.stringify([model.provider, model.id]);
}

export function preserveModelOrder(previous, selected) {
  const available = new Map(selected.map(model => [modelIdentity(model), model]));
  const ordered = previous.filter(model => available.has(modelIdentity(model)))
    .map(model => available.get(modelIdentity(model)));
  const retained = new Set(ordered.map(modelIdentity));
  return ordered.concat(selected.filter(model => !retained.has(modelIdentity(model))));
}

export function answerOrderText(order) {
  return Array.isArray(order) && order.length
    ? order.map((name, index) => `${index + 1}. ${name}`).join(' → ')
    : '未记录回答顺序';
}

export function answerOrderPolicyName(policy) {
  return policy === 'fixed' ? '固定顺序' : '逐场轮换';
}

export function createAnswerOrderUI({ onChange }) {
  function renderAnswerOrderEditors() {
    const locked = Boolean(state.isRunning || state.isExperimentRunning);
    for (const id of ['debugAnswerOrder', 'experimentAnswerOrder']) {
      const host = q('#' + id);
      host.replaceChildren();
      if (!state.config.selectedModels.length) {
        host.textContent = '尚未选择模型';
        continue;
      }
      state.config.selectedModels.forEach((model, index, models) => {
        const row = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${index + 1}. ${model.name}`;
        row.appendChild(label);
        for (const [direction, symbol, title] of [[-1, '↑', '提前回答'], [1, '↓', '推后回答']]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = symbol;
          button.title = `${model.name}：${title}`;
          button.setAttribute('aria-label', button.title);
          button.disabled = locked || index + direction < 0 || index + direction >= models.length;
          button.onclick = () => {
            if (state.isRunning || state.isExperimentRunning) return;
            const next = models.slice();
            [next[index], next[index + direction]] = [next[index + direction], next[index]];
            state.config.selectedModels = next;
            onChange();
          };
          row.appendChild(button);
        }
        host.appendChild(row);
      });
    }
    q('#experimentOrderPolicy').disabled = locked;
  }

  return { renderAnswerOrderEditors };
}

export function runOrderResultsHtml(run) {
  const order = run.speakerOrder;
  if (!Array.isArray(order) || !order.length) return '<p>未记录回答顺序</p>';
  const votes = run.votes || {};
  const complete = order.every(name => Number.isInteger(votes[name]) && votes[name] >= 0) &&
    order.reduce((sum, name) => sum + votes[name], 0) === order.length;
  const max = Math.max(0, ...order.map(name => Number(votes[name]) || 0));
  const leaders = max ? order.filter(name => votes[name] === max) : [];
  const outcome = !complete ? '互评票数不完整，不判本场最高票' : leaders.length === 1 ? `本场最高票：${leaders[0]}`
    : leaders.length ? `本场最高票并列：${leaders.join('、')}` : '本场无有效投票';
  return `<p class="answer-order-result">回答顺序：${escapeHtml(answerOrderText(order))}<br>` +
    order.map((name, i) => `${i + 1}位 ${escapeHtml(name)}：${Number(votes[name]) || 0}票`).join('；') +
    `<br>${escapeHtml(outcome)}</p>`;
}

export function stageOrderStatsHtml(stage) {
  const rows = new Map();
  for (const run of stage.runs || []) {
    const order = run.speakerOrder;
    // Only compare recorded, fully voted runs with the same stage candidates.
    if (!Array.isArray(order) || order.length !== stage.candidates.length ||
        new Set(order).size !== order.length || !order.every(name => stage.candidates.includes(name))) continue;
    const counts = order.map(name => run.votes?.[name]);
    if (!counts.every(n => Number.isInteger(n) && n >= 0) || counts.reduce((a, b) => a + b, 0) !== order.length) continue;
    const max = Math.max(...counts);
    const leaders = order.filter(name => run.votes[name] === max);
    order.forEach((name, index) => {
      const key = JSON.stringify([name, index]);
      const row = rows.get(key) || { name, position: index + 1, runs: 0, votes: 0, wins: 0, ties: 0 };
      row.runs++;
      row.votes += run.votes[name];
      if (leaders.includes(name)) leaders.length === 1 ? row.wins++ : row.ties++;
      rows.set(key, row);
    });
  }
  if (!rows.size) return '';
  const sorted = [...rows.values()].sort((a, b) => stage.candidates.indexOf(a.name) - stage.candidates.indexOf(b.name) || a.position - b.position);
  return '<h4>回答位置与得票</h4><div class="answer-order-table-wrap"><table class="answer-order-table"><thead><tr>' +
    ['模型', '回答位置', '场数', '总票数', '平均票数', '独占最高票', '并列最高票'].map(text => `<th scope="col">${text}</th>`).join('') +
    '</tr></thead><tbody>' + sorted.map(row => `<tr><td>${escapeHtml(row.name)}</td><td>${row.position}</td><td>${row.runs}</td><td>${row.votes}</td><td>${(row.votes / row.runs).toFixed(2)}</td><td>${row.wins}</td><td>${row.ties}</td></tr>`).join('') +
    '</tbody></table></div>';
}
