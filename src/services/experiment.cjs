const crypto = require('node:crypto');
const experimentProtocol = require('../protocols/experiment-protocol.cjs');

function createExperimentService({ runtime, startDebate, recordStore }) {
  const { sessions, sseClients, experiments, experimentChats } = runtime;
  const { saveExperiment } = recordStore;

  function createExperiment({ models, questions, repetitions, rounds, temperature, maxTokens, orderPolicy }) {
    const id = crypto.randomUUID();
    const experiment = {
      id, status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      models: models.map(m => ({ id: m.id, name: m.name, provider: m.provider })),
      questions: questions.map(q => q.trim()), repetitions, rounds, temperature, maxTokens, orderPolicy,
      anonymous: true, protocol: experimentProtocol.protocol, rubric: experimentProtocol.rubric,
      totalDebates: questions.length * repetitions * (models.length - 1),
      completedDebates: 0, stages: [], ranking: []
    };
    experiments.set(id, experiment);
    saveExperiment(experiment);
    setImmediate(() => runExperiment(experiment, models));
    return id;
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
            const offset = experiment.orderPolicy === 'fixed' ? 0
              : (repeat * experiment.questions.length + questionIndex) % remaining.length;
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
              protocol: experiment.protocol, rubric: experiment.rubric,
              orderPolicy: experiment.orderPolicy
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
              return { voter: ev.model, chosen: chosen || null,
                chosenPosition: chosen ? orderedModels.findIndex(model => model.name === chosen) + 1 : null };
            });
            stage.runs.push({ debateId, recordFile: finished.recordFile || null, questionIndex: questionIndex + 1, repeat: repeat + 1, tiebreak, discussionRounds, speakerOrder: orderedModels.map(m => m.name), votes, individualVotes,
              exchanges: finished.history.map(entry => ({ step: entry.step, model: entry.model, label: entry.label, answerPosition: entry.answerPosition, round: entry.exchangeRound, kind: entry.kind, phase: entry.phase, partner: entry.partner })) });
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

  return { createExperiment };
}

module.exports = { createExperimentService };
