const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const sseClients = new Map();

function emit(debateId, event, data) {
  const clients = sseClients.get(debateId);
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (clients && clients.size > 0) {
    for (const res of clients) res.write(msg);
  } else {
    const session = sessions.get(debateId);
    if (session) {
      session.eventBuffer = session.eventBuffer || [];
      session.eventBuffer.push({ event, data });
    }
  }
}

function getPhaseName(round, total) {
  if (round === 1) return '\u7acb\u8bba\u9648\u8ff0';
  if (round === total) return '\u603b\u7ed3\u9648\u8bcd';
  return '\u653b\u8fa9\u8fa9\u8bba';
}

function buildSystemPrompt(modelName, round, totalRounds) {
  const phase = getPhaseName(round, totalRounds);
  const base = `\u4f60\u662f ${modelName}\uff0c\u4e00\u4f4d\u77e5\u8bc6\u6e0a\u535a\u3001\u903b\u8f91\u6e05\u6670\u7684\u4e13\u5bb6\u3002\u8bf7\u7528\u4e2d\u6587\u56de\u7b54\u3002`;
  if (round === 1) return `${base}\n\n\u73b0\u5728\u662f\u300c${phase}\u300d\u9636\u6bb5\u3002\u8bf7\u76f4\u63a5\u9488\u5bf9\u95ee\u9898\u7ed9\u51fa\u4f60\u7684\u5168\u9762\u5206\u6790\u548c\u89c2\u70b9\u3002`;
  if (round === totalRounds) return `${base}\n\n\u73b0\u5728\u662f\u300c${phase}\u300d\u9636\u6bb5\u3002\u8bf7\u56de\u987e\u6574\u573a\u8fa9\u8bba\uff0c\u603b\u7ed3\u4f60\u7684\u6838\u5fc3\u8bba\u70b9\uff0c\u5e76\u7ed9\u51fa\u6700\u7ec8\u7ed3\u8bba\u3002`;
  return `${base}\n\n\u73b0\u5728\u662f\u300c${phase}\u300d\u9636\u6bb5\u3002\u8bf7\u9488\u5bf9\u5176\u4ed6\u4e13\u5bb6\u7684\u89c2\u70b9\u8fdb\u884c\u5206\u6790\u3001\u56de\u5e94\u548c\u53cd\u9a73\u3002`;
}

function buildUserPrompt(question, modelName, round, totalRounds, history) {
  if (round === 1) return question;
  let other = '';
  for (const [name, rounds] of history) {
    if (name === modelName) continue;
    const prev = rounds.find(r => r.round === round - 1);
    if (prev) other += `\n\u3010${name} \u7684\u89c2\u70b9\u3011\n${prev.content.substring(0, 1000)}\n`;
  }
  let myH = '';
  const myR = history.get(modelName);
  if (myR) myH = myR.map(r => `\u7b2c${r.round}\u8f6e\uff1a${r.content.substring(0, 500)}`).join('\n\n');
  if (round < totalRounds) {
    return `\u95ee\u9898\uff1a${question}\n\n\u5176\u4ed6\u4e13\u5bb6\u7684\u89c2\u70b9\uff1a\n${other}\n\n\u4f60\u7684\u4e0a\u4e00\u8f6e\u56de\u7b54\uff1a\n${myH}\n\n\u8bf7\u9488\u5bf9\u5176\u4ed6\u4e13\u5bb6\u7684\u89c2\u70b9\u8fdb\u884c\u5206\u6790\u3001\u53cd\u9a73\u6216\u8865\u5145\u3002`;
  }
  let full = '';
  for (const [name, rounds] of history) {
    full += `\n=== ${name} \u7684\u8fa9\u8bba\u8bb0\u5f55 ===\n`;
    for (const r of rounds) full += `\u7b2c${r.round}\u8f6e\uff1a${r.content}\n`;
  }
  return `\u95ee\u9898\uff1a${question}\n\n\u6574\u573a\u8fa9\u8bba\u56de\u987e\uff1a\n${full}\n\n\u8bf7\u505a\u51fa\u4f60\u7684\u603b\u7ed3\u9648\u8bcd\u3002`;
}

