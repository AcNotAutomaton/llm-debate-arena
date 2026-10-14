function buildSystemPrompt(identifier, stepNum, totalSteps, anonymous) {
  let base, suffix;
  if (anonymous) {
    base = `你是一位知识渊博、逻辑清晰的辩论参与者。在这场辩论中，你的发言会以「${identifier}」为标识。请用中文回答。`;
    suffix = `\n\n注意：你的对手可能是人类专家，也可能是另一个 AI 模型——你无法确定对方的真实身份。请不要对对方的身份做任何假设，也不要试图点破对方”是不是 AI”，把注意力放在论点本身，自然地展开讨论。`;
  } else {
    base = `你是 ${identifier}，一位知识渊博、逻辑清晰的专家。请用中文回答。`;
    suffix = '';
  }
  // 禁止思考过程泄漏到正文：推理模型（如 glm-5）有时会把英文思考链
  // （”Let me analyze...” “Let me draft...”）写到 content 字段而非 reasoning_content，
  // 导致数万字思考占用 max_tokens、正文一行未写就被截断。
  var noThink = `\n\n重要：直接输出你的辩论发言正文。不要输出任何思考过程、内部独白、分析步骤或英文草稿（如”Let me analyze...”、”Let me draft...”、”Now I need to write...”等）。不要使用  标签。你的回复内容会直接作为辩论发言展示给观众，请像在公开论坛上发表观点一样直接书写。`;
  if (stepNum === 1) return `${base}${suffix}${noThink}\n\n现在请你直接针对问题给出你的全面分析和观点。`;
  return `${base}${suffix}${noThink}\n\n请基于之前的讨论继续深入分析，提出你的观点。`;
}

function buildUserPrompt(question, identifier, history, anonymous) {
  if (history.length === 0) return question;
  let context = `问题：${question}\n\n`;
  if (anonymous) context += `以下是辩论至今的发言记录（仅以中立标识展示，你不知道发言者是人还是 AI）：\n\n`;
  for (const entry of history) {
    const who = anonymous ? entry.label : entry.model;
    context += `---\n${who}:\n${entry.content}\n\n`;
  }
  context += `---\n\n现在轮到你（${identifier}）发言。请基于之前的所有发言继续深入分析，提出你的观点。`;
  return context;
}

module.exports = { buildSystemPrompt, buildUserPrompt };
