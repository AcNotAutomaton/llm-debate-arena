// OpenCode Go: https://opencode.ai/docs/go/#endpoints
// Zen: https://opencode.ai/docs/zen/#endpoints
function protocolFor(provider, modelId) {
  if (provider !== 'opencode') return 'chat';
  const id = String(modelId || '').toLowerCase();
  if (/^(claude|qwen|minimax)/.test(id)) return 'anthropic';
  if (/^(gpt-|o[134](?:-|$)|grok-|muse-)/.test(id)) return 'responses';
  if (/^gemini/.test(id)) throw new Error('该模型使用 Google 原生接口，当前尚未接入；请选择其他模型');
  return 'chat';
}

function requestFor(provider, baseUrl, apiKey, modelId, messages, temperature, maxTokens, stream, session) {
  const protocol = protocolFor(provider, modelId);
  const headers = { 'Content-Type': 'application/json' };
  if (provider === 'opencode') {
    headers['User-Agent'] = 'llm-debate-arena/1.0';
    headers['x-opencode-session'] = session;
  }
  let body, endpoint;
  if (protocol === 'anthropic') {
    endpoint = 'messages';
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: modelId, messages: messages.filter(m => m.role !== 'system'),
      system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), max_tokens: maxTokens, stream };
  } else {
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (protocol === 'responses') {
      endpoint = 'responses';
      body = { model: modelId, input: messages.filter(m => m.role !== 'system'),
        instructions: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), max_output_tokens: maxTokens, stream };
    } else {
      endpoint = 'chat/completions';
      body = { model: modelId, messages, max_tokens: maxTokens, stream };
    }
  }
  if (temperature !== undefined && !/^(gpt-|o[134](?:-|$))/.test(modelId)) body.temperature = temperature;
  const base = baseUrl.replace(/\/+$/, '').replace(/\/(chat\/completions|messages|responses)$/, '');
  return { protocol, url: `${base}/${endpoint}`, options: { method: 'POST', headers, body: JSON.stringify(body) } };
}

function responseText(data, protocol) {
  if (protocol === 'anthropic') return (data.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('');
  if (protocol === 'responses') return data.output_text || (data.output || []).flatMap(item => item.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('');
  const content = data.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : (Array.isArray(content) ? content.map(c => c.text || '').join('') : '');
}
module.exports = { protocolFor, requestFor, responseText };
