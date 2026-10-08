const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { updateRankingSummary } = require('./reports/ranking-summary.cjs');
const experimentProtocol = require('./protocols/experiment-protocol.cjs');
const providerProtocol = require('./protocols/provider-protocol.cjs');
const projectRoot = path.resolve(__dirname, '..');
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const GLM_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/go/v1';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(projectRoot, 'public')));

const sessions = new Map();
const sseClients = new Map();
const experiments = new Map();
// 临时查看上游流，不写入实验 JSON、辩论历史或 Markdown。
const experimentChats = new WeakMap();

function updateExperimentChat(experiment, event, data) {
  const chat = experimentChats.get(experiment);
  if (!chat) return;
  if (event === 'debate-end') {
    for (const message of chat.messages) {
      if (!['completed', 'failed'].includes(message.state)) {
        message.state = data.aborted ? 'failed' : 'completed';
      }
    }
    return;
  }
  if (!data.model || !['model-start', 'model-token', 'model-done', 'model-evaluation', 'model-retry', 'model-error', 'model-interrupt', 'model-truncation'].includes(event)) return;
  const round = data.round ?? (event === 'model-evaluation' ? chat.messages.findLast(item => item.model === data.model && typeof item.round === 'string')?.round : null) ?? 'eval';
  if (event === 'model-start') {
    for (const previous of chat.messages) {
      if (previous.model === data.model && previous.round !== round && !['completed', 'failed'].includes(previous.state)) previous.state = 'completed';
    }
  }
  let message = chat.messages.find(item => item.model === data.model && item.round === round);
  if (!message) {
    message = { model: data.model, round, phase: data.phase || '', partner: data.partner || '', reasoning: '', text: '', state: 'waiting', startedAt: Date.now(), lastTokenAt: null, notice: '' };
    chat.messages.push(message);
    if (chat.messages.length > 80) chat.messages.shift();
  }
  if (event === 'model-token') {
    const field = data.type === 'reasoning' ? 'reasoning' : 'text';
    message[field] = (message[field] + data.token).slice(-16000);
    message.lastTokenAt = Date.now();
    message.state = field === 'reasoning' ? 'thinking' : 'output';
    message.notice = '';
  } else if (event === 'model-done' || event === 'model-evaluation') {
    if (!message.text) message.text = (data.fullText ?? data.evaluation ?? '').slice(-16000);
    message.state = event === 'model-evaluation' && !data.winRes ? 'failed' : 'completed';
  } else if (event === 'model-retry') {
    if (data.resetStream) {
      message.reasoning = '';
      message.text = '';
      message.startedAt = Date.now();
      message.lastTokenAt = null;
    }
    message.state = 'retrying';
    message.notice = `${data.delayMs / 1000} 秒后第 ${data.nextAttempt} 次尝试：${data.reason}`;
  } else if (event === 'model-error') {
    message.state = 'failed';
    message.notice = data.error;
  } else if (event === 'model-interrupt' || event === 'model-truncation') {
    message.notice = data.reason;
  }
}

function emit(debateId, event, data) {
  const session = sessions.get(debateId);
  const experiment = session?.experimentId ? experiments.get(session.experimentId) : null;
  const current = experiment?.current;
  if (current && current.debateId === debateId) {
    // 正文直接从上游原始流更新；常规 SSE 可能缓冲或过滤正文，不能重复累计。
    if (event !== 'model-token' || data.type === 'reasoning') updateExperimentChat(experiment, event, data);
    if (event === 'round-start') {
      current.step = data.turn;
      current.model = data.model;
      current.phase = data.phase || '讨论中';
      current.partner = data.partner || '';
      current.text = '';
    } else if (event === 'model-token' && data.type !== 'reasoning' && typeof data.round === 'number') {
      current.text = (current.text + data.token).slice(-8000);
    } else if (event === 'model-done') {
      current.text = (data.fullText || '').slice(-8000);
      if (data.phase) current.phase = data.phase;
      current.speeches.push({ step: data.round, model: data.model, phase: data.phase || current.phase, partner: current.partner, text: (data.fullText || '').slice(0, 12000) });
    } else if (event === 'model-eval-start') {
      current.phase = '模型互评中';
      current.model = '';
      current.text = '';
    } else if (event === 'model-evaluation') {
      current.evaluations.push({ model: data.model, winRes: data.winRes || null });
    } else if (event === 'model-retry') {
      current.phase = `${data.model} 自动重试中`;
      if (data.resetStream) current.text = '';
    } else if (event === 'model-error') {
      current.phase = '调用失败';
      current.error = data.error;
    } else if (event === 'debate-end') {
      current.phase = data.aborted ? '辩论中断' : '本场已结束';
    }
  }
  const clients = sseClients.get(debateId);
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  if (clients && clients.size > 0) {
    for (const res of clients) res.write(msg);
  } else {
    if (session && session.captureEvents !== false) {
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

// 推理模型最低 max_tokens 阈值：推理模型的思考过程会占用大量 tokens，
// 若用用户设的小值会把思考用光、正文还没生成就被截断。
// 对推理模型自动放大到该下限，非推理模型仍用用户的设置值。
const REASONING_MODEL_MIN_TOKENS = 16384;
// 通过模型名惯例匹配推理模型，无需维护精确名单
function isReasoningModel(modelId) {
  const id = (modelId || '').toLowerCase();
  // glm-4.6 及以上版本（4.6/4.7/4.8/4.9）均带推理能力，4.5 及以下不带
  // qwen3 的 max/flash 档为混合推理型号（互评时会先输出长独白再给结论），plus 档未观察到思考行为
  // Kimi 互评也可能先消耗预算进行推理，按推理模型预留输出空间。
  return /^(kimi|glm-5|glm-4\.[6-9]|deepseek-v4-pro|deepseek-r|deepseek-reason|qwq|o1|o3|o4|qwen3\.\d+-(max|flash)|.*-r1|.*-thinking|.*-reasoner|.*-air|minimax-m)/i.test(id)
      || /thinking|reasoning|reasoner|qwq|o1-|o3-|o4-|-r1$|-air$/i.test(id);
}
function effectiveMaxTokens(modelId, userMax) {
  return isReasoningModel(modelId) ? Math.max(userMax || 0, REASONING_MODEL_MIN_TOKENS) : userMax;
}

// 统一流式读取器：处理 SSE 拆包、reasoning/content 分流，
// 并实现三项健壮性保障：
//   A) 单 token 间隔超时（默认 300s 无新数据即中止）
//   B) [DONE] 是否真实接收过；若流结束但未收到 [DONE] 视为异常中断
//   C) 读取 finish_reason，识别 length/最大 token 截断
// 返回 { text, finishReason, doneSeen, interrupted, interruptedReason }
const READSTREAM_TIMEOUT_MS = 300000;
// fetch 握手阶段超时：上游长时间不返回响应头时中止，避免"一直思考中"卡死整个辩论
const FETCH_HANDSHAKE_TIMEOUT_MS = 120000;
// 瞬时故障重试：连接失败 / HTTP 408/429/5xx，以及尚无正文的流断线。
// 已收到正文后中断则保留部分内容并停止，不能重试后拼接成重复回答。
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const MODEL_FETCH_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2000;

async function parseProviderResponse(resp) {
  const text = await resp.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!resp.ok || data.error) {
    const err = data.error || data;
    const msg = (err && (err.message || err.raw)) || `HTTP ${resp.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

// 带 handshake 超时的 fetch：若上游在 HANDSHAKE_MS 内未返回响应头则 abort
async function fetchWithHandshakeTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('handshake-timeout')), timeoutMs || FETCH_HANDSHAKE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round((timeoutMs || FETCH_HANDSHAKE_TIMEOUT_MS)/1000)}s 内未收到响应）`);
    }
    throw err;
  }
}

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