async function callVLLM(baseUrl, modelId, messages, temperature, maxTokens, debateId, modelName, round, apiKey) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages, temperature, max_tokens: maxTokens, stream: true }) });
  if (!resp.ok) throw new Error(`vLLM \u9519\u8bef (${resp.status}): ${await resp.text().catch(() => '')}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '', buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const j = t.slice(5).trim();
      if (j === '[DONE]') continue;
      try {
        const c = JSON.parse(j);
        const tok = c.choices?.[0]?.delta?.content || '';
        const reasonTok = c.choices?.[0]?.delta?.reasoning_content || '';
        if (reasonTok) { emit(debateId, 'model-token', { model: modelName, round, token: reasonTok, type: 'reasoning' }); }
        if (tok) { full += tok; emit(debateId, 'model-token', { model: modelName, round, token: tok, type: 'content' }); }
      } catch {}
    }
  }
  return full;

async function callDeepSeek(baseUrl, apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round) {
  const url = `${(baseUrl || DEEPSEEK_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages, temperature, max_tokens: maxTokens, stream: true }) });
  if (!resp.ok) throw new Error(`DeepSeek 错误 (${resp.status}): ${await resp.text().catch(() => '')}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '', buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const j = t.slice(5).trim();
      if (j === '[DONE]') continue;
      try {
        const c = JSON.parse(j);
        const tok = c.choices?.[0]?.delta?.content || '';
        if (tok) { full += tok; emit(debateId, 'model-token', { model: modelName, round, token: tok }); }
      } catch {}
    }
  }
  return full;
}

function getModelCallConfig(model, vllmBaseUrl) {
  const provider = model.provider || 'vllm';
  if (provider === 'deepseek') {
    return { provider: 'deepseek', baseUrl: model.baseUrl || DEEPSEEK_BASE_URL, apiKey: model.apiKey || process.env.DEEPSEEK_API_KEY || '' };
  }
  return { provider: 'vllm', baseUrl: model.baseUrl || vllmBaseUrl, apiKey: model.apiKey || '' };
}

async function callModel(config, modelId, messages, temperature, maxTokens, debateId, modelName, round) {
  if (config.provider === 'deepseek') {
    return callDeepSeek(config.baseUrl, config.apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round);
  }
  return callVLLM(config.baseUrl, modelId, messages, temperature, maxTokens, debateId, modelName, round, config.apiKey);
}

}

async function runJudge(debateId, session) {
  emit(debateId, 'judge-start', {});
  let t = `\u8fa9\u8bba\u95ee\u9898\uff1a${session.question}\n\n`;
  for (const [name, rounds] of session.history) {
    t += `\n===== ${name} \u7684\u8fa9\u8bba =====\n`;
    for (const r of rounds) t += `\n\u7b2c${r.round}\u8f6e\uff08${r.phase}\uff09\uff1a\n${r.content}\n`;
  }
  const msgs = [
    { role: 'system', content: `\u4f60\u662f\u4e00\u540d\u516c\u6b63\u7684\u8fa9\u8bba\u88c1\u5224\u3002\u8bf7\u6839\u636e\u4ee5\u4e0b\u7ef4\u5ea6\u5bf9\u6bcf\u4f4d\u8fa9\u624b\u8bc4\u5206\uff081-10\u5206\uff09\uff0c\u5e76\u9009\u51fa\u603b\u51a0\u519b\u3002\n\n\u8bc4\u5206\u7ef4\u5ea6\uff1a\n1. \u903b\u8f91\u6027\u548c\u8bba\u8bc1\u8d28\u91cf\n2. \u77e5\u8bc6\u6df1\u5ea6\u548c\u5e7f\u5ea6\n3. \u8bf4\u670d\u529b\u548c\u8868\u8fbe\u529b\n4. \u56de\u5e94\u4ed6\u4eba\u89c2\u70b9\u7684\u80fd\u529b\n5. \u521b\u9020\u6027\u548c\u6d1e\u5bdf\u529b\n\n\u683c\u5f0f\u8981\u6c42\uff1a\n\u8fa9\u624b\u8bc4\u5206\uff1a\n- \u6a21\u578b\u540d: \u5206\u6570\n...\n\u51a0\u519b\uff1a\u6a21\u578b\u540d\n\u8bc4\u8bed\uff1a...` },
    { role: 'user', content: t }
  ];
  try {
    const judgeModelId = session.judgeModel || session.models[0].id;
    const judgeConfig = session.judgeConfig || getModelCallConfig(session.models[0], session.vllmBaseUrl);
    const text = await callModel(judgeConfig, judgeModelId, msgs, 0.3, 2048, debateId, '裁判', session.rounds + 1);
    const scores = {};
    let winner = '';
    for (const line of text.split('\n')) {
      const m = line.match(/-\s*(.+?):\s*(\d+(?:\.\d+)?)/);
      if (m) scores[m[1].trim()] = parseFloat(m[2]);
      const w = line.match(/[\u51a0\u51a0][\u519b\u519b][\uff1a:]\s*(.+)/);
      if (w) winner = w[1].trim();
    }
    if (Object.keys(scores).length === 0) {
      for (const model of session.models) {
        const idx = text.indexOf(model.name);
        if (idx >= 0) {
          const after = text.substring(idx + model.name.length, idx + model.name.length + 20);
          const sm = after.match(/(\d+(?:\.\d+)?)/);
          if (sm) scores[model.name] = parseFloat(sm[1]);
        }
      }
    }
    const r = { judgeText: text, scores, winner: winner || (Object.keys(scores).length > 0 ? Object.entries(scores).sort((a,b) => b[1]-a[1])[0][0] : '') };
    session.status = 'completed';
    session.judgeResult = r;
    return r;
  } catch (err) {
    const r = { judgeText: `\u88c1\u5224\u8bc4\u5206\u5931\u8d25\uff1a${err.message}`, scores: {}, winner: '' };
    session.status = 'completed';
    session.judgeResult = r;
    return r;
  }
}

async function startDebate(debateId) {
  const s = sessions.get(debateId);
  if (!s) return;
  s.status = 'running';
  s.history = new Map();
  for (const m of s.models) s.history.set(m.name, []);
  emit(debateId, 'debate-start', { question: s.question, models: s.models, totalRounds: s.rounds });
  for (let r = 1; r <= s.rounds; r++) {
    const phase = getPhaseName(r, s.rounds);
    emit(debateId, 'round-start', { round: r, totalRounds: s.rounds, phase });
    await Promise.all(s.models.map(async (model) => {
      emit(debateId, 'model-start', { model: model.name, round: r });
      const msgs = [
        { role: 'system', content: buildSystemPrompt(model.name, r, s.rounds) },
        { role: 'user', content: buildUserPrompt(s.question, model.name, r, s.rounds, s.history) }
      ];
      const callConfig = getModelCallConfig(model, s.vllmBaseUrl);
      try {
        const text = await callModel(callConfig, model.id, msgs, s.temperature, s.maxTokens, debateId, model.name, r);
        s.history.get(model.name).push({ round: r, phase, content: text });
        emit(debateId, 'model-done', { model: model.name, round: r, fullText: text });
      } catch (err) {
        s.history.get(model.name).push({ round: r, phase, content: `[${model.name}] \u751f\u6210\u5931\u8d25: ${err.message}` });
        emit(debateId, 'model-error', { model: model.name, round: r, error: err.message });
      }
    }));
    emit(debateId, 'round-end', { round: r });
  }
  const result = await runJudge(debateId, s);
  emit(debateId, 'debate-end', result);
}

app.post('/api/test-connection', async (req, res) => {
  const { baseUrl, provider, apiKey } = req.body;
  const prov = provider || 'vllm';
  if (prov === 'deepseek') {
    const url = `${(baseUrl || DEEPSEEK_BASE_URL).replace(/\/+$/, '')}/models`;
    try {
      const headers = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const resp = await fetch(url, { headers });
      const data = await resp.json();
      res.json({ success: true, models: (data.data || []).map(m => ({ id: m.id, name: m.id })) });
    } catch (err) { res.json({ success: false, error: err.message }); }
    return;
  }
  try {
    const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`);
    const data = await resp.json();
    res.json({ success: true, models: (data.data || []).map(m => ({ id: m.id, name: m.id })) });
  } catch (err) { res.json({ success: false, error: err.message }); }
});

