import { state, COLORS } from '../core/state.js';
import { escapeHtml, startBtn, settingsBtn, settingsModal, closeSettings, modelList, deepseekApiKeyInput, testDSBtn, dsStatus, roundsInput, temperatureInput, maxTokensInput, anonymousToggle, anonymousHint, glmApiKeyInput, testGLMBtn, glmStatus, opencodeApiKeyInput, testOpenCodeBtn, opencodeStatus, batchTestOpenCodeBtn, opencodeBatchResults, saveSettingsBtn, modelCountText, roundCountText, startExperimentBtn } from '../core/dom.js';
import { fetchJSON } from '../core/api.js';
import { preserveModelOrder } from '../answer-order.js';

export function createSettingsUI({ updateExperimentEstimate, renderAnswerOrderEditors }) {
  function syncAnonymousHint() {
    anonymousHint.textContent = anonymousToggle.checked
      ? "开启后模型不知道对手身份（盲辩）"
      : "关闭后各模型可见真实身份（实名辩论）";
  }
  anonymousToggle.onchange = () => { state.config.anonymous = anonymousToggle.checked; syncAnonymousHint(); updateConfigSummary(); };
  syncAnonymousHint();

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
      const { data } = await fetchJSON("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "deepseek", apiKey: key })
      });
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
      const { data } = await fetchJSON("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "glm", apiKey: key })
      });
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
      const { data } = await fetchJSON("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "opencode", apiKey: key })
      });
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
        const { data: d } = await fetchJSON("/api/test-connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "opencode", apiKey: key })
        });
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
        const { data } = await fetchJSON("/api/test-model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "opencode", apiKey: key, modelId: m.id })
        });
        if (data.success) {
          okCount++;
          item.className = "batch-item batch-ok";
          item.innerHTML = '<span class="batch-icon">✅</span><span class="batch-name">' + m.id + '</span><span class="batch-msg">' + (data.reply ? '"' + data.reply + '"' : "OK") + "</span>";
        } else {
          failCount++;
          item.className = "batch-item batch-fail";
          const message = data.deprecated ? `已停用，请选择 ${data.replacement} 并重新保存模型配置` : (data.error || '失败');
          if (data.deprecated) {
            m.deprecated = true;
            m.replacement = data.replacement;
            for (const checkbox of document.querySelectorAll('.model-item input')) {
              if (checkbox.dataset.provider === 'opencode' && checkbox.dataset.modelId === m.id) {
                checkbox.checked = false;
                checkbox.disabled = true;
                checkbox.closest('.model-item').querySelector('.model-id').textContent = `${m.id}（已停用，请选择 ${data.replacement}）`;
              }
            }
          }
          item.innerHTML = '<span class="batch-icon">❌</span><span class="batch-name">' + escapeHtml(m.id) + '</span><span class="batch-msg">' + escapeHtml(message) + '</span>';
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
    state.config.temperature = Number.isFinite(parseFloat(temperatureInput.value)) ? parseFloat(temperatureInput.value) : 0.7;
    state.config.maxTokens = parseInt(maxTokensInput.value) || 2048;
    state.config.anonymous = anonymousToggle.checked;
    state.config.deepseekApiKey = deepseekApiKeyInput.value.trim();
    state.config.glmApiKey = glmApiKeyInput.value.trim();
    state.config.opencodeApiKey = opencodeApiKeyInput.value.trim();
    const selected = [...document.querySelectorAll(".model-item input:checked:not(:disabled)")].map(cb => ({
      id: cb.dataset.modelId,
      name: cb.dataset.modelName,
      provider: cb.dataset.provider,
      apiKey: cb.dataset.provider === "deepseek" ? state.config.deepseekApiKey : "",
    }));
    state.config.selectedModels = preserveModelOrder(state.config.selectedModels, selected);
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
    startBtn.disabled = n < 2 || state.isRunning || state.isExperimentRunning;
    startExperimentBtn.disabled = n < 2 || n > 4 || state.isRunning || state.isExperimentRunning;
    updateExperimentEstimate();
    renderAnswerOrderEditors();
  }

  function renderModelList() {
    const dsModels = state.config.deepseekModels.map(m => ({ ...m, provider: "deepseek" }));
    const glmModels = state.config.glmModels.map(m => ({ ...m, provider: "glm" }));
    const opencodeModels = state.config.opencodeModels.map(m => ({ ...m, provider: "opencode" }));
    const allModels = [...dsModels, ...glmModels, ...opencodeModels];
    modelList.innerHTML = allModels.map((m, i) => {
      const checked = !m.deprecated && state.config.selectedModels.some(s => s.id === m.id && s.provider === m.provider) ? "checked" : "";
      const color = COLORS[i % COLORS.length];
      let badge = "";
      if (m.provider === "deepseek") badge = '<span class="provider-badge ds">DeepSeek</span>';
      if (m.provider === "glm") badge = '<span class="provider-badge glm">GLM</span>';
      if (m.provider === "opencode") badge = '<span class="provider-badge opencode">OpenCode</span>';
      return "<div class=\"model-item\">" +
        '<input type="checkbox" id="m-' + i + '" data-model-id="' + m.id + '" data-model-name="' + m.name + '" data-provider="' + m.provider + '" ' + checked + (m.deprecated ? ' disabled' : '') + '>' +
        "<label for=\"m-" + i + '">' +
          '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + color.bg + ';margin-right:6px"></span> ' +
          m.name + " " + badge +
        "</label>" +
        '<span class="model-id">' + escapeHtml(m.id) + (m.deprecated ? '（已停用，请选择 ' + escapeHtml(m.replacement) + '）' : '') + '</span>' +
      "</div>";
    }).join("");
  }

  return { updateConfigSummary, renderModelList };
}
