const REASONING_MODEL_MIN_TOKENS = 16384;
// 通过模型名惯例匹配推理模型，无需维护精确名单
function isReasoningModel(modelId) {
  const id = (modelId || '').toLowerCase();
  // glm-4.6 及以上版本（4.6/4.7/4.8/4.9）均带推理能力，4.5 及以下不带
  // qwen3 的 max/flash 档为混合推理型号（互评时会先输出长独白再给结论），plus 档未观察到思考行为
  // Kimi 互评也可能先消耗预算进行推理，按推理模型预留输出空间。
  return /^(kimi|glm-5|glm-4\.[6-9]|deepseek-v4-pro|deepseek-r|deepseek-reason|qwq|o1|o3|o4|qwen3\.\d+-(max|flash)|.*-r1|.*-thinking|.*-reasoner|.*-air|minimax-m)/i.test(id)
      || /thinking|reasoning|reasoner|qwq|o1-|o3-|o4-|-r1$|-air$/i.test(id);
}
function effectiveMaxTokens(modelId, userMax) {
  return isReasoningModel(modelId) ? Math.max(userMax || 0, REASONING_MODEL_MIN_TOKENS) : userMax;
}

module.exports = { isReasoningModel, effectiveMaxTokens };