async function readStream(resp, debateId, modelName, round, isAnthropic, isResponses = false) {
  if ((resp.headers.get('content-type') || '').includes('application/json')) {
    const data = await parseProviderResponse(resp);
    const text = providerProtocol.responseText(data, isAnthropic ? 'anthropic' : isResponses ? 'responses' : 'chat');
    if (!text.trim()) throw new Error('上游返回空正文，请检查模型权限或输出 token 预算');
    const liveExperiment = experiments.get(sessions.get(debateId)?.experimentId);
    if (liveExperiment) updateExperimentChat(liveExperiment, 'model-token', { model: modelName, round, token: text });
    emit(debateId, 'model-token', { model: modelName, round, token: text });
    return { text, doneSeen: true, interrupted: false, truncatedByToken: data.status === 'incomplete' || data.stop_reason === 'max_tokens' || data.choices?.[0]?.finish_reason === 'length' };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '', reasoning = '', buf = '';
  let doneSeen = false, finishReason = null;
  let interrupted = false, interruptedReason = '';
  let lastTokenTs = Date.now();
  let readerEnded = false;
  // 英文思考泄漏实时检测状态
  let thinkLeakChecked = false; // 是否已完成开头判定
  let thinkLeakDetected = false; // 开头判定为英文思考，正在静默累积
  let thinkLeakBuf = ''; // 检测到中文正文后的过渡缓冲
  let currentEventType = ''; // Anthropic SSE 的 event 类型
  const timeoutMs = READSTREAM_TIMEOUT_MS;
  async function watchIdle() {
    while (true) {
      await new Promise(r => setTimeout(r, 1000));
      if (doneSeen || interrupted || readerEnded) return;
      if (Date.now() - lastTokenTs > timeoutMs) {
        interrupted = true; interruptedReason = `超过 ${Math.round(timeoutMs/1000)}s 无新数据`;
        try { reader.cancel().catch(() => {}); } catch {}
        return;
      }
    }
  }
  const watcher = watchIdle().catch(() => {});
  let streamFinished = false; // 上游已通过 finish_reason 声明生成完毕
  let streamError = null; // 连接异常（如 terminated）
  let transportError = false;
  while (true) {
    if (interrupted || streamFinished) break;
    let chunk;
    try {
      chunk = await reader.read();
    } catch (readErr) {
      streamError = readErr;
      transportError = true;
      break;
    }
    const { done, value } = chunk;
    if (done && !buf) break;
    buf += decoder.decode(value, { stream: !done });
    // Some gateways omit the final newline; still process the last SSE data line.
    if (done && buf) buf += '\n';
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      // —— 协议分支：各自提取 tok / reasonTok，后续共享 think-leak 检测与推送 ——
      let tok = '', reasonTok = '';
      if (isResponses) {
        if (!t.startsWith('data:')) continue;
        const j = t.slice(5).trim();
        if (j === '[DONE]') { doneSeen = true; streamFinished = true; break; }
        let c;
        try { c = JSON.parse(j); } catch { continue; }
        if (c.type === 'error' || c.type === 'response.failed') { streamError = new Error(c.message || c.response?.error?.message || 'Responses 接口返回错误'); streamFinished = true; break; }
        if (c.type === 'response.output_text.delta') tok = c.delta || '';
        if (c.type === 'response.completed' || c.type === 'response.incomplete') {
          finishReason = c.type === 'response.incomplete' ? 'length' : 'stop';
          doneSeen = true; streamFinished = true; break;
        }
      } else if (isAnthropic) {
        // Anthropic SSE: event: 行 + data: 行交替
        if (t.startsWith('event:')) { currentEventType = t.slice(6).trim(); continue; }
        if (!t || !t.startsWith('data:')) continue;
        const j = t.slice(5).trim();
        try {
          const c = JSON.parse(j);
          if (c.type === 'error') { streamError = new Error(c.error?.message || 'Anthropic 流返回错误'); streamFinished = true; break; }
          if (c.type === 'content_block_delta' && c.delta) {
            if (c.delta.type === 'text_delta') tok = c.delta.text || '';
            else if (c.delta.type === 'thinking_delta') reasonTok = c.delta.thinking || '';
          } else if (c.type === 'message_delta' && c.delta?.stop_reason) {
            finishReason = c.delta.stop_reason;
          } else if (c.type === 'message_stop') {
            doneSeen = true; streamFinished = true; break;
          }
        } catch {}
      } else {
        // OpenAI 兼容 SSE
        if (!t || !t.startsWith('data:')) continue;
        const j = t.slice(5).trim();
        if (j === '[DONE]') { doneSeen = true; streamFinished = true; break; }
        try {
          const c = JSON.parse(j);
          const choice = c.choices?.[0] || {};
          if (c.error) { streamError = new Error(c.error.message || '上游流返回错误'); streamFinished = true; break; }
          tok = choice.delta?.content || '';
          reasonTok = choice.delta?.reasoning_content || '';
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            doneSeen = true; streamFinished = true;
          }
        } catch {}
      }
      // —— 共享：reasoning token 处理 ——
      if (reasonTok) { reasoning += reasonTok; lastTokenTs = Date.now(); emit(debateId, 'model-token', { model: modelName, round, token: reasonTok, type: 'reasoning' }); }
      // —— 共享：content token 处理 + think-leak 实时检测 ——
      if (tok) {
          const liveExperiment = experiments.get(sessions.get(debateId)?.experimentId);
          if (liveExperiment) updateExperimentChat(liveExperiment, 'model-token', { model: modelName, round, token: tok });
          full += tok;
          lastTokenTs = Date.now();
          if (!thinkLeakChecked) {
            if (full.length < 80) { /* 继续累积，不推也不判定 */ }
            else {
              thinkLeakChecked = true;
              if (/^(Let me |Let's |Now I need to |Let me analyze|Let me understand|Let me consider|Let me think|Let me draft|Let me write|Let me see|I need to |First, let me|Okay, let me|Alright, let me)/i.test(full.trimStart())) {
                thinkLeakDetected = true;
              } else {
                emit(debateId, 'model-token', { model: modelName, round, token: full });
              }
            }
          } else if (!thinkLeakDetected) {
            emit(debateId, 'model-token', { model: modelName, round, token: tok });
          } else {
            if (/[\u4e00-\u9fff]/.test(tok) && thinkLeakBuf === '') {
              thinkLeakBuf = tok;
            } else if (thinkLeakBuf) {
              thinkLeakBuf += tok;
              if (thinkLeakBuf.length > 20) {
                emit(debateId, 'model-token', { model: modelName, round, token: thinkLeakBuf });
                thinkLeakBuf = '';
                thinkLeakDetected = false;
              }
            }
          }
      }
    }
    if (done) break;
  }
  if (streamFinished) { try { reader.cancel().catch(() => {}); } catch {} }
  readerEnded = true;
  await watcher;
  // 兜底：剥离模型把思考过程泄漏到 content（而非 reasoning_content）的情况。
  // 三种已知形态：
  //   1) <think>...</think> 标签包裹（minimax-m3 等），含被 max_tokens 截断的孤立  起始标签
  //   2) 以「1. **分析请求**」「1. **分析辩论**」等元指令开头的编号思考（glm-4.7）
  //      ——真实辩论正文里模型也会用编号列表展开论点，但不会写「分析请求/分析辩论/确定胜者」
  //         这种对自身任务的元描述，因此按这些元指令截断是安全的。
  //   3) 英文思考引子（GLM5、minimax 等英文思考链）——可能是整段英文思考（正文未生成就截断），
  //      也可能是先写英文思考再切换到中文正文。后者需保留中文正文部分。
  // 提示词已明令禁止，但仍兜底——保证返回的 text 不含思考过程。
  let cleaned = full;
  // 形态 1：闭合的 <think>...</think>
  cleaned = cleaned.replace(/\u003cthink\u003e[\s\S]*?\u003c\/think\u003e/gi, '');
  // 形态 1 续：孤立的未闭合 <think> 起始标签（截断时常见），从该标签起整段丢弃
  const openIdx = cleaned.search(/\u003cthink\u003e/i);
  if (openIdx >= 0) cleaned = cleaned.substring(0, openIdx);
  // 形态 2：以「1. **分析请求/分析辩论/分析任务/确定胜者**」等元指令开头的编号思考
  //         模型可能写多段编号思考再写正文。简单可靠的规则：
  //         在元指令起点之后搜索首个「以参与者/我/综合/win_res开头的行」作为正文起点；
  //         找不到则整段丢弃。
  const metaIdx = cleaned.search(/^\s*\d+\.\s*\*{0,2}\s*(分析请求|分析辩论|分析任务|分析辩论内容|确定胜者|评价表现|分析表现)/mi);
  if (metaIdx >= 0) {
    const afterMeta = cleaned.substring(metaIdx);
    // 找首个「参与者X」开头的行或「我认为」「综合」「win_res」等正文标志行
    const bodyMatch = afterMeta.match(/\n(参与者[A-Z]|我认为|综合[：:]|本场|win_res[:：])/);
    if (bodyMatch && bodyMatch.index >= 0) {
      cleaned = afterMeta.substring(bodyMatch.index + 1); // +1 跳过换行
    } else {
      cleaned = cleaned.substring(0, metaIdx);
    }
  }
  // 形态 3：英文思考引子。两种子情况：
  //   a) 文首英文思考 + 后续中文正文 → 保留中文正文（找首个中文字符位置作为正文起点）
  //   b) 整段都是英文思考（被 max_tokens 截断、正文未生成）→ 返回空，上层重试
  const engStartIdx = cleaned.search(/^(Let me |Let's |Now I need to |I need to |First, let me|Okay, let me|Alright, let me)/mi);
  if (engStartIdx >= 0) {
    // 在英文思考起点之后找首个中文字符（正文开始的标志）
    const afterEng = cleaned.substring(engStartIdx);
    const cnIdx = afterEng.search(/[\u4e00-\u9fff]/);
    if (cnIdx >= 0) {
      // 有中文正文，从该位置往前回溯到行首（避免截断半个句子）
      let bodyStart = engStartIdx + cnIdx;
      while (bodyStart > engStartIdx && cleaned[bodyStart - 1] !== '\n') bodyStart--;
      cleaned = cleaned.substring(bodyStart);
    } else {
      // 整段都是英文思考，没有中文正文 → 丢弃全部
      cleaned = '';
    }
  }
  // 形态 4：中文思考泄漏——模型用中文自言自语分析任务（如"我需要以 glm-5 的身份
  //   继续这场技术辩论""对方刚问了...""保持这个姿态"等），这是对自身策略的元描述，
  //   不会出现在真实辩论正文里。找首个「参与者X：」开头的行作为正文起点。
  const cnThinkIdx = cleaned.search(/^(我需要以|我需要先|让我来|我来分析|首先我需要|我以.{0,10}身份)/mi);
  if (cnThinkIdx >= 0) {
    // 在中文思考起点之后找「参与者X：」行（正文标志）
    const afterCnThink = cleaned.substring(cnThinkIdx);
    const bodyMatchCn = afterCnThink.match(/\n(参与者[A-Z][\s：])/);
    if (bodyMatchCn && bodyMatchCn.index >= 0) {
      cleaned = afterCnThink.substring(bodyMatchCn.index + 1);
    } else {
      // 没有正文行，整段都是中文思考 → 丢弃
      cleaned = '';
    }
  }
  // 形态 5：中文思考泄漏（qwen3.8-max 互评阶段）——模型以「我们需要回答用户」
  //   「我们需要基于辩论记录评价」「我们需要判断辩论中谁...」等复数第一人称自言自语
  //   开头，分析任务该怎么写、字数够不够、该投给谁、最后一行格式要怎样。
  //   这是对自身任务的元描述，不会出现在真实评价正文里。
  //   处理策略（优先级递减）：
  //   a) 找后续「参与者X：」开头的行 → 从该行保留（标准正文格式）
  //   b) 找引号内的评价正文（"参与者A：..." 或 「参与者A：..."）→ 提取引号内容
  //   c) 仅找到 win_res 行 → 保留该行（至少投票不丢）
  //   d) 以上都没有 → 返回空，让上层重试
  const cnThinkIdx2 = cleaned.search(/^(我们需要|我们要)(回答|基于|判断|分析|评价|决定|快速评估)/mi);
  if (cnThinkIdx2 >= 0) {
    const afterCnThink2 = cleaned.substring(cnThinkIdx2);
    // a) 标准正文行
    const bodyMatchCn2 = afterCnThink2.match(/\n(参与者[A-Z][\s：])/);
    if (bodyMatchCn2 && bodyMatchCn2.index >= 0) {
      cleaned = afterCnThink2.substring(bodyMatchCn2.index + 1);
    } else {
      // b) 引号内的评价正文（qwen 常把草稿写在引号里）
      const quoteMatch = afterCnThink2.match(/["\u300c\u201c]([^"\u300d\u201d]*参与者[A-Z][^"\u300d\u201d]*)["\u300d\u201d]/);
      if (quoteMatch && quoteMatch[1]) {
        cleaned = quoteMatch[1].trim();
      } else {
        // c) 仅 win_res 行
        const winMatch = afterCnThink2.match(/(win_res[:：]\s*[^\n\r，。 ]+)/i);
        if (winMatch && winMatch[1]) {
          cleaned = winMatch[1].trim();
        } else {
          // d) 整段都是思考，无可用正文 → 丢弃
          cleaned = '';
        }
      }
    }
  }
  cleaned = cleaned.trim();
  // 连接被远端意外关闭：把已收到的内容返回（可能为空），标记中断原因
  if (streamError && !interrupted) {
    interrupted = true;
    interruptedReason = '连接被服务端中断（' + (streamError.message || 'terminated') + '）';
  }
  if (streamError || interrupted || !doneSeen) {
    const error = new Error(interruptedReason || streamError?.message || '数据流提前结束，未收到完成标记');
    error.retryableStream = !full && !interruptedReason.startsWith('超过 ') && (transportError || (!streamError && !doneSeen));
    error.streamInterrupted = true;
    error.partialText = cleaned;
    throw error;
  }
  return {
    text: cleaned || reasoning,
    finishReason, doneSeen, interrupted, interruptedReason,
    // OpenAI 协议截断时 finish_reason 为 'length'，Anthropic 协议 stop_reason 为 'max_tokens'
    truncatedByToken: finishReason === 'length' || finishReason === 'max_tokens'
  };
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

function buildSystemPrompt(identifier, stepNum, totalSteps, anonymous) {
  let base, suffix;
  if (anonymous) {
    base = `你是一位知识渊博、逻辑清晰的辩论参与者。在这场辩论中，你的发言会以「${identifier}」为标识。请用中文回答。`;
    suffix = `\n\n注意：你的对手可能是人类专家，也可能是另一个 AI 模型——你无法确定对方的真实身份。请不要对对方的身份做任何假设，也不要试图点破对方”是不是 AI”，把注意力放在论点本身，自然地展开讨论。`;
  } else {
    base = `你是 ${identifier}，一位知识渊博、逻辑清晰的专家。请用中文回答。`;
    suffix = '';
  }
  // 禁止思考过程泄漏到正文：推理模型（如 glm-5）有时会把英文思考链
  // （”Let me analyze...” “Let me draft...”）写到 content 字段而非 reasoning_content，
  // 导致数万字思考占用 max_tokens、正文一行未写就被截断。
  var noThink = `\n\n重要：直接输出你的辩论发言正文。不要输出任何思考过程、内部独白、分析步骤或英文草稿（如”Let me analyze...”、”Let me draft...”、”Now I need to write...”等）。不要使用  标签。你的回复内容会直接作为辩论发言展示给观众，请像在公开论坛上发表观点一样直接书写。`;
  if (stepNum === 1) return `${base}${suffix}${noThink}\n\n现在请你直接针对问题给出你的全面分析和观点。`;
  return `${base}${suffix}${noThink}\n\n请基于之前的讨论继续深入分析，提出你的观点。`;
}

function buildUserPrompt(question, identifier, history, anonymous) {
  if (history.length === 0) return question;
  let context = `问题：${question}\n\n`;
  if (anonymous) context += `以下是辩论至今的发言记录（仅以中立标识展示，你不知道发言者是人还是 AI）：\n\n`;
  for (const entry of history) {
    const who = anonymous ? entry.label : entry.model;
    context += `---\n${who}:\n${entry.content}\n\n`;
  }
  context += `---\n\n现在轮到你（${identifier}）发言。请基于之前的所有发言继续深入分析，提出你的观点。`;
  return context;
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

// Anthropic 协议调用（OpenCode 支持 /v1/messages 端点）
// 与 OpenAI 兼容协议的差异：
//   - 端点 /v1/messages（非 /v1/chat/completions）
//   - 鉴权头 x-api-key + anthropic-version（非 Authorization: Bearer）
//   - system 提示词是顶层字段（非 messages 数组里的 role:system）
//   - 流式事件 content_block_delta / message_stop（非 data:[DONE]）
//   - 推理过程是 thinking_delta（非 reasoning_content），与正文天然分离
async function callAnthropic(baseUrl, apiKey, modelId, messages, temperature, maxTokens, debateId, modelName, round) {
  const url = `${(baseUrl || OPENCODE_BASE_URL).replace(/\/+$/, '')}/messages`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'x-opencode-session': opencodeSession([debateId, modelName || modelId])
  };
  // Anthropic: system 是顶层字段，从 messages 里抽出来
  let systemContent = '';
  const userMessages = [];
  for (const m of messages) {
    if (m.role === 'system') systemContent += (systemContent ? '\n' : '') + m.content;
    else userMessages.push({ role: m.role, content: m.content });
  }
  const body = {
    model: modelId,
    messages: userMessages,
    max_tokens: maxTokens,
    temperature,
    stream: true
  };
  if (systemContent) body.system = systemContent;
  return requestModelText({ url, options: { method: 'POST', headers, body: JSON.stringify(body) }, protocol: 'anthropic' }, debateId, modelName, round, 'OpenCode(Anthropic)');
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


async function runJudge(debateId, session) {
  emit(debateId, 'judge-start', {});
  let t = `\u8fa9\u8bba\u95ee\u9898\uff1a${session.question}\n\n`;
  for (const entry of session.history) {
    t += `\n\u7b2c${entry.step}\u6b65 - ${entry.model}\uff1a\n${entry.content}\n`;
  }
  const msgs = [
    { role: 'system', content: `\u4f60\u662f\u4e00\u540d\u516c\u6b63\u7684\u8fa9\u8bba\u88c1\u5224\u3002\u8bf7\u6839\u636e\u4ee5\u4e0b\u7ef4\u5ea6\u5bf9\u6bcf\u4f4d\u8fa9\u624b\u8bc4\u5206\uff081-10\u5206\uff09\uff0c\u5e76\u9009\u51fa\u603b\u51a0\u519b\u3002\n\n\u8bc4\u5206\u7ef4\u5ea6\uff1a\n1. \u903b\u8f91\u6027\u548c\u8bba\u8bc1\u8d28\u91cf\n2. \u77e5\u8bc6\u6df1\u5ea6\u548c\u5e7f\u5ea6\n3. \u8bf4\u670d\u529b\u548c\u8868\u8fbe\u529b\n4. \u56de\u5e94\u4ed6\u4eba\u89c2\u70b9\u7684\u80fd\u529b\n5. \u521b\u9020\u6027\u548c\u6d1e\u5bdf\u529b\n\n\u683c\u5f0f\u8981\u6c42\uff1a\n\u8fa9\u624b\u8bc4\u5206\uff1a\n- \u6a21\u578b\u540d: \u5206\u6570\n...\n\u51a0\u519b\uff1a\u6a21\u578b\u540d\n\u8bc4\u8bed\uff1a...` },
    { role: 'user', content: t }
  ];
  try {
    const judgeModelId = session.judgeModel || session.models[0].id;
    const judgeConfig = session.judgeConfig || getModelCallConfig(session.models[0]);
    // 裁判若是推理模型，思考过程同样会吃光预算，沿用自动放大逻辑
    const judgeEffMax = effectiveMaxTokens(judgeModelId, 2048);
    const text = await callModel(judgeConfig, judgeModelId, msgs, 0.3, judgeEffMax, debateId, '裁判', session.rounds + 1);
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
  var anonymous = session.anonymous !== false;
  var transcript = "";
  for (var _i = 0; _i < session.history.length; _i++) {
    var _e = session.history[_i];
    var who = anonymous ? _e.label : _e.model;
    transcript += who + "（第" + _e.step + "步）:\n" + _e.content + "\n\n";
    if (_e.phase) transcript += `【${_e.phase}；对话对象：${_e.partner}】\n\n`;
  }
  session.evaluations = [];
  // 候选标识列表：匿名用「参与者X」，实名用真实模型名
  var candidates = anonymous && session.labels ? session.labels.slice() : session.models.map(function (m) { return m.name; });
  for (var _m = 0; _m < session.models.length; _m++) {
    var model = session.models[_m];
    var myId = (anonymous && session.labels) ? session.labels[_m] : model.name;
    // 候选名单（去掉自己）
    var opponents = candidates.filter(function (c) { return c !== myId; });
    var sysContent, userContent;
    var fmtRule = "\n\n格式要求：评价结束后，必须在最后一行给出最终投票，格式严格为「win_res：胜者标识」。胜者标识只能从以下候选中选一个：" + candidates.join("、") + "。例如：win_res：" + (opponents[0] || myId) + "。这一行必须完整且独立成行，不得缺省。";
    if (anonymous) {
      sysContent = "你刚刚以「" + myId + "」的身份参加了一场辩论，对手可能是人类专家，也可能是另一个 AI 模型，你无法确定对方的真实身份。请基于辩论记录，用中文简短评价每位发言者（包括你自己「" + myId + "」）的表现，最后投票评出胜者。请始终使用「参与者X」这样的中立标识，不要猜测或编造对方的真实身份。控制在200字以内。\n\n重要要求：\n1. 不要输出思考过程、内部独白或任何 <think> 标签内容——直接给出最终评价。\n2. 不要逐条复述辩论内容，直接给出你的评价结论。\n3. 必须确保最后能输出「win_res：胜者标识」这一行，这是最关键的。" + fmtRule;
      userContent = "辩论问题：" + session.question + "\n\n完整辩论记录（仅以中立标识展示）：\n" + transcript + "\n\n请直接给出每位发言者的评价结论（不要思考过程、不要复述辩论），并在最后一行用「win_res：胜者标识」投票评出胜者。";
    } else {
      sysContent = "你是 " + model.name + "，你刚刚参加了一场多模型辩论。请基于辩论记录，用中文简短评价每个模型的表现（包括你自己），最后投票评出胜者。控制在200字以内。\n\n重要要求：\n1. 不要输出思考过程、内部独白或任何 <think> 标签内容——直接给出最终评价。\n2. 不要逐条复述辩论内容，直接给出你的评价结论。\n3. 必须确保最后能输出「win_res：胜者标识」这一行，这是最关键的。" + fmtRule;
      userContent = "辩论问题：" + session.question + "\n\n完整辩论记录：\n" + transcript + "\n\n请直接给出每个模型的评价结论（不要思考过程、不要复述辩论），并在最后一行用「win_res：胜者标识」投票评出胜者。";
    }
    if (session.protocol) {
      sysContent = `你是${myId}，现在进行最终互评。所有候选者回答的是同一个用户问题。逐个评价候选者，包括自己；为每人引用至少一处具体回答步骤，主要比较正确性、完整性、相关性和论证依据，选出回答最好者。区分真实错误、合理补充和待核验争议，不照搬回答中的能力判断。不要虚构工具验证，正文控制在800字以内。\n实验统一评价规则：${session.rubric || experimentProtocol.rubric}` + fmtRule;
    }
    var msgs = [
      { role: "system", content: sysContent },
      { role: "user", content: userContent }
    ];
    var callConfig = getModelCallConfig(model);
    // 互评阶段也需要对推理模型放大 max_tokens——思考过程同样会吃光预算
    var effMax = effectiveMaxTokens(model.id, 2048);
    var text = '';
    async function requestEvaluation(messages, budget, round) {
      try {
        return { text: await callModel(callConfig, model.id, messages, 0.3, budget, debateId, model.name, round), truncated: false };
      } catch (error) {
        if (!error.evaluationTruncated && error.code !== 'EMPTY_MODEL_TEXT') throw error;
        return { text: error.partialText || '', truncated: !!error.evaluationTruncated };
      }
    }
    if (session.experimentId) emit(debateId, 'model-start', { model: model.name, round: 'eval' });
    try {
      var result = await requestEvaluation(msgs, effMax, 'eval');
      text = result.text;
      // 兜底重试：若返回为空（思考泄漏被全部剥光）或没抠到 win_res，
      // 用更短更强制的提示再要一次。这种情况常见于推理模型把预算花在思考、
      // 或把思考伪装成正文写到 content 被 readStream 清理掉后剩空。
      // 提取 win_res：要求在行首（允许 ** 前缀），避免误匹配思考段落中间
      // 出现的伪 win_res。捕获整行后统一清理 * 和内部空格（如「参与者 A」→「参与者A」）。
      function extractWinRes(s) {
        if (!s) return "";
        var m = s.match(/(?:^|\n)\*{0,2}\s*win_res[:：]\s*([^\n\r]+)/i);
        if (!m) return "";
        var raw = m[1].replace(/\*+/g, '').trim();
        // 「参与者 A」→「参与者A」
        raw = raw.replace(/^参与者\s+([A-Z])/, '参与者$1');
        // 截到首个标点为止（防止「参与者B。中文冒号？」这类尾随内容）
        raw = raw.replace(/[，。？！,;；].*$/, '').trim();
        return candidates.includes(raw) ? raw : '';
      }
      var winRes = result.truncated ? '' : extractWinRes(text);
      if (!winRes) {
        var retrySys = "只做一件事：直接输出最终投票，不要任何思考、分析、编号列表或  标签。控制在 80 字以内，最后一行严格为「win_res：胜者标识」。胜者标识只能从这些候选中选一个：" + candidates.join("、") + "。";
        if (session.protocol) retrySys += '\n' + experimentProtocol.rubric;
        var retryUser = "辩论问题：" + session.question + "\n\n辩论记录（简版，仅标识）：\n" + transcript + "\n\n直接给出最终投票，最后一行必须是「win_res：胜者标识」。";
        var retryMsgs = [ { role: "system", content: retrySys }, { role: "user", content: retryUser } ];
        if (session.experimentId) emit(debateId, 'model-start', { model: model.name, round: 'eval-retry' });
        var retryBudget = Math.min(effMax * 2, 65536);
        var retryResult = await requestEvaluation(retryMsgs, retryBudget, 'eval-retry');
        winRes = retryResult.truncated ? '' : extractWinRes(retryResult.text);
        if (winRes) {
          text = retryResult.text;
        } else {
          text += '\n\n**提高预算后重新互评仍失败**：\n\n' + retryResult.text;
          const error = new Error('提高输出预算后仍未取得完整有效投票；停止实验，避免缺票排名');
          error.partialText = text;
          throw error;
        }
      }
      session.evaluations.push({ model: model.name, evaluation: text, winRes: winRes });
      emit(debateId, "model-evaluation", { model: model.name, evaluation: text, winRes: winRes });
    } catch (err) {
      const evaluation = ((err.partialText || text) ? (err.partialText || text) + '\n\n' : '') + "评价失败: " + err.message;
      session.evaluations.push({ model: model.name, evaluation, winRes: "" });
      emit(debateId, "model-evaluation", { model: model.name, evaluation, winRes: "" });
      if (err.streamInterrupted || session.experimentId) {
        session.aborted = true;
        session.evaluationError = err.message;
        emit(debateId, 'model-error', { model: model.name, round: 'eval', error: err.message, partialText: err.partialText || '' });
        throw err;
      }
    }
  }
}

async function startDebate(debateId) {
  const s = sessions.get(debateId);
  if (!s) return;
  s.status = 'running';
  s.history = [];
  s.aborted = false;
  // 为每个参与方分配一个中立标识（参与者A、参与者B…），匿名模式下用其替代真实模型名，避免泄露身份
  s.labels = s.models.map(function (_, i) { return '参与者' + String.fromCharCode(65 + i); });
  const anonymous = s.anonymous !== false;
  const totalSteps = s.protocol ? experimentProtocol.totalSteps(s.rounds, s.models.length) : s.rounds * s.models.length;
  emit(debateId, 'debate-start', { question: s.question, models: s.models, totalSteps: totalSteps, anonymous: anonymous });
  for (let step = 0; step < totalSteps; step++) {
    const modelIdx = step % s.models.length;
    const model = s.models[modelIdx];
    const currentLabel = s.labels[modelIdx];
    const identifier = anonymous ? currentLabel : model.name;
    const turnNum = step + 1;
    const turn = s.protocol ? experimentProtocol.turnFor(step, s.models.length) : null;
    const phase = turn?.phase || '讨论中';
    const partner = turn?.partnerIndex != null ? s.labels[turn.partnerIndex] : '';
    emit(debateId, 'round-start', { turn: turnNum, totalTurns: totalSteps, model: model.name, phase, partner });
    const msgs = turn ? experimentProtocol.messagesFor(s.question, s.labels, s.history, turn, s.wordLimit) : [
      { role: 'system', content: buildSystemPrompt(identifier, turnNum, totalSteps, anonymous) },
      { role: 'user', content: buildUserPrompt(s.question, identifier, s.history, anonymous) }
    ];
    emit(debateId, 'model-start', { model: model.name, round: turnNum, phase, partner });
    const callConfig = getModelCallConfig(model);
    // 推理模型自动放大 max_tokens（思考过程需要），非推理模型沿用用户的设置值
    const effMax = effectiveMaxTokens(model.id, s.maxTokens);
    try {
      const text = await callModel(callConfig, model.id, msgs, s.temperature, effMax, debateId, model.name, turnNum);
      s.history.push({ model: model.name, label: currentLabel, step: turnNum, content: text,
        ...(turn ? { exchangeRound: turn.exchangeRound, kind: turn.kind, phase, partner } : {}) });
      emit(debateId, 'model-done', { model: model.name, round: turnNum, fullText: text, phase, partner });
    } catch (err) {
      const partial = err.partialText || '';
      s.history.push({ model: model.name, label: currentLabel, step: turnNum, content: (partial ? partial + '\n\n' : '') + '[' + model.name + '] \u751f\u6210\u5931\u8d25: ' + err.message });
      emit(debateId, 'model-error', { model: model.name, round: turnNum, error: err.message, partialText: partial });
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
    if (s.aborted) {
      s.status = 'aborted';
      emit(debateId, 'debate-end', { aborted: true, errorMessage: s.evaluations.at(-1)?.evaluation || '互评中断' });
    } else if (s.skipJudge) {
      emit(debateId, 'debate-end', { judgeText: '', scores: {}, winner: '', evaluations: s.evaluations || [] });
    } else {
      try {
        await runJudge(debateId, s);
        emit(debateId, 'debate-end', { judgeText: s.judgeResult.judgeText, scores: s.judgeResult.scores, winner: s.judgeResult.winner, evaluations: s.evaluations || [] });
      } catch (e) {
        emit(debateId, 'debate-end', { judgeText: '\u88c1\u5224\u5931\u8d25', scores: {}, winner: '', evaluations: s.evaluations || [] });
      }
    }
  }
  try {
    const dir = path.join(projectRoot, 'debates');
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
    const now = new Date();
    const filename = now.getFullYear() + '-' +
      String(now.getMonth()+1).padStart(2,'0') + '-' +
      String(now.getDate()).padStart(2,'0') + '_' +
      String(now.getHours()).padStart(2,'0') + '-' +
      String(now.getMinutes()).padStart(2,'0') + '-' +
      String(now.getSeconds()).padStart(2,'0') + '-' + debateId.slice(0, 8) + '.md';
    let md = '# LLM \u8fa9\u8bba\u8bb0\u5f55\n\n';
    if (s.aborted) md += '**状态**: ❌ 辩论因错误中断\n\n';
    md += '**\u95ee\u9898**: ' + s.question + '\n\n';
    md += '**\u53c2\u4e0e\u6a21\u578b**: ' + s.models.map(m => m.name).join(', ') + '\n\n---\n\n';
    if (s.protocol) md += `**实验协议**: ${s.protocol}\n\n**评价规则**: ${s.rubric || experimentProtocol.rubric}\n\n---\n\n`;
    for (let i = 0; i < s.history.length; i++) {
      md += '## \u7b2c' + (i+1) + '\u6b65 - ' + s.history[i].model + '\n\n';
      if (s.history[i].phase) md += `**环节**: ${s.history[i].phase}${s.history[i].partner ? '；**对话对象**: ' + s.history[i].partner : ''}\n\n`;
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
    s.recordFile = filename;
    console.log('Debate saved: ' + filename);
  } catch (e) { console.error('Save failed:', e.message); }
  return s;
}

function saveExperiment(experiment) {
  const dir = path.join(projectRoot, 'experiments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, experiment.id + '.json'), JSON.stringify(experiment, null, 2), 'utf8');
  if (experiment.status === 'completed') {
    try { updateRankingSummary(); }
    catch (error) { console.error('排名汇总更新失败:', error.message); }
  }
}

async function runExperiment(experiment, models) {
  experiment.status = 'running';
  saveExperiment(experiment);
  try {
    let remaining = models.slice();
    for (let stageIndex = 0; remaining.length > 1; stageIndex++) {
      const stage = { position: stageIndex + 1, candidates: remaining.map(m => m.name), votes: {}, runs: [], winner: null, tiebreaks: 0 };
      for (const model of remaining) stage.votes[model.name] = 0;
      experiment.stages.push(stage);
      let plannedRepeats = experiment.repetitions;
      for (let repeat = 0; repeat < plannedRepeats; repeat++) {
        const tiebreak = Math.max(0, repeat - experiment.repetitions + 1);
        const discussionRounds = experiment.rounds + tiebreak;
        for (let questionIndex = 0; questionIndex < experiment.questions.length; questionIndex++) {
          const debateId = crypto.randomUUID();
          // 轮换发言顺序，降低固定首位带来的偏差。
          const offset = (repeat * experiment.questions.length + questionIndex) % remaining.length;
          const orderedModels = remaining.slice(offset).concat(remaining.slice(0, offset));
          experiment.current = {
            debateId, stage: stageIndex + 1, repeat: repeat + 1, tiebreak, discussionRounds,
            questionIndex: questionIndex + 1, question: experiment.questions[questionIndex],
            speakerOrder: orderedModels.map(m => m.name), step: 0,
            totalSteps: experimentProtocol.totalSteps(discussionRounds, orderedModels.length),
            model: '', phase: '准备中', text: '', speeches: [], evaluations: []
          };
          experimentChats.set(experiment, { debateId, messages: [] });
          const session = {
            id: debateId, question: experiment.questions[questionIndex], models: orderedModels,
            rounds: discussionRounds, temperature: experiment.temperature,
            maxTokens: experiment.maxTokens, anonymous: experiment.anonymous,
            status: 'pending', history: [], evaluations: [], createdAt: Date.now(),
            captureEvents: false, skipJudge: true, experimentId: experiment.id,
            protocol: experiment.protocol, wordLimit: experiment.wordLimit, rubric: experiment.rubric
          };
          sessions.set(debateId, session);
          sseClients.set(debateId, new Set());
          let finished;
          try {
            finished = await startDebate(debateId);
          } finally {
            sessions.delete(debateId);
            sseClients.delete(debateId);
          }
          if (finished.aborted) throw new Error(`第 ${stageIndex + 1} 阶段第 ${repeat + 1} 次，辩题 ${questionIndex + 1} 的辩论中断；已保留之前的结果${finished.evaluationError ? '：' + finished.evaluationError : ''}`);
          const votes = {};
          for (const model of remaining) votes[model.name] = 0;
          const individualVotes = (finished.evaluations || []).map(ev => {
            let chosen = ev.winRes || '';
            if (finished.anonymous && /^参与者[A-Z]$/.test(chosen)) {
              chosen = orderedModels[chosen.charCodeAt(3) - 65]?.name || '';
            }
            if (!Object.hasOwn(votes, chosen)) chosen = '';
            if (chosen) { votes[chosen]++; stage.votes[chosen]++; }
            return { voter: ev.model, chosen: chosen || null };
          });
          stage.runs.push({ debateId, recordFile: finished.recordFile || null, questionIndex: questionIndex + 1, repeat: repeat + 1, tiebreak, discussionRounds, speakerOrder: orderedModels.map(m => m.name), votes, individualVotes,
            exchanges: finished.history.map(entry => ({ step: entry.step, model: entry.model, label: entry.label, round: entry.exchangeRound, kind: entry.kind, phase: entry.phase, partner: entry.partner })) });
          experiment.completedDebates++;
          experiment.updatedAt = new Date().toISOString();
          saveExperiment(experiment);
        }
        if (repeat === plannedRepeats - 1) {
          const maxVotes = Math.max(...Object.values(stage.votes));
          const leaders = Object.keys(stage.votes).filter(name => stage.votes[name] === maxVotes);
          if (maxVotes === 0) throw new Error(`第 ${stage.position} 阶段没有有效投票；请检查模型互评输出`);
          if (leaders.length > 1 && stage.tiebreaks < 5) {
            stage.tiebreaks++;
            plannedRepeats++;
            experiment.totalDebates += experiment.questions.length;
            experiment.updatedAt = new Date().toISOString();
            saveExperiment(experiment);
          }
        }
      }
      const maxVotes = Math.max(...Object.values(stage.votes));
      const leaders = Object.keys(stage.votes).filter(name => stage.votes[name] === maxVotes);
      if (leaders.length !== 1) {
        experiment.status = 'tied';
        experiment.tie = { position: stage.position, models: leaders, reason: '已完成 5 次加赛，累计最高票仍并列' };
        experiment.updatedAt = new Date().toISOString();
        saveExperiment(experiment);
        return;
      }
      stage.winner = leaders[0];
      experiment.ranking.push(leaders[0]);
      remaining = remaining.filter(m => m.name !== leaders[0]);
      saveExperiment(experiment);
    }
    experiment.ranking.push(remaining[0].name);
    experiment.status = 'completed';
  } catch (error) {
    experiment.status = 'failed';
    experiment.error = error.message;
  }
  experiment.updatedAt = new Date().toISOString();
  saveExperiment(experiment);
}

app.post('/api/experiments', (req, res) => {
  const { models, questions, repetitions = 1, rounds = 1, temperature = 0.7, maxTokens = 2048, wordLimit = 600 } = req.body;
  const names = Array.isArray(models) ? models.map(m => m.name) : [];
  if (names.length < 2 || names.length > 4 || new Set(names).size !== names.length ||
      models.some(m => !m.id || !['deepseek', 'glm', 'opencode'].includes(m.provider))) {
    return res.status(400).json({ error: '请选择 2–4 个名称不重复且配置完整的模型' });
  }
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 10 || questions.some(q => typeof q !== 'string' || !q.trim() || q.length > 4000)) {
    return res.status(400).json({ error: '请提供 1–10 道非空辩题（每题不超过 4000 字）' });
  }
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 ||
      !Number.isInteger(rounds) || rounds < 1 || rounds > 10 ||
      !Number.isInteger(wordLimit) || wordLimit < 200 || wordLimit > 2000 ||
      typeof temperature !== 'number' || temperature < 0 || temperature > 2 ||
      !Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 65536 ||
      questions.length * repetitions * (names.length - 1) > 120) {
    return res.status(400).json({ error: '实验参数超出范围或总场次超过 120 场' });
  }
  const id = crypto.randomUUID();
  const experiment = {
    id, status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    models: models.map(m => ({ id: m.id, name: m.name, provider: m.provider })),
    questions: questions.map(q => q.trim()), repetitions, rounds, temperature, maxTokens,
    anonymous: true, protocol: experimentProtocol.protocol, wordLimit, rubric: experimentProtocol.rubric,
    totalDebates: questions.length * repetitions * (names.length - 1),
    completedDebates: 0, stages: [], ranking: []
  };
  experiments.set(id, experiment);
  saveExperiment(experiment);
  setImmediate(() => runExperiment(experiment, models));
  res.status(202).json({ id });
});

app.get('/api/experiments', (req, res) => {
  const dir = path.join(projectRoot, 'experiments');
  const items = [];
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    try {
      const item = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const live = experiments.get(item.id) || item;
      items.push({ id: live.id, createdAt: live.createdAt, status: !experiments.has(item.id) && ['running', 'pending'].includes(live.status) ? 'interrupted' : live.status, models: live.models.map(m => m.name), completedDebates: live.completedDebates, totalDebates: live.totalDebates });
    } catch { /* 单个损坏记录不阻塞列表 */ }
  }
  res.json(items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get('/api/experiments/:id', (req, res) => {
  let experiment = experiments.get(req.params.id);
  if (!experiment && /^[0-9a-f-]{36}$/.test(req.params.id)) {
    const file = path.join(projectRoot, 'experiments', req.params.id + '.json');
    if (fs.existsSync(file)) {
      experiment = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (['pending', 'running'].includes(experiment.status)) {
        experiment.status = 'interrupted';
        experiment.error = '服务曾重启，实验未继续运行；已完成的场次仍保存在结果中';
      }
    }
  }
  if (!experiment) return res.status(404).json({ error: '实验不存在' });
  res.json({ ...experiment, liveChat: experimentChats.get(experiment) || null });
});

app.get('/api/debate-records/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/.test(filename)) {
    return res.status(400).send('无效的记录文件名');
  }
  const file = path.join(projectRoot, 'debates', filename);
  if (!fs.existsSync(file)) return res.status(404).send('记录不存在');
  res.type('text/plain; charset=utf-8').sendFile(file);
});

app.post('/api/test-connection', async (req, res) => {
  const { baseUrl, provider, apiKey } = req.body;
  const prov = provider;
  if (prov === 'deepseek') {
    const url = `${(baseUrl || DEEPSEEK_BASE_URL).replace(/\/+$/, '')}/models`;
    try {
      const headers = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const resp = await fetch(url, { headers });
      const data = await parseProviderResponse(resp);
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
      const data = await parseProviderResponse(resp);
      res.json({ success: true, models: (data.data || []).map(m => ({ id: m.id, name: m.id })) });
    } catch (err) { res.json({ success: false, error: err.message }); }
    return;
  }
  if (prov === 'opencode') {
    const url = `${(baseUrl || OPENCODE_BASE_URL).replace(/\/+$/, '')}/models`;
    try {
      // Anthropic 协议鉴权头：x-api-key + anthropic-version；会话头用于路由
      const headers = {};
      headers['User-Agent'] = 'llm-debate-arena/1.0';
      headers['x-opencode-session'] = opencodeSession(['test-connection']);
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (apiKey) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['x-opencode-session'] = opencodeSession(['test-connection']);
      }
      const resp = await fetch(url, { headers });
      const data = await parseProviderResponse(resp);
      res.json({ success: true, models: (data.data || []).map(m => ({ id: m.id, name: m.id })) });
    } catch (err) { res.json({ success: false, error: err.message }); }
    return;
  }
  res.status(400).json({ success: false, error: `不支持的 Provider: ${prov || '未指定'}` });
});

// 单模型可用性测试：发一次最小推理调用（非流式），判断模型真正可用与否
app.post('/api/test-model', async (req, res) => {
  const { provider, apiKey, baseUrl, modelId } = req.body;
  try {
    if (typeof modelId !== 'string' || !modelId.trim()) return res.status(400).json({ success: false, error: '请提供模型 ID' });
    const config = getModelCallConfig({ provider, apiKey, baseUrl });
    const request = providerProtocol.requestFor(provider, config.baseUrl, config.apiKey, modelId,
      [{ role: 'user', content: '请只回复 OK。' }], undefined, isReasoningModel(modelId) ? 4096 : 512, false,
      opencodeSession(['test-model', crypto.randomUUID()]));
    const resp = await fetchWithHandshakeTimeout(request.url, request.options, 30000);
    const data = await parseProviderResponse(resp);
    const reply = providerProtocol.responseText(data, request.protocol);
    if (!reply.trim()) throw new Error('接口已响应，但没有返回正文；可能是推理预算耗尽，不能确认模型可用');
    return res.json({ success: true, model: modelId, reply: reply.slice(0, 60), protocol: request.protocol });
  } catch (err) {
    const replacement = /deprecated[\s\S]*?Use\s+([\w.\/-]+)\s+instead/i.exec(err.message)?.[1];
    return res.json({ success: false, error: err.message, ...(replacement ? { deprecated: true, replacement } : {}) });
  }
});

app.post('/api/debate', (req, res) => {
  const { question, models, rounds = 3, temperature = 0.7, maxTokens = 2048, anonymous = true, judgeModel, judgeProvider, judgeApiKey, judgeBaseUrl } = req.body;
  if (!question || !models || models.length < 2) return res.status(400).json({ error: '\u9700\u8981\u81f3\u5c112\u4e2a\u6a21\u578b\u53c2\u4e0e\u8fa9\u8bba' });
  const id = crypto.randomUUID();
  const judgeConfig = judgeProvider ? getModelCallConfig({ provider: judgeProvider, baseUrl: judgeBaseUrl, apiKey: judgeApiKey }) : null;
  sessions.set(id, { id, question, models, rounds, temperature, maxTokens, anonymous: anonymous !== false, judgeModel: judgeModel || models[0].id, judgeConfig, status: 'pending', history: new Map(), judgeResult: null, createdAt: Date.now() });
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
try { updateRankingSummary(); }
catch (error) { console.error('排名汇总更新失败:', error.message); }
app.listen(PORT, () => {
  console.log(`🎯 LLM \u8fa9\u8bba\u7ade\u6280\u573a\u5df2\u542f\u52a8\uff01`);
  console.log(`   \u672c\u5730\u8bbf\u95ee: http://localhost:${PORT}`);
});
