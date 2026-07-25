const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const GLM_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

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

function buildSystemPrompt(currentLabel, stepNum, totalSteps) {
  const base = `你是一位知识渊博、逻辑清晰的辩论参与者。在这场辩论中，你的发言会以「${currentLabel}」为标识。请用中文回答。`;
  const uncertainty = `\n\n注意：你的对手可能是人类专家，也可能是另一个 AI 模型——你无法确定对方的真实身份。请不要对对方的身份做任何假设，也不要试图点破对方“是不是 AI”，把注意力放在论点本身，自然地展开讨论。`;
  if (stepNum === 1) return `${base}${uncertainty}\n\n现在请你直接针对问题给出你的全面分析和观点。`;
  return `${base}${uncertainty}\n\n请基于之前的讨论继续深入分析，提出你的观点。`;
}

function buildUserPrompt(question, currentLabel, history) {
  if (history.length === 0) return question;
  let context = `问题：${question}\n\n以下是辩论至今的发言记录（仅以中立标识展示，你不知道发言者是人还是 AI）：\n\n`;
  for (const entry of history) {
    context += `---\n${entry.label}:\n${entry.content}\n\n`;
  }
  context += `---\n\n现在轮到你（${currentLabel}）发言。请基于之前的所有发言继续深入分析，提出你的观点。`;
  return context;
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
}

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

