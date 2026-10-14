const { DEEPSEEK_BASE_URL, GLM_BASE_URL, OPENCODE_BASE_URL } = require('../config.cjs');
const providerProtocol = require('../protocols/provider-protocol.cjs');
const { parseProviderResponse, fetchWithHandshakeTimeout } = require('./http.cjs');
const { createStreamReader } = require('./stream-reader.cjs');
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const MODEL_FETCH_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2000;

function createModelClient({ emit, captureModelToken }) {
  const { readStream } = createStreamReader({ emit, captureModelToken });
  async function delayModelRetry(attempt, debateId, modelName, round, reason, resetStream = false) {
    const delayMs = RETRY_BASE_DELAY_MS * (attempt + 1);
    emit(debateId, 'model-retry', {
      model: modelName, round,
      nextAttempt: attempt + 2, delayMs,
      reason: String(reason || '').slice(0, 160), resetStream
    });
    await new Promise(r => setTimeout(r, delayMs));
  }

  // 模型调用统一的重试封装：非瞬时错误直接放行/上抛；
  // 重试耗尽后把最后一次响应原样交还调用方，保留原有错误信息格式。
  async function fetchWithRetry(url, options, debateId, modelName, round, retryState = { used: 0 }) {
    for (;;) {
      let resp;
      try {
        resp = await fetchWithHandshakeTimeout(url, options);
      } catch (err) {
        // 握手超时默认 120s，再等一轮代价太高，直接上抛。
        const msg = (err && err.message) || '';
        if (retryState.used >= MODEL_FETCH_RETRIES || msg.includes('未收到响应') || msg.includes('handshake-timeout')) throw err;
        await delayModelRetry(retryState.used++, debateId, modelName, round, msg);
        continue;
      }
      if (!RETRYABLE_STATUS.has(resp.status) || retryState.used >= MODEL_FETCH_RETRIES) return resp;
      const status = resp.status;
      const snippet = (await resp.text().catch(() => '')).slice(0, 160);
      await delayModelRetry(retryState.used++, debateId, modelName, round, `HTTP ${status} ${snippet}`);
    }
  }
  // 握手/HTTP 错误和流断线共用同一个重试预算，避免嵌套重试。
  async function requestModelText(request, debateId, modelName, round, errorLabel) {
    const retryState = { used: 0 };
    for (;;) {
      const resp = await fetchWithRetry(request.url, request.options, debateId, modelName, round, retryState);
      if (!resp.ok) {
        if (errorLabel) throw new Error(`${errorLabel} 错误 (${resp.status}): ${await resp.text().catch(() => '')}`);
        await parseProviderResponse(resp);
      }
      try {
        const result = await readStream(resp, debateId, modelName, round, request.protocol === 'anthropic', request.protocol === 'responses');
        // 互评的预算截断与网络断线不同：上层可提高预算重新评选，不能采用残缺投票。
        if ((round === 'eval' || round === 'eval-retry') && result.truncatedByToken) {
          const error = new Error('互评已达输出 Token 上限');
          error.evaluationTruncated = true;
          error.partialText = annotateStreamResult(debateId, modelName, round, result);
          throw error;
        }
        if (!result.text.trim()) {
          const error = new Error('模型返回空正文，请检查输出 token 预算或上游模型状态');
          error.code = 'EMPTY_MODEL_TEXT';
          throw error;
        }
        return annotateStreamResult(debateId, modelName, round, result);
      } catch (error) {
        if (!error.retryableStream || retryState.used >= MODEL_FETCH_RETRIES) throw error;
        await delayModelRetry(retryState.used++, debateId, modelName, round, `连接中断且尚无正文：${error.message}`, true);
      }
    }
  }

  // 把 readStream 的诊断结果通过 SSE 反馈给前端，并追加到返回文本末尾作为标记
  function annotateStreamResult(debateId, modelName, round, r) {
    if (r.interrupted) {
      emit(debateId, 'model-interrupt', { model: modelName, round, reason: r.interruptedReason });
      return r.text + `\n\n*[⚠️ 输出中断：${r.interruptedReason}]*`;
    }
    if (!r.doneSeen && r.text) {
      emit(debateId, 'model-interrupt', { model: modelName, round, reason: '流未收到结束标记 [DONE]，可能被服务端提前断开' });
      return r.text + `\n\n*[⚠️ 输出可能被服务端提前截断（未收到 [DONE]）]*`;
    }
    if (r.truncatedByToken) {
      emit(debateId, 'model-truncation', { model: modelName, round, reason: '已达 max_tokens 上限被截断' });
      return r.text + `\n\n*[ℹ️ 已达 max_tokens 上限，输出被截断]*`;
    }
    return r.text;
  }
  async function callDeepSeek(baseUrl, apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round) {
    const url = `${(baseUrl || DEEPSEEK_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    return requestModelText({ url, options: { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages, temperature, max_tokens: maxTokens, stream: true }) }, protocol: 'chat' }, debateId, modelName, round, 'DeepSeek');
  }

  async function callGLM(baseUrl, apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round) {
    const url = `${(baseUrl || GLM_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    return requestModelText({ url, options: { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages, temperature, max_tokens: maxTokens, stream: true }) }, protocol: 'chat' }, debateId, modelName, round, 'GLM');
  }

  // OpenCode 必需头：每个对话一个稳定会话 ID，用于路由优化与 prompt 缓存；
  // 缺失时服务端返回 400 MissingSessionID 拒绝路由
  function opencodeSession(parts) {
    return 'llm-debate-arena/' + parts
      .map(p => String(p == null ? '' : p).replace(/[^A-Za-z0-9._-]+/g, '_'))
      .join('/');
  }

  function getModelCallConfig(model) {
    const provider = model.provider;
    if (provider === 'deepseek') {
      return { provider: 'deepseek', baseUrl: model.baseUrl || DEEPSEEK_BASE_URL, apiKey: model.apiKey || process.env.DEEPSEEK_API_KEY || '' };
    }
    if (provider === 'glm') {
      return { provider: 'glm', baseUrl: model.baseUrl || GLM_BASE_URL, apiKey: model.apiKey || process.env.GLM_API_KEY || '' };
    }
    if (provider === 'opencode') {
      // OpenCode 在调用时按模型选择 Anthropic、Chat Completions 或 Responses 协议。
      return { provider: 'opencode', baseUrl: model.baseUrl || OPENCODE_BASE_URL, apiKey: model.apiKey || '' };
    }
    throw new Error(`不支持的模型 Provider: ${provider || '未指定'}`);
  }

  async function callModel(config, modelId, messages, temperature, maxTokens, debateId, modelName, round) {
    if (config.provider === 'deepseek') {
      return callDeepSeek(config.baseUrl, config.apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round);
    }
    if (config.provider === 'glm') {
      return callGLM(config.baseUrl, config.apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round);
    }
    if (config.provider === 'opencode') {
      const request = providerProtocol.requestFor(config.provider, config.baseUrl, config.apiKey, modelId, messages, temperature, maxTokens, true, opencodeSession([debateId, modelName || modelId]));
      return requestModelText(request, debateId, modelName, round);
    }
    throw new Error(`不支持的模型 Provider: ${config.provider || '未指定'}`);
  }

  return { callModel, getModelCallConfig, opencodeSession };
}

module.exports = { createModelClient };
