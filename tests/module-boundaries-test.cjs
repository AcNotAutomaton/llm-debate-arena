const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createRuntime } = require('../src/runtime/state.cjs');
const { createEventHub } = require('../src/runtime/events.cjs');
const { createRecordStore } = require('../src/storage/records.cjs');
const { createApp } = require('../src/app.cjs');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
});

(async () => {
  const first = createRuntime(), second = createRuntime();
  const id = crypto.randomUUID();
  const experiment = { id, current: { debateId: 'debate', speeches: [], evaluations: [], text: '' } };
  first.experiments.set(id, experiment);
  first.sessions.set('debate', { experimentId: id });
  first.sseClients.set('debate', new Set());
  first.experimentChats.set(experiment, { debateId: 'debate', messages: [] });
  const events = createEventHub(first);
  events.emit('debate', 'model-start', { model: 'Alpha', round: 1 });
  events.captureModelToken('debate', 'Alpha', 1, 'raw text');
  events.emit('debate', 'model-token', { model: 'Alpha', round: 1, token: 'raw text' });
  events.emit('debate', 'model-token', { model: 'Alpha', round: 1, token: 'reason', type: 'reasoning' });
  const chat = first.experimentChats.get(experiment);
  assert.equal(chat.messages[0].text, 'raw text', 'raw and display events must not duplicate live text');
  assert.equal(chat.messages[0].reasoning, 'reason');
  assert.equal(second.sessions.size, 0);
  assert.equal(second.experiments.size, 0);
  assert.equal(second.experimentChats.get(experiment), undefined);
  assert.equal(first.sessions.get('debate').eventBuffer.length, 3);
  const sent = [];
  first.sseClients.get('debate').add({ write: message => sent.push(message) });
  events.emit('debate', 'debate-end', { aborted: true });
  assert.match(sent[0], /^event: debate-end\ndata: /);
  assert.equal(chat.messages[0].state, 'failed');
  assert.equal(experiment.liveChat, undefined, 'live chat must remain outside experiment JSON');

  const apiSource = fs.readFileSync(path.join(__dirname, '../public/core/api.js'), 'utf8');
  const api = await import('data:text/javascript;base64,' + Buffer.from(apiSource).toString('base64'));
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;
  try {
    globalThis.fetch = async () => new Response('not JSON', { status: 503 });
    await assert.rejects(api.fetchJSON('/api/experiments', undefined, '无法读取实验记录'), /无法读取实验记录/);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: '记录不存在' }), { status: 404 });
    await assert.rejects(api.readExperiment('unknown'), /记录不存在/);
    let requested;
    globalThis.fetch = async url => { requested = url; return new Response(JSON.stringify({ id: 'saved' })); };
    assert.equal((await api.readExperiment('a/b')).id, 'saved');
    assert.equal(requested, '/api/experiments/a%2Fb');
    globalThis.EventSource = class { constructor(url) { this.url = url; } };
    assert.equal(api.openDebateStream('a/b').url, '/api/debate/a%2Fb/stream');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalEventSource;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-module-test-'));
  const servers = [];
  try {
    const saved = { id, status: 'pending', createdAt: new Date().toISOString(), questions: ['same question'],
      models: [{ id: 'alpha', name: 'Alpha', provider: 'glm' }], ranking: [], completedDebates: 0, totalDebates: 1 };
    let summaries = 0;
    const store = createRecordStore({ projectRoot: root, updateRankingSummary: () => summaries++ });
    store.saveExperiment(saved);
    assert.equal(store.readExperiment(id).status, 'interrupted');
    assert.equal(saved.status, 'pending');
    assert.equal(store.readExperiment('../invalid'), null);
    saved.status = 'completed';
    store.saveExperiment(saved);
    assert.equal(summaries, 1);
    assert.equal(store.listExperiments(new Map())[0].questionPreview, 'same question');
    fs.writeFileSync(path.join(root, 'experiments', crypto.randomUUID() + '.json'), '{broken');
    assert.equal(store.listExperiments(new Map()).length, 1);
    const live = { ...saved, status: 'running' };
    assert.equal(store.listExperiments(new Map([[id, live]]))[0].status, 'running');

    const session = { question: 'same question', models: saved.models, speakerOrder: ['Alpha'],
      history: [{ step: 1, model: 'Alpha', content: 'answer' }], evaluations: [], orderPolicy: 'fixed' };
    const filename = store.saveDebate('12345678-test', session);
    assert.match(filename, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-12345678\.md$/);
    assert.match(fs.readFileSync(store.debateRecordPath(filename), 'utf8'), /每轮回答顺序/);

    const observed = [];
    const upstream = http.createServer((req, res) => {
      observed.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    });
    servers.push(upstream);
    await listen(upstream);
    const roots = [root, path.join(root, 'other')];
    for (const projectRoot of roots) {
      const server = http.createServer(createApp({ projectRoot }));
      servers.push(server);
      await listen(server);
    }
    const base = `http://127.0.0.1:${servers[1].address().port}`;
    const other = `http://127.0.0.1:${servers[2].address().port}`;
    assert.equal((await (await fetch(base + '/api/experiments')).json()).length, 1);
    assert.deepEqual(await (await fetch(other + '/api/experiments')).json(), []);
    assert.equal((await fetch(other + '/api/experiments/' + id)).status, 404);
    assert.equal((await fetch(base + '/api/debate-records/invalid')).status, 400);
    assert.equal((await fetch(base + '/api/debate/unknown/stream')).status, 404);
    assert.equal((await fetch(base + '/api/debate-records/' + filename)).status, 200);
    for (const provider of ['deepseek', 'glm', 'opencode']) {
      const response = await fetch(base + '/api/test-connection', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, apiKey: 'mock-key',
          baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }) });
      assert.deepEqual(await response.json(), { success: true, models: [{ id: 'mock-model', name: 'mock-model' }] });
    }
    assert.ok(observed.every(request => request.url === '/v1/models' && request.headers.authorization === 'Bearer mock-key'));
    assert.equal(observed[2].headers['x-api-key'], 'mock-key');
    assert.ok(observed[2].headers['x-opencode-session']);
    const invalid = await fetch(base + '/api/test-connection', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'unknown' }) });
    assert.equal(invalid.status, 400);
    console.log('PASS: runtime/event isolation, nonpersistent live chat, frontend API module, record store, isolated app roots and provider catalog routes');
  } finally {
    await Promise.all(servers.map(close));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
