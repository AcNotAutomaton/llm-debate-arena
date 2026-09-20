const COLORS = [
  { bg: "#4f46e5", name: "Indigo" },
  { bg: "#059669", name: "Emerald" },
  { bg: "#dc2626", name: "Red" },
  { bg: "#d97706", name: "Amber" },
  { bg: "#7c3aed", name: "Violet" },
  { bg: "#0891b2", name: "Cyan" },
  { bg: "#db2777", name: "Pink" },
  { bg: "#65a30d", name: "Lime" },
];

const state = {
  config: {
    deepseekApiKey: "",
    deepseekModels: [],
    glmApiKey: "",
    glmModels: [],
    opencodeApiKey: "",
    opencodeModels: [],
    rounds: 3,
    temperature: 0.7,
    maxTokens: 2048,
    anonymous: true,
    selectedModels: [],
  },
  debateId: null,
  eventSource: null,
  isRunning: false,
};

const q = (sel) => document.querySelector(sel);

const questionInput = q("#questionInput");
const startBtn = q("#startBtn");
const settingsBtn = q("#settingsBtn");
const settingsModal = q("#settingsModal");
const closeSettings = q("#closeSettings");
const modelList = q("#modelList");
const deepseekApiKeyInput = q("#deepseekApiKey");
const testDSBtn = q("#testDSBtn");
const dsStatus = q("#dsStatus");
const roundsInput = q("#roundsInput");
const temperatureInput = q("#temperatureInput");
const maxTokensInput = q("#maxTokensInput");
const anonymousToggle = q("#anonymousToggle");
const anonymousHint = q("#anonymousHint");
function syncAnonymousHint() {
  anonymousHint.textContent = anonymousToggle.checked
    ? "开启后模型不知道对手身份（盲辩）"
    : "关闭后各模型可见真实身份（实名辩论）";
}
anonymousToggle.onchange = () => { state.config.anonymous = anonymousToggle.checked; syncAnonymousHint(); updateConfigSummary(); };
syncAnonymousHint();
const glmApiKeyInput = q("#glmApiKey");
const testGLMBtn = q("#testGLMBtn");
const glmStatus = q("#glmStatus");
const opencodeApiKeyInput = q("#opencodeApiKey");
const testOpenCodeBtn = q("#testOpenCodeBtn");
const opencodeStatus = q("#opencodeStatus");
const batchTestOpenCodeBtn = q("#batchTestOpenCodeBtn");
const opencodeBatchResults = q("#opencodeBatchResults");
const saveSettingsBtn = q("#saveSettingsBtn");
const arena = q("#arena");
const judgePanel = q("#judgePanel");
const progressBar = q("#progressBar");
const progressFill = q("#progressFill");
const progressText = q("#progressText");
const modelCountText = q("#modelCountText");
const roundCountText = q("#roundCountText");
const themeToggle = q("#themeToggle");

settingsBtn.onclick = () => settingsModal.classList.add("active");
closeSettings.onclick = () => settingsModal.classList.remove("active");
settingsModal.onclick = (e) => { if (e.target === settingsModal) settingsModal.classList.remove("active"); };

testDSBtn.onclick = async () => {
  const key = deepseekApiKeyInput.value.trim();
  if (!key) return;
  dsStatus.textContent = "\u6b63\u5728\u8fde\u63a5...";
  dsStatus.className = "conn-status";
  testDSBtn.disabled = true;
  try {
    const resp = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", apiKey: key })
    });
    const data = await resp.json();
    if (data.success) {
      dsStatus.textContent = "\u2713 \u8fde\u63a5\u6210\u529f! \u68c0\u6d4b\u5230 " + data.models.length + " \u4e2a\u6a21\u578b";
      dsStatus.className = "conn-status conn-success";
      state.config.deepseekModels = data.models;
      renderModelList();
    } else {
      dsStatus.textContent = "\u2717 " + data.error;
      dsStatus.className = "conn-status conn-error";
    }
  } catch (err) {
    dsStatus.textContent = "\u2717 " + err.message;
    dsStatus.className = "conn-status conn-error";
  }
  testDSBtn.disabled = false;
};

testGLMBtn.onclick = async () => {
  const key = glmApiKeyInput.value.trim();
  if (!key) return;
  glmStatus.textContent = "正在连接...";
  glmStatus.className = "conn-status";
  testGLMBtn.disabled = true;
  try {
    const resp = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "glm", apiKey: key })
    });
    const data = await resp.json();
    if (data.success) {
      glmStatus.textContent = "✓ 连接成功! 检测到 " + data.models.length + " 个模型";
      glmStatus.className = "conn-status conn-success";
      state.config.glmModels = data.models;
      renderModelList();
    } else {
      glmStatus.textContent = "✗ " + data.error;
      glmStatus.className = "conn-status conn-error";
    }
  } catch (err) {
    glmStatus.textContent = "✗ " + err.message;
    glmStatus.className = "conn-status conn-error";
  }
  testGLMBtn.disabled = false;
};

