function registerRecordRoutes(app, records) {
  app.get('/api/records', (req, res) => res.json(records.list()));
  app.get('/api/records/:id', (req, res) => {
    const record = records.read(req.params.id);
    if (!record) return res.status(404).json({ error: '记录不存在' });
    res.json(record);
  });
  app.get('/api/records/:id/markdown', (req, res) => {
    const record = records.read(req.params.id);
    const file = record?.type === 'debug' && records.markdownPath(record.recordFile);
    if (!file) return res.status(404).json({ error: '记录不存在' });
    res.type('text/plain; charset=utf-8').sendFile(file);
  });
}

module.exports = { registerRecordRoutes };
