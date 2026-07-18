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
    vllmUrl: "http://localhost:8000/v1",
    deepseekApiKey: "",
    deepseekModels: [],
    rounds: 3,
    temperature: 0.7,
    maxTokens: 2048,
    models: [],
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
const vllmUrlInput = q("#vllmUrl");
const testConnBtn = q("#testConnBtn");
const connStatus = q("#connStatus");
const modelList = q("#modelList");
const deepseekApiKeyInput = q("#deepseekApiKey");
const testDSBtn = q("#testDSBtn");
const dsStatus = q("#dsStatus");
const roundsInput = q("#roundsInput");
const temperatureInput = q("#temperatureInput");
const maxTokensInput = q("#maxTokensInput");
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

saveSettingsBtn.onclick = () => {
  state.config.rounds = parseInt(roundsInput.value) || 3;
  state.config.temperature = parseFloat(temperatureInput.value) || 0.7;
  state.config.maxTokens = parseInt(maxTokensInput.value) || 2048;
  state.config.selectedModels = [...document.querySelectorAll(".model-item input:checked")].map(cb => ({
    id: cb.dataset.modelId,
    name: cb.dataset.modelName,
    provider: cb.dataset.provider || "vllm",
    apiKey: cb.dataset.provider === "deepseek" ? state.config.deepseekApiKey : "",
  }));
  state.config.deepseekApiKey = deepseekApiKeyInput.value.trim();
  state.config.vllmUrl = vllmUrlInput.value;
  updateConfigSummary();
  settingsModal.classList.remove("active");
};

function updateConfigSummary() {
  const n = state.config.selectedModels.length;
  modelCountText.textContent = n > 0 ? "\u5df2\u9009\u62e9 " + n + " \u4e2a\u6a21\u578b" : "\u5df2\u9009\u62e9 0 \u4e2a\u6a21\u578b";
  roundCountText.textContent = state.config.rounds + " \u8f6e\u8fa9\u8bba";
  startBtn.disabled = n < 2 || state.isRunning;
}

testConnBtn.onclick = async () => {
  const url = vllmUrlInput.value.trim();
  if (!url) return;
  connStatus.textContent = "\u6b63\u5728\u8fde\u63a5...";
  connStatus.className = "conn-status";
  testConnBtn.disabled = true;
  try {
    const resp = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: url })
    });
    const data = await resp.json();
    if (data.success) {
      connStatus.textContent = "\u2713 \u8fde\u63a5\u6210\u529f! \u68c0\u6d4b\u5230 " + data.models.length + " \u4e2a\u6a21\u578b";
      connStatus.className = "conn-status conn-success";
      state.config.models = data.models;
      renderModelList();
    } else {
      connStatus.textContent = "\u2717 " + data.error;
      connStatus.className = "conn-status conn-error";
    }
  } catch (err) {
    connStatus.textContent = "\u2717 " + err.message;
    connStatus.className = "conn-status conn-error";
  }
  testConnBtn.disabled = false;
};

