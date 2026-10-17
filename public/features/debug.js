import { state, COLORS } from '../core/state.js';
import { q, escapeHtml, questionInput, startBtn, arena, judgePanel, progressBar, progressFill, progressText } from '../core/dom.js';
import { fetchJSON, openDebateStream } from '../core/api.js';
import { answerOrderText, runOrderResultsHtml } from '../answer-order.js';

export function createDebugUI({ updateConfigSummary }) {
  startBtn.onclick = startDebate;

  async function startDebate() {
    const question = questionInput.value.trim();
    if (!question) { questionInput.focus(); return; }
    const models = state.config.selectedModels;
    if (models.length < 2) { alert("\u8bf7\u81f3\u5c11\u9009\u62e92\u4e2a\u6a21\u578b"); return; }

    state.isRunning = true;
    state.debugModels = models.slice();
    updateConfigSummary();
    q('#debugActualOrder').hidden = false;
    q('#debugActualOrder').textContent = '本场每轮回答顺序：' + answerOrderText(models.map(m => m.name));
    startBtn.disabled = true;
    startBtn.textContent = "\u23f3 \u8fa9\u8bba\u8fdb\u884c\u4e2d...";
    arena.innerHTML = "";
    judgePanel.style.display = "none";
    progressBar.style.display = "block";
    progressFill.style.width = "0%";
    progressText.textContent = "";

    initArena(models);

    try {
      const { data } = await fetchJSON("/api/debate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          models: models.map(m => {
            let apiKey = "";
            if (m.provider === "deepseek") apiKey = state.config.deepseekApiKey;
            else if (m.provider === "glm") apiKey = state.config.glmApiKey;
            else if (m.provider === "opencode") apiKey = state.config.opencodeApiKey;
            return { id: m.id, name: m.name, provider: m.provider, apiKey };
          }),
          rounds: state.config.rounds,
          temperature: state.config.temperature,
          maxTokens: state.config.maxTokens,
          anonymous: state.config.anonymous,
        })
      });
      if (data.error) throw new Error(data.error);
      state.debateId = data.debateId;
      connectSSE(data.debateId, models);
    } catch (err) {
      alert("\u542f\u52a8\u8fa9\u8bba\u5931\u8d25: " + err.message);
      resetUI();
    }
  }

  function initArena(models) {
    models.forEach((m, i) => {
      const color = COLORS[i % COLORS.length];
      const card = document.createElement("div");
      card.className = "model-card";
      card.id = "card-" + i;
      let bdg = "";
      if (m.provider === "deepseek") bdg = '<span class="provider-badge ds" style="font-size:10px">DeepSeek</span>';
      if (m.provider === "glm") bdg = '<span class="provider-badge glm" style="font-size:10px">GLM</span>';
      if (m.provider === "opencode") bdg = '<span class="provider-badge opencode" style="font-size:10px">OpenCode</span>';
    card.innerHTML = '<div class="card-header">' +
        '<div class="card-avatar" style="background:' + color.bg + '">' + m.name.charAt(0).toUpperCase() + "</div>" +
        '<span class="card-name">' + m.name + " " + bdg + "</span>" +
        '<span class="card-status status-waiting" id="status-' + i + '">\u7b49\u5f85\u4e2d</span>' +
      '</div><div class="card-body" id="body-' + i + '"></div>';
      arena.appendChild(card);
    });
  }

  function getCardIndex(modelName) {
    return (state.debugModels || state.config.selectedModels).findIndex(m => m.name === modelName);
  }

  function addRoundLabel(cardIndex, turn, model) {
    const body = document.getElementById("body-" + cardIndex);
    if (!body) return;
    const div = document.createElement("div");
    div.className = "round-label";
    div.textContent = "第 " + turn + " 步 · " + model;
    body.appendChild(div);
  }

  function addStreamNotice(cardIndex, text, cls) {
    const body = document.getElementById("body-" + cardIndex);
    if (!body) return;
    const notice = document.createElement("div");
    notice.className = "stream-notice " + (cls || "");
    notice.textContent = text;
    body.appendChild(notice);
    body.scrollTop = body.scrollHeight;
  }

  function addMessage(cardIndex, text, isStreaming) {
    const body = document.getElementById("body-" + cardIndex);
    if (!body) return;
    let msg = body.querySelector(".model-message:last-child");
    if (!msg || !msg.dataset.streaming) {
      msg = document.createElement("div");
      msg.className = "model-message";
      msg.dataset.streaming = "true";
      body.appendChild(msg);
    }
    if (isStreaming) {
      msg.textContent = text;
      if (!msg.querySelector(".cursor")) {
        const cursor = document.createElement("span");
        cursor.className = "cursor";
        msg.appendChild(cursor);
      }
    } else {
      msg.textContent = text;
      delete msg.dataset.streaming;
      const cursor = msg.querySelector(".cursor");
      if (cursor) cursor.remove();
    }
    body.scrollTop = body.scrollHeight;
  }

  function setCardStatus(index, status, label) {
    const el = document.getElementById("status-" + index);
    if (!el) return;
    const card = document.getElementById("card-" + index);
    el.textContent = label;
    el.className = "card-status status-" + status;
    card.className = "model-card " + status;
  }

  function connectSSE(debateId, models) {
    if (state.eventSource) state.eventSource.close();
    const es = openDebateStream(debateId);
    state.eventSource = es;
    const modelStatus = {};
    es.addEventListener('debate-start', e => {
      const data = JSON.parse(e.data);
      q('#debugActualOrder').textContent = '本场每轮回答顺序：' + answerOrderText(data.speakerOrder || data.models.map(m => m.name));
    });

    es.addEventListener("round-start", (e) => {
      const data = JSON.parse(e.data);
      const pct = ((data.turn - 1) / data.totalTurns * 100);
      progressFill.style.width = pct + "%";
      progressText.textContent = "第 " + data.turn + "/" + data.totalTurns + " 步 · " + data.model;
      const idxMD = getCardIndex(data.model);
      if (idxMD >= 0) { addRoundLabel(idxMD, data.turn, data.model); }
    })

  es.addEventListener("model-start", (e) => {
      const data = JSON.parse(e.data);
      const idx = getCardIndex(data.model);
      if (idx >= 0) { setCardStatus(idx, "thinking", "\u601d\u8003\u4e2d..."); modelStatus[data.model] = ""; }
      // 前端兜底计时器：若 70s 没有任何 token 到达，提示"长时间无响应"（覆盖 fetch 握手卡死/SSE 断线）
      if (state.thinkingTimers && state.thinkingTimers[data.model]) clearTimeout(state.thinkingTimers[data.model]);
      state.thinkingTimers = state.thinkingTimers || {};
      state.thinkingTimers[data.model] = setTimeout(() => {
        const i = getCardIndex(data.model);
        if (i >= 0 && !(modelStatus[data.model] && modelStatus[data.model].length > 0)) {
          addStreamNotice(i, "⚠️ 长时间无响应，可能网络卡顿或服务端排队中", "notice-interrupt");
          setCardStatus(i, "error", "⏱ 长时间无响应");
        }
      }, 70000);
    });

    es.addEventListener("model-token", (e) => {
      const data = JSON.parse(e.data);
      const idx = getCardIndex(data.model);
      if (idx >= 0) {
        modelStatus[data.model] = (modelStatus[data.model] || "") + data.token;
        addMessage(idx, modelStatus[data.model], true);
      }
      // 收到 token 即清除兜底计时器
      if (state.thinkingTimers && state.thinkingTimers[data.model]) { clearTimeout(state.thinkingTimers[data.model]); delete state.thinkingTimers[data.model]; }
    });

    es.addEventListener("model-retry", (e) => {
      const data = JSON.parse(e.data);
      const idx = getCardIndex(data.model);
      if (idx >= 0) {
        if (data.resetStream) {
          modelStatus[data.model] = '';
          addMessage(idx, '', true);
        }
        addStreamNotice(idx, "⚠️ 上游瞬时故障（" + data.reason + "），" + (data.delayMs / 1000) + "s 后自动重试", "notice-interrupt");
        setCardStatus(idx, "thinking", "自动重试中...");
      }
    });

    es.addEventListener("model-done", (e) => {
      const data = JSON.parse(e.data);
      if (state.thinkingTimers && state.thinkingTimers[data.model]) { clearTimeout(state.thinkingTimers[data.model]); delete state.thinkingTimers[data.model]; }
      const idx = getCardIndex(data.model);
      if (idx >= 0) {
        modelStatus[data.model] = data.fullText;
        addMessage(idx, data.fullText, false);
        setCardStatus(idx, "done", "\u2713 \u5b8c\u6210");
      }
    });

    es.addEventListener("model-error", (e) => {
      const data = JSON.parse(e.data);
      if (state.thinkingTimers && state.thinkingTimers[data.model]) { clearTimeout(state.thinkingTimers[data.model]); delete state.thinkingTimers[data.model]; }
      const idx = getCardIndex(data.model);
      if (idx >= 0) {
        if (data.partialText) { modelStatus[data.model] = data.partialText; addMessage(idx, data.partialText, false); }
        setCardStatus(idx, "error", "\u2717 " + data.error);
      }
    });

    es.addEventListener("model-interrupt", (e) => {
      const data = JSON.parse(e.data);
      if (state.thinkingTimers && state.thinkingTimers[data.model]) { clearTimeout(state.thinkingTimers[data.model]); delete state.thinkingTimers[data.model]; }
      const idx = getCardIndex(data.model);
      if (idx >= 0) { addStreamNotice(idx, "⚠️ " + data.reason, "notice-interrupt"); }
    });

    es.addEventListener("model-truncation", (e) => {
      const data = JSON.parse(e.data);
      const idx = getCardIndex(data.model);
      if (idx >= 0) { addStreamNotice(idx, "ℹ️ " + data.reason, "notice-truncation"); }
    });

    es.addEventListener("round-end", (e) => {
      const data = JSON.parse(e.data);
      const pct = (data.turn / data.totalTurns * 100);
      progressFill.style.width = pct + "%";
      progressText.textContent = "第 " + data.turn + "/" + data.totalTurns + " 步已完成";
    })

    es.addEventListener("judge-start", () => {
      progressText.textContent = "\u88c1\u5224\u8bc4\u5206\u4e2d...";
    });

    es.addEventListener("model-eval-start", () => {
      progressText.textContent = "\u6a21\u578b\u4e92\u8bc4\u4e2d...";
    });

    es.addEventListener("model-evaluation", (e) => {
      const data = JSON.parse(e.data);
      const idx = getCardIndex(data.model);
      if (idx >= 0) {
        const body = document.getElementById("body-" + idx);
        if (!body) return;
        var msg = body.querySelector(".model-message:last-child");
        if (!msg || !msg.dataset.streaming) {
          msg = document.createElement("div");
          msg.className = "model-message eval-msg";
          msg.dataset.streaming = "true";
          body.appendChild(msg);
        }
        msg.textContent = data.evaluation;
        delete msg.dataset.streaming;
        // 若含投票，追加高亮一行
        if (data.winRes) {
          var vr = document.createElement("div");
          vr.className = "winres-line";
          vr.textContent = "win_res：" + data.winRes;
          body.appendChild(vr);
        }
        body.scrollTop = body.scrollHeight;
      }
    });

    es.addEventListener("debate-end", (e) => {
      const data = JSON.parse(e.data);
      resetUI();
      progressFill.style.width = "100%";
      progressText.textContent = "\u8fa9\u8bba\u7ed3\u675f!";
      showResults(data);
      es.close();
      state.eventSource = null;
    })
  }

  function showResults(data) {
    var html = '';
    if (data.recordError) html += '<div class="judge-text">' + escapeHtml(data.recordError) + '，请检查服务日志。</div>';
    if (data.aborted) html += '<div class="judge-text">辩论中断：' + escapeHtml(data.errorMessage || '未知错误') + '</div>';
    var judgeText = data.judgeText || '';
    var evaluations = data.evaluations || [];
    if (!data.aborted && state.debugModels && evaluations.length === state.debugModels.length) {
      const order = state.debugModels.map(model => model.name);
      const votesByModel = Object.fromEntries(order.map(name => [name, 0]));
      for (const evaluation of evaluations) {
        const raw = evaluation.winRes || '';
        const name = /^参与者[A-Z]$/.test(raw) ? order[raw.charCodeAt(3) - 65] : raw;
        if (Object.hasOwn(votesByModel, name)) votesByModel[name]++;
      }
      html += runOrderResultsHtml({ speakerOrder: order, votes: votesByModel });
    }
    if (judgeText) html += '<div class="judge-text">' + escapeHtml(judgeText) + "</div>";
    if (evaluations && evaluations.length > 0) {
      // 汇总模型互评投票
      var votes = {};
      for (var v = 0; v < evaluations.length; v++) {
        var wr = evaluations[v].winRes || "";
        if (wr) votes[wr] = (votes[wr] || 0) + 1;
      }
      var voteList = Object.keys(votes);
      if (voteList.length > 0) {
        voteList.sort(function (a, b) { return votes[b] - votes[a]; });
        html += '<div class="vote-tally"><div class="vote-tally-title">🗳️ 模型互评投票汇总</div>';
        for (var k = 0; k < voteList.length; k++) {
          var cand = voteList[k];
          html += '<div class="vote-row"><span class="vote-cand">' + escapeHtml(cand) + '</span><span class="vote-count">' + votes[cand] + ' 票</span></div>';
        }
        html += '</div>';
      }
      html += '<div class="eval-section"><div class="eval-title">🤝 模型互评</div>';
      for (var i = 0; i < evaluations.length; i++) {
        var ev = evaluations[i];
        // 把 win_res 行从评价正文里分离出来单独高亮
        var full = ev.evaluation || '';
        var winRes = ev.winRes || '';
        var m = full.match(/(?:^|\n)\*{0,2}\s*win_res[:：][^\n\r]*/i);
        var body = m ? full.replace(m[0], '').replace(/\n+$/, '') : full;
        html += '<div class="eval-card"><div class="eval-name">' + escapeHtml(ev.model);
        if (winRes) html += ' <span class="vote-badge">投：' + escapeHtml(winRes) + '</span>';
        html += '</div><div class="eval-text">' + escapeHtml(body) + '</div>';
        if (m) html += '<div class="winres-line">win_res：' + escapeHtml(winRes) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }
    judgePanel.innerHTML = html;
    judgePanel.style.display = html ? "block" : "none";
  }
  function resetUI() {
    state.isRunning = false;
    updateConfigSummary();
    startBtn.textContent = "\u26a1 \u5f00\u59cb\u8fa9\u8bba";
  }

  return { startDebate };
}
