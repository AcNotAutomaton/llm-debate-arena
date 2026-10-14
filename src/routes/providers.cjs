function registerProviderRoutes(app, catalog) {
  app.post('/api/test-connection', async (req, res) => {
    const provider = req.body.provider;
    if (!['deepseek', 'glm', 'opencode'].includes(provider)) {
      return res.status(400).json({ success: false, error: `不支持的 Provider: ${provider || '未指定'}` });
    }
    try {
      res.json({ success: true, models: await catalog.listModels(req.body) });
    } catch (error) {
      res.json({ success: false, error: error.message });
    }
  });

  app.post('/api/test-model', async (req, res) => {
    const { modelId } = req.body;
    if (typeof modelId !== 'string' || !modelId.trim()) {
      return res.status(400).json({ success: false, error: '请提供模型 ID' });
    }
    try {
      res.json(await catalog.testModel(req.body));
    } catch (error) {
      const replacement = /deprecated[\s\S]*?Use\s+([\w.\/-]+)\s+instead/i.exec(error.message)?.[1];
      res.json({ success: false, error: error.message, ...(replacement ? { deprecated: true, replacement } : {}) });
    }
  });
}

module.exports = { registerProviderRoutes };
