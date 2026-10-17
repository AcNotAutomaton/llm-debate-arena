const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createApp } = require('../src/app.cjs');
const { createDebugRecordStore } = require('../src/storage/debug-records.cjs');
const { createRecordStore } = require('../src/storage/records.cjs');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-debug-record-test-'));
  const servers = [];
  try {
    const dir = path.join(root, 'debates');
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'order-checks'));
    const legacy = '# LLM 辩论记录\n\n**问题**: old question\nsecond line\n\n**参与模型**: Alpha, Beta\n\n---\n\n## 第1步 - Alpha\n\n<img src=x onerror=alert(1)>\n';
    const legacyFile = 'archive/2026-07-18_18-53-14.md';
    fs.writeFileSync(path.join(dir, legacyFile), legacy);
    fs.writeFileSync(path.join(dir, 'order-checks', 'skip.md'), legacy);
    fs.writeFileSync(path.join(dir, 'ranking.md'), legacy.replace('---', '**实验协议**: same-question-v6\n\n---'));
    fs.writeFileSync(path.join(dir, 'referenced.md'), legacy);
    const experimentId = crypto.randomUUID();
    const store = createRecordStore({ projectRoot: root, updateRankingSummary: () => {} });
    store.saveExperiment({ id: experimentId, status: 'completed', createdAt: new Date().toISOString(),
      models: [{ name: 'Alpha' }, { name: 'Beta' }], questions: ['ranking question'], ranking: ['Alpha', 'Beta'],
      stages: [{ runs: [{ recordFile: 'referenced.md' }] }] });

    let fail = false;
    const upstream = http.createServer((req, res) => {
      let raw = '';
      req.on('data', data => raw += data);
      req.on('end', () => {
        if (fail) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"mock unauthorized"}}'); }
        const body = JSON.parse(raw);
        const text = body.messages[0].content.includes('公正') ? '- Alpha: 9\n- Beta: 8\n冠军：Alpha\n评语：mock judge'
          : raw.includes('win_res') ? '评价内容\nwin_res：参与者B' : '完整回答 <script>mock</script>';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
      });
    });
    servers.push(upstream); await listen(upstream);
    const app = () => http.createServer(createApp({ projectRoot: root, updateRankingSummary: () => {} }));
    const server = app(); servers.push(server); await listen(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async url => {
      const response = await fetch(url); assert.equal(response.status, 200); return response.json();
    };
    const list = await get(base + '/api/records');
    assert.equal(list.length, 2, 'ranking runs and order-check archives must not appear as single debug records');
    const archived = list.find(record => record.legacy);
    assert.equal(archived.status, 'archived');
    const oldDetail = await get(base + '/api/records/' + archived.id);
    assert.equal(oldDetail.rawMarkdown, legacy);
    assert.equal(oldDetail.rounds, undefined);
    assert.equal(oldDetail.speakerOrder, undefined);
    assert.equal(await (await fetch(base + '/api/records/' + archived.id + '/markdown')).text(), legacy);
    assert.equal((await fetch(base + '/api/records/legacy-..%2F..%2Fsecret')).status, 404);

    const models = ['Alpha', 'Beta'].map(name => ({ id: name.toLowerCase(), name, provider: 'deepseek',
      apiKey: 'must-not-be-persisted', baseUrl: `http://127.0.0.1:${upstream.address().port}` }));
    async function debate(question) {
      const response = await fetch(base + '/api/debate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, models, rounds: 1, temperature: 0.7, maxTokens: 2048 }) });
      const { debateId } = await response.json();
      const stream = await fetch(base + '/api/debate/' + debateId + '/stream');
      const reader = stream.body.getReader(); const decoder = new TextDecoder(); let events = '';
      const timer = setTimeout(() => reader.cancel(), 15000);
      try {
        while (!events.includes('event: debate-end\n')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          events += decoder.decode(chunk.value, { stream: true });
        }
        assert.match(events, /event: debate-end\n/);
        return { debateId, events };
      } finally { clearTimeout(timer); await reader.cancel(); }
    }
    const completed = await debate('single debug question');
    const id = 'debug-' + completed.debateId;
    const detail = await get(base + '/api/records/' + id);
    assert.equal(detail.type, 'debug');
    assert.equal(detail.status, 'completed');
    assert.equal(detail.history.length, 2);
    assert.equal(detail.evaluations.length, 2);
    assert.deepEqual(detail.votes, { Alpha: 0, Beta: 2 });
    assert.ok(detail.individualVotes.every(vote => vote.chosen === 'Beta'));
    assert.equal(detail.judgeResult.winner, 'Alpha');
    const saved = fs.readFileSync(path.join(dir, id + '.json'), 'utf8');
    assert.ok(!saved.includes('must-not-be-persisted') && !saved.includes('baseUrl') && !saved.includes('apiKey'));
    assert.ok(!saved.includes('liveChat'));
    assert.equal((await get(base + '/api/records')).filter(record => record.type === 'debug').length, 2, 'JSON and Markdown must not duplicate');
    assert.equal((await get(base + '/api/experiments')).length, 1, 'existing experiment endpoint remains ranking-only');
    assert.equal((await get(base + '/api/experiments/' + experimentId)).id, experimentId);

    fail = true;
    const failed = await debate('failed debug question');
    const failedRecord = await get(base + '/api/records/debug-' + failed.debateId);
    assert.equal(failedRecord.status, 'failed');
    assert.equal(failedRecord.history.length, 1);
    assert.match(failedRecord.error, /mock unauthorized/);
    assert.match(failedRecord.history[0].content, /生成失败/);
    const restarted = app(); servers.push(restarted); await listen(restarted);
    const restartBase = `http://127.0.0.1:${restarted.address().port}`;
    assert.deepEqual(await get(restartBase + '/api/records/' + id), detail);
    assert.equal((await get(restartBase + '/api/records')).length, 4);
    const debugStore = createDebugRecordStore({ projectRoot: root });
    assert.equal(debugStore.markdownPath('../secret.md'), null);
    assert.equal(debugStore.save({ experimentId: 'ranking' }), undefined);
    console.log('PASS: completed/failed debug history, vote identity mapping, no credentials, persistence/restart, legacy archives, duplicate exclusion and ranking compatibility');
  } finally {
    await Promise.all(servers.map(close));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
