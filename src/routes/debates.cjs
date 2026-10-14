const crypto = require('node:crypto');

function registerDebateRoutes(app, { runtime, startDebate, modelClient, recordStore }) {
  const { sessions, sseClients } = runtime;
  const { getModelCallConfig } = modelClient;
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

  app.get('/api/debate-records/:filename', (req, res) => {
    const filename = req.params.filename;
    if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/.test(filename)) {
      return res.status(400).send('无效的记录文件名');
    }
    const file = recordStore.debateRecordPath(filename);
    if (!file) return res.status(404).send('记录不存在');
    res.type('text/plain; charset=utf-8').sendFile(file);
  });
}

module.exports = { registerDebateRoutes };