testOpenCodeBtn.onclick = async () => {
  const key = opencodeApiKeyInput.value.trim();
  if (!key) {
    opencodeStatus.textContent = "✗ 请先填写 OpenCode API 密钥";
    opencodeStatus.className = "conn-status conn-error";
    opencodeApiKeyInput.focus();
    return;
  }
  opencodeStatus.textContent = "正在连接...";
  opencodeStatus.className = "conn-status";
  testOpenCodeBtn.disabled = true;
  try {
    const resp = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "opencode", apiKey: key })
    });
    const data = await resp.json();
    if (data.success) {
      opencodeStatus.textContent = "✓ 连接成功! 检测到 " + data.models.length + " 个模型";
      opencodeStatus.className = "conn-status conn-success";
      state.config.opencodeModels = data.models;
      renderModelList();
    } else {
      opencodeStatus.textContent = "✗ " + data.error;
      opencodeStatus.className = "conn-status conn-error";
    }
  } catch (err) {
    opencodeStatus.textContent = "✗ " + err.message;
    opencodeStatus.className = "conn-status conn-error";
  }
  testOpenCodeBtn.disabled = false;
};

batchTestOpenCodeBtn.onclick = async () => {
  const key = opencodeApiKeyInput.value.trim();
  if (!key) {
    opencodeStatus.textContent = "✗ 请先填写 OpenCode API 密钥";
    opencodeStatus.className = "conn-status conn-error";
    opencodeApiKeyInput.focus();
    return;
  }
  // 如果没有拉过模型列表，先拉一次
  if (!state.config.opencodeModels || state.config.opencodeModels.length === 0) {
    opencodeStatus.textContent = "先获取模型列表...";
    opencodeStatus.className = "conn-status";
    try {
      const r = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "opencode", apiKey: key })
      });
      const d = await r.json();
      if (!d.success) { opencodeStatus.textContent = "✗ " + d.error; opencodeStatus.className = "conn-status conn-error"; return; }
      state.config.opencodeModels = d.models;
      renderModelList();
    } catch (err) {
      opencodeStatus.textContent = "✗ " + err.message;
      opencodeStatus.className = "conn-status conn-error";
      return;
    }
  }
  const models = state.config.opencodeModels;
  batchTestOpenCodeBtn.disabled = true;
  batchTestOpenCodeBtn.textContent = "🧪 测试中...";
  opencodeBatchResults.innerHTML = "";
  opencodeStatus.textContent = "批量测试中，共 " + models.length + " 个模型...";
  opencodeStatus.className = "conn-status";
  let okCount = 0, failCount = 0;
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const item = document.createElement("div");
    item.className = "batch-item batch-testing";
    item.innerHTML = '<span class="batch-icon">⏳</span><span class="batch-name">' + m.id + "</span><span class='batch-msg'>测试中...</span>";
    opencodeBatchResults.appendChild(item);
    opencodeBatchResults.scrollTop = opencodeBatchResults.scrollHeight;
    try {
      const resp = await fetch("/api/test-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "opencode", apiKey: key, modelId: m.id })
      });
      const data = await resp.json();
      if (data.success) {
        okCount++;
        item.className = "batch-item batch-ok";
        item.innerHTML = '<span class="batch-icon">✅</span><span class="batch-name">' + m.id + '</span><span class="batch-msg">' + (data.reply ? '"' + data.reply + '"' : "OK") + "</span>";
      } else {
        failCount++;
        item.className = "batch-item batch-fail";
        item.innerHTML = '<span class="batch-icon">❌</span><span class="batch-name">' + m.id + '</span><span class="batch-msg">' + (data.error || "失败") + "</span>";
      }
    } catch (err) {
      failCount++;
      item.className = "batch-item batch-fail";
      item.innerHTML = '<span class="batch-icon">❌</span><span class="batch-name">' + m.id + '</span><span class="batch-msg">' + err.message + "</span>";
    }
    opencodeStatus.textContent = "批量测试中... " + (i + 1) + "/" + models.length + "（可用 " + okCount + "，不可用 " + failCount + "）";
  }
  opencodeStatus.textContent = "✅ 批量测试完成：共 " + models.length + " 个模型，可用 " + okCount + "，不可用 " + failCount;
  opencodeStatus.className = failCount === 0 ? "conn-status conn-success" : (okCount === 0 ? "conn-status conn-error" : "conn-status");
  batchTestOpenCodeBtn.disabled = false;
  batchTestOpenCodeBtn.textContent = "🧪 批量测试所有模型可用性";
};

