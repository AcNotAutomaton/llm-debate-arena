const providerProtocol = require('../protocols/provider-protocol.cjs');
const { parseProviderResponse } = require('./http.cjs');
const READSTREAM_TIMEOUT_MS = 300000;

function createStreamReader({ emit, captureModelToken }) {
  async function readStream(resp, debateId, modelName, round, isAnthropic, isResponses = false) {
    if ((resp.headers.get('content-type') || '').includes('application/json')) {
      const data = await parseProviderResponse(resp);
      const text = providerProtocol.responseText(data, isAnthropic ? 'anthropic' : isResponses ? 'responses' : 'chat');
      if (!text.trim()) throw new Error('上游返回空正文，请检查模型权限或输出 token 预算');
      captureModelToken(debateId, modelName, round, text);
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
            captureModelToken(debateId, modelName, round, tok);
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

  return { readStream };
}

module.exports = { createStreamReader };