async function callGLM(baseUrl, apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round) {
  const url = `${(baseUrl || GLM_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: modelId, messages, temperature, max_tokens: maxTokens, stream: true }) });
  if (!resp.ok) throw new Error(`GLM 错误 (${resp.status}): ${await resp.text().catch(() => '')}`);
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
  if (provider === 'glm') {
    return { provider: 'glm', baseUrl: model.baseUrl || GLM_BASE_URL, apiKey: model.apiKey || process.env.GLM_API_KEY || '' };
  }
  return { provider: 'vllm', baseUrl: model.baseUrl || vllmBaseUrl, apiKey: model.apiKey || '' };
}

async function callModel(config, modelId, messages, temperature, maxTokens, debateId, modelName, round) {
  if (config.provider === 'deepseek') {
    return callDeepSeek(config.baseUrl, config.apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round);
  }
  if (config.provider === 'glm') {
    return callGLM(config.baseUrl, config.apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round);
  }
  return callVLLM(config.baseUrl, modelId, messages, temperature, maxTokens, debateId, modelName, round, config.apiKey);
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


async function evaluateModels(debateId, session) {
  emit(debateId, "model-eval-start", {});
  var transcript = "";
  for (var _i = 0; _i < session.history.length; _i++) {
    var _e = session.history[_i];
    transcript += _e.label + "（第" + _e.step + "步）:\n" + _e.content + "\n\n";
  }
  session.evaluations = [];
  for (var _m = 0; _m < session.models.length; _m++) {
    var model = session.models[_m];
    var myLabel = session.labels ? session.labels[_m] : model.name;
    var msgs = [
      { role: "system", content: "你刚刚以「" + myLabel + "」的身份参加了一场辩论，对手可能是人类专家，也可能是另一个 AI 模型，你无法确定对方的真实身份。请基于辩论记录，用中文简短评价每位发言者（包括你自己「" + myLabel + "」）的表现，最后说出你认为哪位发言者表现最好。请始终使用「参与者X」这样的中立标识，不要猜测或编造对方的真实身份。控制在200字以内。" },
      { role: "user", content: "辩论问题：" + session.question + "\n\n完整辩论记录（仅以中立标识展示）：\n" + transcript + "\n\n请评价每位发言者并指出谁表现最好。" }
    ];
    var callConfig = getModelCallConfig(model, session.vllmBaseUrl);
    try {
      var text = await callModel(callConfig, model.id, msgs, 0.3, 512, debateId, model.name, "eval");
      session.evaluations.push({ model: model.name, evaluation: text });
      emit(debateId, "model-evaluation", { model: model.name, evaluation: text });
    } catch (err) {
      session.evaluations.push({ model: model.name, evaluation: "评价失败: " + err.message });
      emit(debateId, "model-evaluation", { model: model.name, evaluation: "评价失败: " + err.message });
    }
  }
}

async function startDebate(debateId) {
  const s = sessions.get(debateId);
  if (!s) return;
  s.status = 'running';
  s.history = [];
  s.aborted = false;
  // 为每个参与方分配一个中立标识（参与者A、参与者B…），避免在 prompt 中泄露真实模型名，制造身份不确定性
  s.labels = s.models.map(function (_, i) { return '参与者' + String.fromCharCode(65 + i); });
  const totalSteps = s.rounds * s.models.length;
  emit(debateId, 'debate-start', { question: s.question, models: s.models, totalSteps: totalSteps });
  for (let step = 0; step < totalSteps; step++) {
    const modelIdx = step % s.models.length;
    const model = s.models[modelIdx];
    const currentLabel = s.labels[modelIdx];
    const turnNum = step + 1;
    emit(debateId, 'round-start', { turn: turnNum, totalTurns: totalSteps, model: model.name });
    const msgs = [
      { role: 'system', content: buildSystemPrompt(currentLabel, turnNum, totalSteps) },
      { role: 'user', content: buildUserPrompt(s.question, currentLabel, s.history) }
    ];
    emit(debateId, 'model-start', { model: model.name, round: turnNum });
    const callConfig = getModelCallConfig(model, s.vllmBaseUrl);
    try {
      const text = await callModel(callConfig, model.id, msgs, s.temperature, s.maxTokens, debateId, model.name, turnNum);
      s.history.push({ model: model.name, label: currentLabel, step: turnNum, content: text });
      emit(debateId, 'model-done', { model: model.name, round: turnNum, fullText: text });
    } catch (err) {
      s.history.push({ model: model.name, step: turnNum, content: '[' + model.name + '] \u751f\u6210\u5931\u8d25: ' + err.message });
      emit(debateId, 'model-error', { model: model.name, round: turnNum, error: err.message });
      s.aborted = true;
      break;
    }
    emit(debateId, 'round-end', { turn: turnNum, totalTurns: totalSteps });
  }
  if (s.aborted) {
    s.status = 'aborted';
    emit(debateId, 'debate-end', { aborted: true, errorMessage: s.history[s.history.length - 1]?.content || '未知错误' });
  } else {
    s.status = 'completed';
    try {
      await evaluateModels(debateId, s);
    } catch (e) { console.error('Eval failed:', e.message); }
    try {
      await runJudge(debateId, s);
      emit(debateId, 'debate-end', { judgeText: s.judgeResult.judgeText, scores: s.judgeResult.scores, winner: s.judgeResult.winner, evaluations: s.evaluations || [] });
    } catch (e) {
      emit(debateId, 'debate-end', { judgeText: '\u88c1\u5224\u5931\u8d25', scores: {}, winner: '', evaluations: s.evaluations || [] });
    }
  }
  try {
    const dir = require('path').join(__dirname, 'debates');
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
    const now = new Date();
    const filename = now.getFullYear() + '-' +
      String(now.getMonth()+1).padStart(2,'0') + '-' +
      String(now.getDate()).padStart(2,'0') + '_' +
      String(now.getHours()).padStart(2,'0') + '-' +
      String(now.getMinutes()).padStart(2,'0') + '-' +
      String(now.getSeconds()).padStart(2,'0') + '.md';
    let md = '# LLM \u8fa9\u8bba\u8bb0\u5f55\n\n';
    if (s.aborted) md += '**状态**: ❌ 辩论因错误中断\n\n';
    md += '**\u95ee\u9898**: ' + s.question + '\n\n';
    md += '**\u53c2\u4e0e\u6a21\u578b**: ' + s.models.map(m => m.name).join(', ') + '\n\n---\n\n';
    for (let i = 0; i < s.history.length; i++) {
      md += '## \u7b2c' + (i+1) + '\u6b65 - ' + s.history[i].model + '\n\n';
      md += s.history[i].content + '\n\n---\n\n';
    }
    if (s.evaluations && s.evaluations.length > 0) {
      md += "## 模型互评\n\n";
      for (var k = 0; k < s.evaluations.length; k++) {
        var ev = s.evaluations[k];
        md += "**" + ev.model + "**：\n\n" + ev.evaluation + "\n\n---\n\n";
      }
    }
    require('fs').writeFileSync(require('path').join(dir, filename), md, 'utf-8');
    console.log('Debate saved: ' + filename);
  } catch (e) { console.error('Save failed:', e.message); }
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
  if (prov === 'glm') {
    const url = `${(baseUrl || GLM_BASE_URL).replace(/\/+$/, '')}/models`;
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