saveSettingsBtn.onclick = () => {
  state.config.rounds = parseInt(roundsInput.value) || 3;
  state.config.temperature = parseFloat(temperatureInput.value) || 0.7;
  state.config.maxTokens = parseInt(maxTokensInput.value) || 2048;
  state.config.anonymous = anonymousToggle.checked;
  state.config.deepseekApiKey = deepseekApiKeyInput.value.trim();
  state.config.glmApiKey = glmApiKeyInput.value.trim();
  state.config.opencodeApiKey = opencodeApiKeyInput.value.trim();
  state.config.selectedModels = [...document.querySelectorAll(".model-item input:checked")].map(cb => ({
    id: cb.dataset.modelId,
    name: cb.dataset.modelName,
    provider: cb.dataset.provider,
    apiKey: cb.dataset.provider === "deepseek" ? state.config.deepseekApiKey : "",
  }));
  state.config.selectedModels.forEach(m => {
    if (m.provider === "glm") m.apiKey = state.config.glmApiKey;
    else if (m.provider === "opencode") m.apiKey = state.config.opencodeApiKey;
  });
  updateConfigSummary();
  settingsModal.classList.remove("active");
};

function updateConfigSummary() {
  const n = state.config.selectedModels.length;
  modelCountText.textContent = n > 0 ? "\u5df2\u9009\u62e9 " + n + " \u4e2a\u6a21\u578b" : "\u5df2\u9009\u62e9 0 \u4e2a\u6a21\u578b";
  roundCountText.textContent = state.config.rounds + " \u8f6e\u8fa9\u8bba" + (state.config.anonymous ? " · 匿名" : " · 实名");
  startBtn.disabled = n < 2 || state.isRunning;
}

function renderModelList() {
  const dsModels = state.config.deepseekModels.map(m => ({ ...m, provider: "deepseek" }));
  const glmModels = state.config.glmModels.map(m => ({ ...m, provider: "glm" }));
  const opencodeModels = state.config.opencodeModels.map(m => ({ ...m, provider: "opencode" }));
  const allModels = [...dsModels, ...glmModels, ...opencodeModels];
  modelList.innerHTML = allModels.map((m, i) => {
    const checked = state.config.selectedModels.some(s => s.id === m.id && s.provider === m.provider) ? "checked" : "";
    const color = COLORS[i % COLORS.length];
    let badge = "";
    if (m.provider === "deepseek") badge = '<span class="provider-badge ds">DeepSeek</span>';
    if (m.provider === "glm") badge = '<span class="provider-badge glm">GLM</span>';
    if (m.provider === "opencode") badge = '<span class="provider-badge opencode">OpenCode</span>';
    return "<div class=\"model-item\">" +
      '<input type="checkbox" id="m-' + i + '" data-model-id="' + m.id + '" data-model-name="' + m.name + '" data-provider="' + m.provider + '" ' + checked + '">' +
      "<label for=\"m-" + i + '">' +
        '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + color.bg + ';margin-right:6px"></span> ' +
        m.name + " " + badge +
      "</label>" +
      '<span class="model-id">' + m.id + "</span>" +
    "</div>";
  }).join("");
}

startBtn.onclick = startDebate;

async function startDebate() {
  const question = questionInput.value.trim();
  if (!question) { questionInput.focus(); return; }
  const models = state.config.selectedModels;
  if (models.length < 2) { alert("\u8bf7\u81f3\u5c11\u9009\u62e92\u4e2a\u6a21\u578b"); return; }

  state.isRunning = true;
  startBtn.disabled = true;
  startBtn.textContent = "\u23f3 \u8fa9\u8bba\u8fdb\u884c\u4e2d...";
  arena.innerHTML = "";
  judgePanel.style.display = "none";
  progressBar.style.display = "block";
  progressFill.style.width = "0%";
  progressText.textContent = "";

  initArena(models);

  try {
    const resp = await fetch("/api/debate", {
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
    const data = await resp.json();
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
  return state.config.selectedModels.findIndex(m => m.name === modelName);
}

function addRoundLabel(cardIndex, turn, model) {
  const body = document.getElementById("body-" + cardIndex);
  if (!body) return;
  const div = document.createElement("div");
  div.className = "round-label";
  div.textContent = "\u7b2c " + round + " \u8f6e \u00b7 " + phase;
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
  const es = new EventSource("/api/debate/" + debateId + "/stream");
  state.eventSource = es;
  const modelStatus = {};

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
    if (idx >= 0) { setCardStatus(idx, "error", "\u2717 " + data.error); }
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
  var judgeText = data.judgeText || '';
  var evaluations = data.evaluations || [];
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
}

function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

function resetUI() {
  state.isRunning = false;
  startBtn.disabled = !(state.config.selectedModels.length >= 2);
  startBtn.textContent = "\u26a1 \u5f00\u59cb\u8fa9\u8bba";
}

updateConfigSummary();


// Theme toggle
const savedTheme = localStorage.getItem("theme") || "dark";
document.documentElement.setAttribute("data-theme", savedTheme);
themeToggle.textContent = savedTheme === "dark" ? "🌙" : "☀️";

themeToggle.onclick = () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  themeToggle.textContent = next === "dark" ? "🌙" : "☀️";
};
