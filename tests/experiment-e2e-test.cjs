const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { updateRankingSummary } = require('../src/reports/ranking-summary.cjs');

const root = path.join(__dirname, '..');
const mockPort = 9877;
const appPort = 4568;
const base = `http://127.0.0.1:${appPort}`;
const mockBase = `http://127.0.0.1:${mockPort}`;
const question = '实验端到端测试：请分析岩石风化的影响因素\n===\n这是同一提示词中的分隔线，请结合上文给出可验证的论证。';
const phaseInputs = { answer: [], supplement: [] };
const experimentPrompts = [];
const { rubric } = require('../src/protocols/experiment-protocol.cjs');
const tieMode = process.env.TEST_TIE || '';
const voteCounts = { alpha: 0, beta: 0 };
let evaluationMode = '';
let evaluationRequests = [];
const additionalExperiments = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const payload = JSON.parse(body);
    experimentPrompts.push(payload.messages[0].content);
    const system = payload.messages[0].content;
    const phase = system.includes('· 独立回答。') ? 'answer' : system.includes('· 补充回答。') ? 'supplement' : '';
    if (phase) phaseInputs[phase].push(payload.messages[1].content);
    const isVote = payload.messages[0].content.includes('win_res');
    if (evaluationMode) {
      const retry = payload.messages[0].content.includes('只做一件事');
      if (isVote) evaluationRequests.push({ model: payload.model, budget: payload.max_tokens, retry });
      const fail = isVote && (!retry || evaluationMode.startsWith('always-'));
      const truncated = fail && evaluationMode.includes('truncated');
      const content = fail && evaluationMode.includes('empty') ? ''
        : fail && evaluationMode.includes('invalid') ? 'win_res：不存在的候选'
        : isVote ? '评价完成。\nwin_res：参与者A' : '测试发言';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: truncated ? 'length' : 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    const transcript = payload.messages[1].content;
    const stage = transcript.includes('来自 alpha 的发言') ? 'alpha' : 'beta';
    const voteNumber = isVote ? voteCounts[stage]++ : 0;
    const initialVotes = stage === 'alpha' ? 3 : 2;
    const preferred = isVote && (tieMode === 'always' || (tieMode === 'once' && voteNumber < initialVotes)) ? payload.model : stage;
    const chosenLabel = transcript.match(new RegExp(`参与者([A-Z])（第\\d+步）:\\n来自 ${preferred} 的发言`))?.[1];
    const content = isVote ? `评价完成。\nwin_res：参与者${chosenLabel}` : `来自 ${payload.model} 的发言`;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'live-only-thinking: 正在检查依据' } }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      }, 150);
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
  const arena = spawn(process.execPath, ['src/server.js'], {
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
    let sawThinking = false;
    let sawLiveText = false;
    for (let i = 0; i < 2400; i++) {
      result = await (await fetch(base + '/api/experiments/' + experimentId)).json();
      if (result.status === 'running' && result.current?.speeches?.length) sawRunningSpeech = true;
      if (result.liveChat?.messages.some(message => message.state === 'thinking' && message.reasoning.includes('live-only-thinking'))) sawThinking = true;
      if (result.liveChat?.messages.some(message => message.text.includes('来自 '))) sawLiveText = true;
      if (result.liveChat) assert.equal(result.liveChat.debateId, result.current.debateId, '聊天内容必须对应当前场次');
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
    assert.deepEqual(result.stages[0].candidates, ['Alpha', 'Beta', 'Gamma']);
    assert.deepEqual(result.stages[1].candidates, ['Beta', 'Gamma'], '第一名退出后，剩余模型重新比赛');
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
    assert.equal(sawThinking, true, '正文开始前必须能看到思考状态和内容');
    assert.equal(sawLiveText, true, '实时聊天必须包含正文');
    assert.ok(result.liveChat.messages.every(message => ['completed', 'failed'].includes(message.state)));
    assert.ok(result.liveChat.messages.some(message => message.round === 'eval' && message.text.includes('win_res')));
    assert.ok(result.liveChat.messages.filter(message => typeof message.round === 'number').every(message => message.text === `来自 ${message.model.toLowerCase()} 的发言`), '短正文应原样显示，不能重复累计');
    const persisted = fs.readFileSync(path.join(root, 'experiments', experimentId + '.json'), 'utf8');
    assert.ok(!persisted.includes('live-only-thinking'));
    assert.equal(Object.hasOwn(JSON.parse(persisted), 'liveChat'), false);
    assert.equal(result.current.phase, '本场已结束');
    assert.equal(result.current.speeches.length, tieMode ? 4 : 2);
    assert.equal(result.current.evaluations.length, 2);
    assert.equal(result.protocol, 'same-question-v6');
    assert.equal(Object.hasOwn(result, 'domainLabel'), false);
    assert.equal(result.rubric, rubric);
    assert.ok(experimentPrompts.every(prompt => prompt.includes(rubric)), '独立回答、讨论和互评必须使用本实验标准');
    assert.ok(experimentPrompts.every(prompt => !prompt.includes('HTML/CSS/JavaScript')), '用户提示词不应混入固定前端提示');
    for (const [phase, inputs] of Object.entries(phaseInputs)) {
      assert.equal(inputs.length, phase === 'answer' ? 10 : tieMode ? 5 : 0, '每人每轮回答一次：' + phase);
      assert.ok(inputs.every(input => input.includes(question)), '主题始终完整保留');
      if (phase === 'answer') assert.ok(inputs.every(input => input === question), '首轮所有模型只看到同一个原问题');
      else assert.ok(inputs.every(input => input.includes('来自 ')), '补充回答必须看到此前完整轮次');
    }
    for (const stage of result.stages) for (const run of stage.runs) {
      assert.equal(run.exchanges.length, run.discussionRounds * stage.candidates.length);
      for (const model of stage.candidates) {
        assert.equal(run.exchanges.filter(entry => entry.model === model && entry.kind === 'answer').length, 1);
        assert.equal(run.exchanges.filter(entry => entry.model === model && entry.kind === 'supplement').length, run.discussionRounds - 1);
      }
      assert.ok(run.exchanges.every(entry => !entry.partner));
      assert.ok(run.exchanges.every(entry => stage.candidates.includes(entry.model)));
    }
    recordFiles = result.stages.flatMap(stage => stage.runs.map(run => run.recordFile).filter(Boolean));
    const recordResponse = await fetch(base + '/api/debate-records/' + recordFiles[0]);
    assert.equal(recordResponse.status, 200);
    const record = await recordResponse.text();
    assert.ok(record.includes(question), 'Markdown 必须保存完整多行提示词');
    assert.match(record, /来自 alpha 的发言/);
    assert.match(record, /win_res/);
    assert.match(record, /same-question-v6/);
    assert.match(record, /独立回答/);
    assert.ok(!record.includes('**对话对象**'));
    assert.ok(!record.includes('live-only-thinking'), '临时思考过程不得写入 Markdown');
    console.log('PASS: 实验运行过程、讨论记录、投票、排名（无需提供外部榜单）');
    if (!tieMode) {
      for (const mode of ['truncated', 'invalid', 'empty', 'always-truncated', 'always-invalid']) {
        evaluationMode = mode;
        evaluationRequests = [];
        const created = await fetch(base + '/api/experiments', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            models: [
              { id: 'kimi-k3', name: 'Kimi', provider: 'deepseek', baseUrl: mockBase },
              { id: 'ordinary', name: 'Ordinary', provider: 'deepseek', baseUrl: mockBase }
            ],
            questions: [question + '\n互评预算测试：' + mode], repetitions: 1, maxTokens: 512
          })
        });
        assert.equal(created.status, 202);
        const id = (await created.json()).id;
        const tracked = { id, result: null };
        additionalExperiments.push(tracked);
        for (let i = 0; i < 300; i++) {
          tracked.result = await (await fetch(base + '/api/experiments/' + id)).json();
          if (!['pending', 'running'].includes(tracked.result.status)) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const outcome = tracked.result;
        assert.equal(outcome.rounds, 1, '默认每场只独立回答一轮');
        assert.deepEqual(evaluationRequests.filter(item => item.model === 'kimi-k3').map(item => item.budget), [16384, 32768]);
        if (mode.startsWith('always-')) {
          assert.equal(outcome.status, 'failed');
          assert.equal(outcome.completedDebates, 0, '缺票场次不得计入排名');
          assert.deepEqual(outcome.ranking, []);
          assert.deepEqual(outcome.stages[0].votes, { Kimi: 0, Ordinary: 0 });
          assert.equal(evaluationRequests.length, 2, '补投票只能重试一次');
          const filename = fs.readdirSync(path.join(root, 'debates')).find(name => name.endsWith(outcome.current.debateId.slice(0, 8) + '.md'));
          assert.ok(filename, '失败的场次仍须保存 Markdown');
          const record = fs.readFileSync(path.join(root, 'debates', filename), 'utf8');
          assert.match(record, /提高预算后重新互评仍失败/);
          assert.match(record, /停止实验，避免缺票排名/);
        } else {
          assert.equal(outcome.status, 'completed', outcome.error);
          assert.deepEqual(outcome.ranking, ['Kimi', 'Ordinary']);
          assert.deepEqual(evaluationRequests.filter(item => item.model === 'ordinary').map(item => item.budget), [2048, 4096]);
          assert.equal(outcome.stages[0].runs[0].individualVotes.length, 2);
          assert.ok(outcome.stages[0].runs[0].individualVotes.every(vote => vote.chosen === 'Kimi'));
        }
        console.log('PASS: 互评预算与完整投票保护 ' + mode);
      }
    }
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
    for (const tracked of additionalExperiments) {
      const file = path.join(root, 'experiments', tracked.id + '.json');
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const ids = [tracked.result?.current?.debateId, ...(tracked.result?.stages || []).flatMap(stage => stage.runs.map(run => run.debateId))].filter(Boolean);
      for (const filename of fs.readdirSync(path.join(root, 'debates'))) {
        if (!ids.some(id => filename.endsWith(id.slice(0, 8) + '.md'))) continue;
        const record = path.join(root, 'debates', filename);
        if (fs.readFileSync(record, 'utf8').includes(question)) fs.unlinkSync(record);
      }
    }
    updateRankingSummary(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
