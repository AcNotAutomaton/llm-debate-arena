function createEventHub({ sessions, sseClients, experiments, experimentChats }) {
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
  function captureModelToken(debateId, modelName, round, token) {
    const experiment = experiments.get(sessions.get(debateId)?.experimentId);
    if (experiment) updateExperimentChat(experiment, 'model-token', { model: modelName, round, token });
  }

  return { emit, captureModelToken };
}

module.exports = { createEventHub };
