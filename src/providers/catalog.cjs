const crypto = require('node:crypto');
const { DEEPSEEK_BASE_URL, GLM_BASE_URL, OPENCODE_BASE_URL } = require('../config.cjs');
const providerProtocol = require('../protocols/provider-protocol.cjs');
const { isReasoningModel } = require('./token-budget.cjs');
const { parseProviderResponse, fetchWithHandshakeTimeout } = require('./http.cjs');

function createProviderCatalog({ getModelCallConfig, opencodeSession }) {
  async function listModels({ provider, baseUrl, apiKey }) {
    const defaults = { deepseek: DEEPSEEK_BASE_URL, glm: GLM_BASE_URL, opencode: OPENCODE_BASE_URL };
    const url = `${(baseUrl || defaults[provider]).replace(/\/+$/, '')}/models`;
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (provider === 'opencode') {
      headers['User-Agent'] = 'llm-debate-arena/1.0';
      headers['x-opencode-session'] = opencodeSession(['test-connection']);
      if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      }
    }
    const response = await fetch(url, { headers });
    const data = await parseProviderResponse(response);
    return (data.data || []).map(model => ({ id: model.id, name: model.id }));
  }

  async function testModel({ provider, apiKey, baseUrl, modelId }) {
    const config = getModelCallConfig({ provider, apiKey, baseUrl });
    const request = providerProtocol.requestFor(provider, config.baseUrl, config.apiKey, modelId,
      [{ role: 'user', content: '请只回复 OK。' }], undefined, isReasoningModel(modelId) ? 4096 : 512, false,
      opencodeSession(['test-model', crypto.randomUUID()]));
    const response = await fetchWithHandshakeTimeout(request.url, request.options, 30000);
    const data = await parseProviderResponse(response);
    const reply = providerProtocol.responseText(data, request.protocol);
    if (!reply.trim()) throw new Error('接口已响应，但没有返回正文；可能是推理预算耗尽，不能确认模型可用');
    return { success: true, model: modelId, reply: reply.slice(0, 60), protocol: request.protocol };
  }

  return { listModels, testModel };
}

module.exports = { createProviderCatalog };
