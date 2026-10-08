const protocol = 'same-question-v6';
const rubric = '所有参与者回答同一个用户问题，主要按回答的正确性、完整性、与问题的相关性及论证和可检查依据评选回答最好者。每个评价引用参与者和具体回答步骤，区分真实错误、合理补充和待核验争议。篇幅长、术语多、自信或他人支持不加分；接受正确纠错不扣分，未经核实的指正不能直接当作错误。中途不宣布强弱，仅在最终互评投票选出最强者。';

function totalSteps(rounds, modelCount) { return rounds * modelCount; }

function turnFor(step, modelCount) {
  const index = step % modelCount;
  const exchangeRound = Math.floor(step / modelCount) + 1;
  return { index, exchangeRound, kind: exchangeRound === 1 ? 'answer' : 'supplement',
    phase: `回答第 ${exchangeRound} 轮 · ${exchangeRound === 1 ? '独立回答' : '补充回答'}` };
}

function messagesFor(question, labels, history, turn, wordLimit) {
  const label = labels[turn.index];
  // 同轮调用虽按顺序执行，但所有模型只能看到此前完整轮次的回答。
  const context = history.filter(entry => entry.exchangeRound < turn.exchangeRound);
  const instruction = turn.kind === 'answer'
    ? '独立回答用户给出的同一个问题，给出直接结论、必要理由及例子或可检查依据。你看不到其他参与者的回答。不要自行出题、要求他人回答或评价谁强谁弱。'
    : '继续回答原来的用户问题。参考此前完整轮次的回答，补充遗漏、澄清争议或修正自己的错误，给出理由与依据，不重复已有内容。不改换问题、不出新题、不评价强弱；未经验证的争议应明确标注。';
  const transcript = context.map(entry => `${entry.label}（第${entry.step}步，${entry.phase}）:\n${entry.content}`).join('\n\n');
  return [
    { role: 'system', content: `你是${label}，正在进行匿名同题回答比较。当前环节：${turn.phase}。${instruction}\n正文目标不超过${wordLimit}个中文字符，最多3个要点。只输出公开回答，不猜测身份。不声称已运行代码、查规范或用工具，除非确实执行过。\n评价标准：${rubric}` },
    { role: 'user', content: turn.kind === 'answer' ? question : `用户的原问题：\n${question}\n\n此前完整轮次的回答：\n${transcript}` }
  ];
}

module.exports = { protocol, rubric, totalSteps, turnFor, messagesFor };