app.post('/api/debate', (req, res) => {
  const { question, models, rounds = 3, vllmBaseUrl = 'http://localhost:8000/v1', temperature = 0.7, maxTokens = 2048, judgeModel, judgeProvider, judgeApiKey, judgeBaseUrl } = req.body;
  if (!question || !models || models.length < 2) return res.status(400).json({ error: '\u9700\u8981\u81f3\u5c112\u4e2a\u6a21\u578b\u53c2\u4e0e\u8fa9\u8bba' });
  const id = crypto.randomUUID();
    const judgeConfig = judgeProvider ? { provider: judgeProvider, baseUrl: judgeBaseUrl || DEEPSEEK_BASE_URL, apiKey: judgeApiKey || '' } : null;
  sessions.set(id, { id, question, models, rounds, vllmBaseUrl, temperature, maxTokens, judgeModel: judgeModel || models[0].id, judgeConfig, status: 'pending', history: new Map(), judgeResult: null, createdAt: Date.now() });
  sseClients.set(id, new Set());
  startDebate(id).catch(e => console.error(e));
  res.json({ debateId: id });
});

app.get('/api/debate/:id/stream', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: '\u8fa9\u8bba\u4e0d\u5b58\u5728' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  const clients = sseClients.get(req.params.id);
  clients.add(res);
  if (s && s.eventBuffer && s.eventBuffer.length > 0) {
    for (const item of s.eventBuffer) {
      const replayMsg = `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`;
      res.write(replayMsg);
    }
    delete s.eventBuffer;
  }
  req.on('close', () => clients.delete(res));
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`🎯 LLM \u8fa9\u8bba\u7ade\u6280\u573a\u5df2\u542f\u52a8\uff01`);
  console.log(`   \u672c\u5730\u8bbf\u95ee: http://localhost:${PORT}`);
  console.log(`   \u8bf7\u786e\u4fdd vLLM \u670d\u52a1\u5df2\u542f\u52a8`);
});
