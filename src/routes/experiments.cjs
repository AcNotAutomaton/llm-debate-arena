function registerExperimentRoutes(app, { runtime, recordStore, experimentService }) {
  const { experiments, experimentChats } = runtime;
  app.post('/api/experiments', (req, res) => {
    const { models, questions, repetitions = 1, rounds = 1, temperature = 0.7, maxTokens = 2048, orderPolicy = 'rotate' } = req.body;
    if (!['rotate', 'fixed'].includes(orderPolicy)) {
      return res.status(400).json({ error: '回答顺序策略必须为逐场轮换或固定顺序' });
    }
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
        typeof temperature !== 'number' || temperature < 0 || temperature > 2 ||
        !Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 65536 ||
        questions.length * repetitions * (names.length - 1) > 120) {
      return res.status(400).json({ error: '实验参数超出范围或总场次超过 120 场' });
    }
    const id = experimentService.createExperiment({ models, questions, repetitions, rounds, temperature, maxTokens, orderPolicy });
    res.status(202).json({ id });
  });

  app.get('/api/experiments', (req, res) => {
    res.json(recordStore.listExperiments(experiments));
  });

  app.get('/api/experiments/:id', (req, res) => {
    const experiment = experiments.get(req.params.id) || recordStore.readExperiment(req.params.id);
    if (!experiment) return res.status(404).json({ error: '实验不存在' });
    res.json({ ...experiment, liveChat: experimentChats.get(experiment) || null });
  });
}

module.exports = { registerExperimentRoutes };
