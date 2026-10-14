const experimentProtocol = require('../protocols/experiment-protocol.cjs');
const { effectiveMaxTokens } = require('../providers/token-budget.cjs');
const { buildSystemPrompt, buildUserPrompt } = require('./prompts.cjs');

function createDebateService({ sessions, emit, modelClient, evaluation, recordStore }) {
  const { callModel, getModelCallConfig } = modelClient;
  const { runJudge, evaluateModels } = evaluation;
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
    s.speakerOrder = s.models.map(model => model.name);
    emit(debateId, 'debate-start', { question: s.question, models: s.models, speakerOrder: s.speakerOrder, totalSteps: totalSteps, anonymous: anonymous });
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
        s.history.push({ model: model.name, label: currentLabel, step: turnNum, answerPosition: modelIdx + 1, content: text,
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
    s.recordFile = recordStore.saveDebate(debateId, s);

    return s;
  }

  return { startDebate };
}

module.exports = { createDebateService };
