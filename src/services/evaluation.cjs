const experimentProtocol = require('../protocols/experiment-protocol.cjs');
const { effectiveMaxTokens } = require('../providers/token-budget.cjs');

function createEvaluationService({ emit, modelClient }) {
  const { callModel, getModelCallConfig } = modelClient;
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

  return { runJudge, evaluateModels };
}

module.exports = { createEvaluationService };
