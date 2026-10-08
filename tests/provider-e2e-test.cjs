const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { requestFor } = require('../src/protocols/provider-protocol.cjs');
const { updateRankingSummary } = require('../src/reports/ranking-summary.cjs');
const root = path.join(__dirname, '..');
const question = 'provider-e2e: 请修复前端错误';
let result, experimentId;
const seen = new Set();
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    try {
      const body = JSON.parse(raw);
      const expected = body.model.startsWith('qwen') ? '/messages' : body.model.startsWith('gpt') ? '/responses' : '/chat/completions';
      assert.equal(req.url, '/v1' + expected);
      assert.equal(req.headers['user-agent'], 'llm-debate-arena/1.0');
      assert.ok(req.headers['x-opencode-session']);
      assert.equal(expected === '/messages' ? req.headers['x-api-key'] : req.headers.authorization, expected === '/messages' ? 'mock-key' : 'Bearer mock-key');
      if (body.model === 'qwen3.7-max') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Model qwen3.7-max has been deprecated. Use qwen3.8-max instead.' } }));
      }
      const text = JSON.stringify(body).includes('win_res') ? 'win_res：参与者A' : 'OK';
      seen.add(expected);
      if (!body.stream) {
        assert.ok((body.max_tokens || body.max_output_tokens) >= 512);
        const output = body.model === 'empty' ? '' : text;
        const data = expected === '/messages' ? { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: output }] }
          : expected === '/responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] }
          : { choices: [{ message: { content: output } }] };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(data));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (expected === '/messages') {
        res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
        res.end('data: {"type":"message_stop"}\n\n');
      } else if (expected === '/responses') {
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`);
        res.end('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
      } else {
        // Terminal content and finish_reason in the same chunk; no trailing newline.
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}`);
      }
    } catch (error) {
      res.writeHead(500); res.end(error.message);
    }
  });
});
(async () => {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  const port = 4569;
  const base = `http://127.0.0.1:${port}`;
  const arena = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, '测试服务未启动');
    const post = async (endpoint, body) => (await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const modelIds = ['qwen3.8-max', 'kimi-k3', 'gpt-6-luna', 'glm-5.3'];
    for (const modelId of modelIds) {
      const test = await post('/api/test-model', { provider: 'opencode', baseUrl, apiKey: 'mock-key', modelId });
      assert.equal(test.success, true, test.error); assert.equal(test.reply, 'OK');
    }
    const deprecated = await post('/api/test-model', { provider: 'opencode', baseUrl, apiKey: 'mock-key', modelId: 'qwen3.7-max' });
    assert.equal(deprecated.success, false); assert.equal(deprecated.deprecated, true); assert.equal(deprecated.replacement, 'qwen3.8-max');
    const empty = await post('/api/test-model', { provider: 'opencode', baseUrl, apiKey: 'mock-key', modelId: 'empty' });
    assert.equal(empty.success, false); assert.match(empty.error, /没有返回正文/);
    const models = modelIds.map(id => ({ id, name: id, provider: 'opencode', baseUrl, apiKey: 'mock-key' }));
    const created = await post('/api/experiments', { models, questions: [question], rounds: 1, repetitions: 1, maxTokens: 512 });
    assert.ok(created.id, created.error); experimentId = created.id;
    for (let i = 0; i < 1200; i++) {
      result = await (await fetch(base + '/api/experiments/' + experimentId)).json();
      if (!['running', 'pending'].includes(result.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.ranking, modelIds);
    assert.equal(seen.size, 3);
    const req = requestFor('opencode', baseUrl + '/responses', 'mock-key', 'gpt-6-luna', [{ role: 'user', content: 'hi' }], 0.7, 512, true, 'test');
    assert.equal(req.url, baseUrl + '/responses');
    assert.equal(JSON.parse(req.options.body).temperature, undefined);
    console.log('PASS: 三种协议测试及四模型完整排名、末尾 SSE 正文、停用提示、空响应检测、会话与鉴权头');
  } finally {
    arena.kill();
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
    if (experimentId) fs.rmSync(path.join(root, 'experiments', experimentId + '.json'), { force: true });
    for (const run of (result?.stages || []).flatMap(s => s.runs)) {
      if (!run.recordFile) continue;
      const file = path.join(root, 'debates', run.recordFile);
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(question)) fs.unlinkSync(file);
    }
    updateRankingSummary(root);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
