const assert = require('node:assert/strict');
const { protocol, totalSteps, turnFor, messagesFor, rubric } = require('../src/protocols/experiment-protocol.cjs');
const { answerGuidance } = require('../src/protocols/answer-policy.cjs');
const { buildSystemPrompt } = require('../src/services/prompts.cjs');
assert.equal(protocol, 'same-question-v7');
const question = 'HTML 中 async 和 defer 有何区别？\n请给出示例。';
for (const n of [2, 3, 4]) {
  const labels = Array.from({ length: n }, (_, i) => '参与者' + String.fromCharCode(65 + i));
  const history = [];
  const counts = labels.map(() => ({ answer: 0, supplement: 0 }));
  assert.equal(totalSteps(3, n), 3 * n);
  for (let step = 0; step < totalSteps(3, n); step++) {
    const turn = turnFor(step, n);
    const label = labels[turn.index];
    assert.equal(turn.partnerIndex, undefined, '同题回答不分配出题对象');
    counts[turn.index][turn.kind]++;
    const messages = messagesFor(question, labels, history, turn);
    assert.ok(messages[0].content.includes(rubric));
    assert.ok(messages[0].content.includes(answerGuidance));
    assert.doesNotMatch(messages[0].content, /正文目标不超过|最多\s*3\s*个要点|\d+个中文字符|undefined/);
    assert.match(messages[0].content, /不猜测身份/);
    assert.match(messages[0].content, /不声称已运行代码/);
    const expected = history.filter(entry => entry.exchangeRound < turn.exchangeRound);
    for (const entry of history) assert.equal(messages[1].content.includes(entry.content), expected.includes(entry), `错误的可见历史：${n}模型，第${step + 1}步`);
    assert.ok(messages[1].content.includes(question), '每轮始终围绕原问题');
    if (turn.kind === 'answer') assert.equal(messages[1].content, question, '首轮所有模型收到完全相同的原问题');
    else assert.equal(expected.length, n * (turn.exchangeRound - 1), '补充轮只展示此前完整轮次');
    history.push({ ...turn, label, step: step + 1, content: `[unique-${n}-${step}-end]` });
  }
  for (const count of counts) assert.deepEqual(count, { answer: 1, supplement: 2 });
}
for (const anonymous of [true, false]) for (const step of [1, 2]) {
  const prompt = buildSystemPrompt('参与者A', step, 4, anonymous);
  assert.ok(prompt.includes(answerGuidance), '单场调试也允许按需完整作答');
  assert.doesNotMatch(prompt, /正文目标不超过|最多\s*3\s*个要点/);
}
console.log('PASS: 2/3/4模型同题独立回答、补充轮历史隔离与公平调用次数');
