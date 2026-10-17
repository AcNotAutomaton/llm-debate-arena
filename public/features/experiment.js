import { state } from '../core/state.js';
import { q, escapeHtml, experimentQuestions, experimentRepeats, experimentRounds, experimentEstimate, startExperimentBtn, experimentStatus, experimentLive, experimentResult } from '../core/dom.js';
import { fetchJSON, readExperiment } from '../core/api.js';
import { experimentModeName, isSameQuestionProtocol } from '../core/format.js';
import { answerOrderPolicyName, answerOrderText, stageOrderStatsHtml, runOrderResultsHtml } from '../answer-order.js';

export function createExperimentUI({ updateConfigSummary }) {
  let experimentPoll = null;
  let liveDebateId = null;
  let experimentSummaryKey = null;

  function experimentQuestionList() {
    const prompt = experimentQuestions.value.trim();
    return prompt ? [prompt] : [];
  }
  function updateExperimentEstimate() {
    const n = state.config.selectedModels.length;
    const repeats = Number(experimentRepeats.value) || 0;
    const rounds = Number(experimentRounds.value) || 0;
    const calls = repeats * (rounds + 1) * (n * (n + 1) / 2 - 1);
    experimentEstimate.textContent = n >= 2 && n <= 4 && experimentQuestionList().length && repeats
      ? `${n} 个模型 · 基础 ${repeats * (n - 1)} 场 · 约 ${calls} 次模型调用（含互评，不含重试与加赛）。每场 ${rounds} 轮同题回答`
      : "选模型并填写提示词后显示预计场次";
  }
  function renderExperiment(data) {
    q('#experimentMonitor').dataset.running = String(['running', 'pending'].includes(data.status));
    q('#experimentSetup').hidden = true;
    q('#experimentMonitor').hidden = false;
    q('#newExperimentBtn').hidden = ['running', 'pending'].includes(data.status);
    const stage = data.stages[data.stages.length - 1];
    const stageText = stage ? `；当前第 ${stage.position} 名候选：${stage.candidates.join("、")}` : "";
    const statusName = { pending: "等待开始", running: "运行中", completed: "已完成", tied: "出现并列", failed: "运行失败", interrupted: "运行中断" }[data.status] || data.status;
    experimentStatus.textContent = `${statusName} · ${experimentModeName(data.protocol)} · ${answerOrderPolicyName(data.orderPolicy)} · ${data.completedDebates}/${data.totalDebates} 场${stageText}` + (data.error ? `；${data.error}` : "");
    renderExperimentLive(data.current, data.protocol);
    renderExperimentChat(data.liveChat);
    const summaryKey = JSON.stringify([data.id, data.status, data.completedDebates, data.ranking, data.stages.map(s => [s.winner, s.runs.length]), data.error]);
    if (summaryKey === experimentSummaryKey) return;
    experimentSummaryKey = summaryKey;
    let html = "";
    if (data.ranking.length) {
      html += `<h3>排名</h3><ol>${data.ranking.map(name => `<li>${escapeHtml(name)}</li>`).join("")}</ol>`;
    }
    if (data.status === "completed") {
      html += '<p>排名已完成，每场讨论已保存到 debates/ 的 Markdown 文件。</p>';
    } else if (data.status === "tied") {
      html += `<p>第 ${data.tie.position} 名并列：${data.tie.models.map(escapeHtml).join("、")}。${escapeHtml(data.tie.reason || "请增加辩题或重复次数后重新运行。")}</p>`;
    }
    for (const stage of data.stages) {
      html += `<details><summary>第 ${stage.position} 名：${stage.winner ? escapeHtml(stage.winner) : "统计中"}（${stage.runs.length} 场）</summary>`;
      html += '<div class="stage-votes">' + Object.entries(stage.votes).map(([name, count]) => `<span>${escapeHtml(name)}：${count} 票</span>`).join("") + '</div>';
      html += stageOrderStatsHtml(stage);
      html += '<ol>' + stage.runs.map(run => `<li>辩题 ${run.questionIndex} · ${run.tiebreak ? `加赛 ${run.tiebreak}` : `重复 ${run.repeat}`}${run.discussionRounds ? ` · ${isSameQuestionProtocol(data.protocol) ? '回答' : data.protocol === 'reciprocal-qa-v5' ? '问答' : '讨论'} ${run.discussionRounds} 轮` : ''} · ${Object.entries(run.votes).map(([name, count]) => `${escapeHtml(name)} ${count}`).join(" / ")} · ${run.recordFile ? `<a href="/api/debate-records/${encodeURIComponent(run.recordFile)}" target="_blank" rel="noopener">查看完整讨论记录</a>` : '<span>记录未保存</span>'}${runOrderResultsHtml(run)}</li>`).join("") + '</ol></details>';
    }
    experimentResult.innerHTML = html;
  }

  function renderExperimentChat(chat) {
    const panel = q('#experimentChat');
    panel.hidden = !chat;
    q('#experimentMonitor').dataset.chat = String(Boolean(chat));
    if (!chat) return;
    const messages = panel.querySelector('.experiment-chat-messages');
    const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    if (panel.dataset.debateId !== chat.debateId) {
      messages.replaceChildren();
      panel.dataset.debateId = chat.debateId;
    }
    const states = { waiting: '等待响应', thinking: '思考中', output: '输出正文中', retrying: '自动重试中', completed: '已完成', failed: '失败或无有效投票' };
    chat.messages.forEach((message, index) => {
      let bubble = messages.children[index];
      if (!bubble) {
        bubble = document.createElement('article');
        bubble.className = 'experiment-chat-message';
        bubble.innerHTML = '<h4></h4><p class="chat-status"></p><details class="chat-reasoning" open><summary>思考过程</summary><pre></pre></details><pre class="chat-output"></pre><p class="chat-notice"></p>';
        messages.appendChild(bubble);
      }
      const round = typeof message.round === 'number' ? `第 ${message.round} 步` : message.round === 'eval-retry' ? '互评补投' : '互评';
      bubble.querySelector('h4').textContent = `${message.model} · ${round}${message.phase ? ' · ' + message.phase : ''}${message.partner ? ' → ' + message.partner : ''}`;
      const active = !['completed', 'failed'].includes(message.state);
      const seconds = Math.max(0, Math.floor((Date.now() - (message.lastTokenAt || message.startedAt)) / 1000));
      bubble.dataset.state = message.state;
      bubble.querySelector('.chat-status').textContent = (states[message.state] || message.state) + (active ? ` · ${message.lastTokenAt ? '距上次内容' : '已等待'} ${seconds} 秒${seconds >= 60 ? '，暂未收到新内容，请留意上游响应' : ''}` : '');
      const reasoning = bubble.querySelector('.chat-reasoning');
      reasoning.hidden = !message.reasoning;
      reasoning.querySelector('pre').textContent = message.reasoning || '';
      bubble.querySelector('.chat-output').textContent = message.text || (active && !message.reasoning ? '等待接口返回内容…' : '');
      bubble.querySelector('.chat-notice').textContent = message.notice || '';
    });
    while (messages.children.length > chat.messages.length) messages.lastElementChild.remove();
    if (follow) messages.scrollTop = messages.scrollHeight;
  }

  function renderExperimentLive(current, protocol) {
    if (!current) {
      experimentLive.hidden = true;
      liveDebateId = null;
      return;
    }
    experimentLive.hidden = false;
    if (liveDebateId !== current.debateId) {
      liveDebateId = current.debateId;
      experimentLive.innerHTML = '<h3>当前场次</h3><p class="live-meta"></p><p class="live-order"></p><p class="live-question"></p><div class="live-speeches"></div><p class="live-phase"></p><pre class="live-text"></pre><div class="live-evaluations"></div>';
    }
    experimentLive.querySelector('.live-meta').textContent = `第 ${current.stage} 阶段 · 辩题 ${current.questionIndex} · ${current.tiebreak ? `第 ${current.tiebreak} 次加赛` : `第 ${current.repeat} 次重复`}${current.discussionRounds ? ` · ${isSameQuestionProtocol(protocol) ? '回答' : protocol === 'reciprocal-qa-v5' ? '问答' : '讨论'} ${current.discussionRounds} 轮` : ''} · 匿名对照：${current.speakerOrder.map((name, i) => `${String.fromCharCode(65 + i)}=${name}`).join('；')}`;
    experimentLive.querySelector('.live-question').textContent = `辩题：${current.question}`;
    experimentLive.querySelector('.live-order').textContent = '本场每轮回答顺序：' + answerOrderText(current.speakerOrder);
    experimentLive.querySelector('.live-phase').textContent = `${current.phase} · 第 ${current.step}/${current.totalSteps} 步${current.model ? ' · ' + current.model : ''}${current.partner ? ' → ' + current.partner : ''}${current.error ? ' · ' + current.error : ''}`;
    experimentLive.querySelector('.live-text').textContent = current.text || (current.phase === '独立回答' || /^(讨论|问答|回答)/.test(current.phase) ? '等待模型输出...' : '');
    const speeches = experimentLive.querySelector('.live-speeches');
    while (speeches.children.length < current.speeches.length) {
      const speech = current.speeches[speeches.children.length];
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `第 ${speech.step} 步 · ${speech.model}${speech.phase ? ' · ' + speech.phase : ''}${speech.partner ? ' → ' + speech.partner : ''}（点击展开发言）`;
      const body = document.createElement('pre');
      body.textContent = speech.text;
      details.append(summary, body);
      speeches.appendChild(details);
    }
    experimentLive.querySelector('.live-evaluations').textContent = current.evaluations.length
      ? '互评投票：' + current.evaluations.map(ev => `${ev.model} → ${ev.winRes || '无有效投票'}`).join('；')
      : '';
  }

  async function pollExperiment(id) {
    try {
      const data = await readExperiment(id);
      renderExperiment(data);
      if (["completed", "tied", "failed", "interrupted"].includes(data.status)) {
        clearInterval(experimentPoll);
        experimentPoll = null;
        state.isExperimentRunning = false;
        updateConfigSummary();
      }
    } catch (error) {
      clearInterval(experimentPoll);
      experimentPoll = null;
      state.isExperimentRunning = false;
      updateConfigSummary();
      experimentStatus.textContent = error.message;
    }
  }

  startExperimentBtn.onclick = async () => {
    q('#experimentMonitor').hidden = false;
    q('#experimentMonitor').dataset.running = 'false';
    experimentResult.innerHTML = '';
    experimentLive.hidden = true;
    renderExperimentChat(null);
    const models = state.config.selectedModels;
    const questions = experimentQuestionList();
    const repeats = Number(experimentRepeats.value);
    if (models.length < 2 || models.length > 4) {
      experimentStatus.textContent = "请选择 2–4 个模型";
      return;
    }
    if (!questions.length || questions[0].length > 4000) {
      experimentStatus.textContent = "请填写提示词，不超过 4000 字";
      return;
    }
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
      experimentStatus.textContent = "每阶段循环次数应为 1–10";
      return;
    }
    state.isExperimentRunning = true;
    updateConfigSummary();
    experimentStatus.textContent = "正在创建实验...";
    experimentResult.innerHTML = "";
    try {
      const { response, data } = await fetchJSON("/api/experiments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          models, questions, repetitions: repeats,
          rounds: Number(experimentRounds.value),
          orderPolicy: q('#experimentOrderPolicy').value,
          temperature: state.config.temperature,
          maxTokens: state.config.maxTokens, anonymous: true
        })
      });
      if (!response.ok) throw new Error(data.error || "创建实验失败");
      localStorage.setItem("lastExperimentId", data.id);
      q('#experimentSetup').hidden = true;
      q('#newExperimentBtn').hidden = true;
      await pollExperiment(data.id);
      if (state.isExperimentRunning) experimentPoll = setInterval(() => pollExperiment(data.id), 1000);
    } catch (error) {
      state.isExperimentRunning = false;
      updateConfigSummary();
      experimentStatus.textContent = error.message;
    }
  };

  experimentQuestions.addEventListener("input", updateExperimentEstimate);
  experimentRepeats.addEventListener("input", updateExperimentEstimate);
  experimentRounds.addEventListener("input", updateExperimentEstimate);
  const lastExperimentId = localStorage.getItem("lastExperimentId");
  if (lastExperimentId) {
    readExperiment(lastExperimentId).then(data => {
      renderExperiment(data);
      if (["pending", "running"].includes(data.status)) {
        state.isExperimentRunning = true;
        updateConfigSummary();
        experimentPoll = setInterval(() => pollExperiment(lastExperimentId), 1000);
      }
    }).catch(() => localStorage.removeItem("lastExperimentId"));
  }

  return { updateExperimentEstimate };
}
