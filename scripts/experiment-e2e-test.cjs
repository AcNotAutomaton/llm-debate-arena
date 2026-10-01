const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const mockPort = 9877;
const appPort = 4568;
const base = `http://127.0.0.1:${appPort}`;
const mockBase = `http://127.0.0.1:${mockPort}`;
const question = '实验端到端测试：请分析岩石风化的影响因素\n===\n这是同一提示词中的分隔线，请结合上文给出可验证的论证。';
const independentInputs = [];
const discussionInputs = [];
const experimentPrompts = [];
const { rubric } = require('../experiment-protocol.cjs');
const tieMode = process.env.TEST_TIE || '';
const voteCounts = { alpha: 0, beta: 0 };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const payload = JSON.parse(body);
    experimentPrompts.push(payload.messages[0].content);
    if (payload.messages[0].content.includes('独立回答给定问题')) independentInputs.push(payload.messages[1].content);
    if (payload.messages[0].content.includes('核查其他参与者的结论')) discussionInputs.push(payload.messages[1].content);
    const isVote = payload.messages[0].content.includes('win_res');
    const transcript = payload.messages[1].content;
    const stage = transcript.includes('来自 alpha 的发言') ? 'alpha' : 'beta';
    const voteNumber = isVote ? voteCounts[stage]++ : 0;
    const initialVotes = stage === 'alpha' ? 3 : 2;
    const preferred = isVote && (tieMode === 'always' || (tieMode === 'once' && voteNumber < initialVotes)) ? payload.model : stage;
    const chosenLabel = transcript.match(new RegExp(`参与者([A-Z])（第\\d+步）:\\n来自 ${preferred} 的发言`))?.[1];
    const content = isVote ? `评价完成。\nwin_res：参与者${chosenLabel}` : `来自 ${payload.model} 的发言`;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    }, isVote ? 100 : 220);
  });
});

async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('服务启动超时');
}

(async () => {
  await new Promise(resolve => mock.listen(mockPort, '127.0.0.1', resolve));
  const arena = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, PORT: String(appPort) }, stdio: 'ignore'
  });
  let experimentId;
  let recordFiles = [];
  let result;
  try {
    await ready();
    const response = await fetch(base + '/api/experiments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        models: [
          { id: 'alpha', name: 'Alpha', provider: 'deepseek', baseUrl: mockBase },
          { id: 'beta', name: 'Beta', provider: 'deepseek', baseUrl: mockBase },
          { id: 'gamma', name: 'Gamma', provider: 'deepseek', baseUrl: mockBase }
        ],
        questions: [question],
        repetitions: tieMode ? 1 : 2, rounds: 1, anonymous: true, maxTokens: 512
      })
    });
    assert.equal(response.status, 202);
    experimentId = (await response.json()).id;
    let sawRunningSpeech = false;
    for (let i = 0; i < 2400; i++) {
      result = await (await fetch(base + '/api/experiments/' + experimentId)).json();
      if (result.status === 'running' && result.current?.speeches?.length) sawRunningSpeech = true;
      if (result.status !== 'pending' && result.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    recordFiles = result.stages.flatMap(stage => stage.runs.map(run => run.recordFile).filter(Boolean));
    if (tieMode === 'always') {
      assert.equal(result.status, 'tied', result.error);
      assert.equal(result.completedDebates, 6);
      assert.equal(result.totalDebates, 7);
      assert.equal(result.stages[0].tiebreaks, 5);
      assert.equal(result.stages[0].runs.at(-1).discussionRounds, 6);
      assert.deepEqual(result.stages[0].votes, { Alpha: 6, Beta: 6, Gamma: 6 });
      assert.deepEqual(result.ranking, []);
      console.log('PASS: 持续平票最多加赛 5 次并保留并列结果');
      return;
    }
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.ranking, ['Alpha', 'Beta', 'Gamma']);
    assert.equal(Object.hasOwn(result, 'spearman'), false);
    assert.equal(Object.hasOwn(result, 'benchmarkOrder'), false);
    const recordsResponse = await fetch(base + '/api/experiments');
    assert.equal(recordsResponse.status, 200);
    const records = await recordsResponse.json();
    const saved = records.find(record => record.id === experimentId);
    assert.equal(saved.status, 'completed');
    assert.deepEqual(saved.models, ['Alpha', 'Beta', 'Gamma']);
    assert.equal(Object.hasOwn(saved, 'spearman'), false);
    assert.ok(!JSON.stringify(saved).includes('apiKey'));
    assert.equal(result.completedDebates, 4);
    assert.equal(result.totalDebates, result.completedDebates);
    assert.equal(result.stages[0].votes.Alpha, tieMode ? 4 : 6);
    assert.equal(result.stages[1].votes.Beta, tieMode ? 3 : 4);
    if (tieMode) {
      for (const stage of result.stages) {
        assert.equal(stage.tiebreaks, 1);
        assert.equal(stage.runs[1].tiebreak, 1);
        assert.equal(stage.runs[1].discussionRounds, 2);
      }
    }
    assert.equal(sawRunningSpeech, true);
    assert.equal(result.current.phase, '本场已结束');
    assert.equal(result.current.speeches.length, tieMode ? 6 : 4);
    assert.equal(result.current.evaluations.length, 2);
    assert.equal(result.protocol, 'prompt-discussion-v4');
    assert.equal(Object.hasOwn(result, 'domainLabel'), false);
    assert.equal(result.rubric, rubric);
    assert.ok(experimentPrompts.every(prompt => prompt.includes(rubric)), '独立回答、讨论和互评必须使用本实验标准');
    assert.ok(experimentPrompts.every(prompt => !prompt.includes('HTML/CSS/JavaScript')), '用户提示词不应混入固定前端提示');
    assert.equal(independentInputs.length, 10);
    assert.ok(independentInputs.every(input => input === question), '独立阶段不得包含其他模型答案');
    assert.equal(discussionInputs.length, tieMode ? 15 : 10);
    assert.ok(discussionInputs.every(input => input.includes('来自 ')), '讨论阶段必须看到独立回答');
    recordFiles = result.stages.flatMap(stage => stage.runs.map(run => run.recordFile).filter(Boolean));
    const recordResponse = await fetch(base + '/api/debate-records/' + recordFiles[0]);
    assert.equal(recordResponse.status, 200);
    const record = await recordResponse.text();
    assert.ok(record.includes(question), 'Markdown 必须保存完整多行提示词');
    assert.match(record, /来自 alpha 的发言/);
    assert.match(record, /win_res/);
    console.log('PASS: 实验运行过程、讨论记录、投票、排名（无需提供外部榜单）');
  } finally {
    arena.kill();
    await new Promise(resolve => mock.close(resolve));
    if (result?.stages) {
      recordFiles = result.stages.flatMap(stage => stage.runs.map(run => run.recordFile).filter(Boolean));
    }
    if (experimentId) {
      const resultFile = path.join(root, 'experiments', experimentId + '.json');
      if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
    }
    for (const filename of recordFiles) {
      const file = path.join(root, 'debates', filename);
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(question)) fs.unlinkSync(file);
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