function renderModelList() {
  const vllmModels = state.config.models.map(m => ({ ...m, provider: "vllm" }));
  const dsModels = state.config.deepseekModels.map(m => ({ ...m, provider: "deepseek" }));
  const allModels = [...vllmModels, ...dsModels];
  modelList.innerHTML = allModels.map((m, i) => {
    const checked = state.config.selectedModels.some(s => s.id === m.id && s.provider === m.provider) ? "checked" : "";
    const color = COLORS[i % COLORS.length];
    const badge = m.provider === "deepseek" ? '<span class="provider-badge ds">DeepSeek</span>' : '<span class="provider-badge vllm">vLLM</span>';
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
        models: models.map(m => ({ id: m.id, name: m.name, provider: m.provider, apiKey: m.provider === "deepseek" ? state.config.deepseekApiKey : "" })),
        rounds: state.config.rounds,
        vllmBaseUrl: state.config.vllmUrl,
        temperature: state.config.temperature,
        maxTokens: state.config.maxTokens,
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
    const bdg = m.provider === "deepseek" ? '<span class="provider-badge ds" style="font-size:10px">DeepSeek</span>' : '<span class="provider-badge vllm" style="font-size:10px">vLLM</span>';
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

function addRoundLabel(cardIndex, round, phase) {
  const body = document.getElementById("body-" + cardIndex);
  if (!body) return;
  const div = document.createElement("div");
  div.className = "round-label";
  div.textContent = "\u7b2c " + round + " \u8f6e \u00b7 " + phase;
  body.appendChild(div);
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
    const pct = ((data.round - 1) / state.config.rounds * 100);
    progressFill.style.width = pct + "%";
    progressText.textContent = "\u7b2c " + data.round + "/" + state.config.rounds + " \u8f6e \u00b7 " + data.phase;
    models.forEach((m, i) => { addRoundLabel(i, data.round, data.phase); });
  });

  es.addEventListener("model-start", (e) => {
    const data = JSON.parse(e.data);
    const idx = getCardIndex(data.model);
    if (idx >= 0) { setCardStatus(idx, "thinking", "\u601d\u8003\u4e2d..."); modelStatus[data.model] = ""; }
  });

  es.addEventListener("model-token", (e) => {
    const data = JSON.parse(e.data);
    const idx = getCardIndex(data.model);
    if (idx >= 0) {
      modelStatus[data.model] = (modelStatus[data.model] || "") + data.token;
      addMessage(idx, modelStatus[data.model], true);
    }
  });

  es.addEventListener("model-done", (e) => {
    const data = JSON.parse(e.data);
    const idx = getCardIndex(data.model);
    if (idx >= 0) {
      modelStatus[data.model] = data.fullText;
      addMessage(idx, data.fullText, false);
      setCardStatus(idx, "done", "\u2713 \u5b8c\u6210");
    }
  });

  es.addEventListener("model-error", (e) => {
    const data = JSON.parse(e.data);
    const idx = getCardIndex(data.model);
    if (idx >= 0) { setCardStatus(idx, "error", "\u2717 " + data.error); }
  });

  es.addEventListener("round-end", (e) => {
    const data = JSON.parse(e.data);
    const pct = (data.round / state.config.rounds * 100);
    progressFill.style.width = pct + "%";
    progressText.textContent = "\u7b2c " + data.round + "/" + state.config.rounds + " \u8f6e \u5df2\u5b8c\u6210";
  });

  es.addEventListener("judge-start", () => {
    progressText.textContent = "\u88c1\u5224\u8bc4\u5206\u4e2d...";
  });

  es.addEventListener("debate-end", (e) => {
    const data = JSON.parse(e.data);
    progressFill.style.width = "100%";
    progressText.textContent = "\u8fa9\u8bba\u7ed3\u675f!";
    showResults(data);
    es.close();
    state.eventSource = null;
    resetUI();
  });

  es.onerror = () => { resetUI(); };
}

function showResults(data) {
  judgePanel.style.display = "block";
  const { scores, winner, judgeText } = data;
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let html = '<div class="judge-title">🏆 \u8fa9\u8bba\u7ed3\u679c</div><div class="judge-scores">';
  sorted.forEach(([name, score], i) => {
    const isWinner = name === winner;
    const color = COLORS[state.config.selectedModels.findIndex(m => m.name === name) % COLORS.length];
    html += '<div class="score-card">' +
      '<div class="score-rank">' + (isWinner ? "🏆" : "#" + (i + 1)) + "</div>" +
      '<div class="score-name" style="color:' + (color ? color.bg : "#e2e8f0") + '">' + name + (isWinner ? ' <span class="winner-badge">\u51a0\u519b</span>' : "") + "</div>" +
      '<div class="score-value" style="color:' + (color ? color.bg : "#e2e8f0") + '">' + score.toFixed(1) + "</div>" +
    "</div>";
  });
  html += "</div>";
  if (judgeText) html += '<div class="judge-text">' + escapeHtml(judgeText) + "</div>";
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
(async () => {
  try {
    const resp = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: state.config.vllmUrl })
    });
    const data = await resp.json();
    if (data.success) { state.config.models = data.models; renderModelList(); }
  } catch {}
})();


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
