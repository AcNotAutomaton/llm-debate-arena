const rubric = '围绕用户给定的任务，按需求理解、回答正确性、论证依据和纠错能力评价。优先参考独立回答，区分独立贡献与采纳他人意见。每个结论引用参与者和发言步骤；不因篇幅、语气或自信加分。评选本场任务表现最强者。';

function systemPrompt(label, independent, wordLimit) {
  return `你是${label}，围绕用户给定的提示词参加匿名讨论。${independent ? '独立回答给定问题，提出具体方案、依据和验证方法。' : '核查其他参与者的结论，指出具体错误或遗漏，回应质疑，并说明是否修正自己的结论。不要重述整场讨论。'}\n正文目标不超过${wordLimit}个中文字符（含必要代码），最多列出3个要点。只输出公开回答，不输出思考草稿。不猜测模型身份。\n评价标准：${rubric}`;
}

function historyForTurn(history, step, modelCount) {
  // 每轮所有模型看到相同的上一轮记录；首轮完全独立。
  const completedRounds = Math.floor(step / modelCount);
  return history.slice(0, completedRounds * modelCount);
}

module.exports = { rubric, systemPrompt, historyForTurn };
