// 重试链路端到端测试：
// mock 上游的 /flaky 路径前两次请求回 503、第三次起正常出流，
// 验证辩论不会因为瞬时 5xx 中途夭折，且 SSE 会广播 model-retry 事件。
// 用法：node scripts/retry-e2e-test.cjs
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MOCK_PORT = 9876;
const ARENA_PORT = 4567;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const ARENA_BASE = `http://127.0.0.1:${ARENA_PORT}`;

function writeSse(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

let flakyHits = 0;
const mock = http.createServer((req, res) => {
  const isFlaky = req.url.startsWith('/flaky/');
  const isStable = req.url.startsWith('/stable/');
  if (!isFlaky && !isStable) { res.writeHead(404).end(); return; }
  req.on('data', () => {});
  req.on('end', () => {
    if (isFlaky) {
      flakyHits++;
      if (flakyHits <= 2) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Endpoint is unavailable (mock 503)' } }));
        return;
      }
    }
    writeSse(res, 'pong');
  });
});

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`server not ready within ${timeoutMs}ms: ${url}`);
}

async function collectSseEvents(url, untilEvent, timeoutMs) {
  const events = [];
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`SSE connect failed: HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let timerHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timerHandle = setTimeout(() => reject(new Error(`timeout waiting for "${untilEvent}"`)), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = { event: '', data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev.event = line.slice(6).trim();
          else if (line.startsWith('data:')) ev.data += line.slice(5).trim();
        }
        if (ev.event) {
          try { ev.data = JSON.parse(ev.data); } catch {}
          events.push(ev);
          if (ev.event === untilEvent) return events;
        }
      }
    }
  } finally {
    clearTimeout(timerHandle);
    try { await reader.cancel(); } catch {}
  }
  return events;
}

// 删除本次测试生成的辩论存档，避免污染真实记录
function cleanupTestDebates() {
  const dir = path.join(__dirname, '..', 'debates');
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.mtimeMs < cutoff) continue;
    const content = fs.readFileSync(full, 'utf8');
    if (content.includes('测试辩题：排满还是留白')) fs.unlinkSync(full);
  }
}

(async () => {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const arena = spawn(process.execPath, ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(ARENA_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  arena.stdout.on('data', d => process.stdout.write('[arena] ' + d));
  arena.stderr.on('data', d => process.stderr.write('[arena] ' + d));

  try {
    await waitForReady(ARENA_BASE + '/', 15000);
    const startResp = await fetch(ARENA_BASE + '/api/debate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: '测试辩题：排满还是留白',
        rounds: 1,
        maxTokens: 64,
        anonymous: true,
        models: [
          { id: 'flaky-model', name: 'Flaky', provider: 'deepseek', baseUrl: MOCK_BASE + '/flaky' },
          { id: 'stable-model', name: 'Stable', provider: 'deepseek', baseUrl: MOCK_BASE + '/stable' }
        ],
        judgeModel: 'stable-model',
        judgeProvider: 'deepseek',
        judgeBaseUrl: MOCK_BASE + '/stable'
      })
    });
    if (!startResp.ok) throw new Error('start debate failed: HTTP ' + startResp.status);
    const { debateId } = await startResp.json();
    const events = await collectSseEvents(`${ARENA_BASE}/api/debate/${debateId}/stream`, 'debate-end', 90000);

    const retries = events.filter(e => e.event === 'model-retry' && e.data.model === 'Flaky');
    const flakyDone = events.find(e => e.event === 'model-done' && e.data.model === 'Flaky');
    const stableDone = events.find(e => e.event === 'model-done' && e.data.model === 'Stable');
    const end = events.find(e => e.event === 'debate-end');
    const pass = retries.length >= 2
      && !!flakyDone && /pong/.test(flakyDone.data.fullText || '')
      && !!stableDone && /pong/.test(stableDone.data.fullText || '')
      && !!end && end.data.aborted !== true
      && end.data.judgeText === 'pong';

    console.log(`flaky 503 hits: ${Math.min(flakyHits, 2)}, retry events: ${retries.length}`);
    console.log(`flaky completed: ${!!flakyDone}, stable completed: ${!!stableDone}, debate aborted: ${end ? !!end.data.aborted : 'n/a'}`);
    console.log(pass ? 'PASS: 瞬时 503 被自动重试救回，辩论完整结束' : 'FAIL: 重试链路未按预期工作');
    process.exitCode = pass ? 0 : 1;
  } finally {
    arena.kill();
    mock.close();
    cleanupTestDebates();
  }
})().catch(err => {
  console.error('TEST ERROR:', err.message);
  process.exitCode = 1;
  mock.close();
}).finally(() => {
  const code = process.exitCode || 0;
  setTimeout(() => process.exit(code), 500);
});
