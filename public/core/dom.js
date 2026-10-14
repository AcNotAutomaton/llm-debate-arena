export const q = selector => document.querySelector(selector);

export function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

export const questionInput = q("#questionInput");
export const startBtn = q("#startBtn");
export const settingsBtn = q("#settingsBtn");
export const settingsModal = q("#settingsModal");
export const closeSettings = q("#closeSettings");
export const modelList = q("#modelList");
export const deepseekApiKeyInput = q("#deepseekApiKey");
export const testDSBtn = q("#testDSBtn");
export const dsStatus = q("#dsStatus");
export const roundsInput = q("#roundsInput");
export const temperatureInput = q("#temperatureInput");
export const maxTokensInput = q("#maxTokensInput");
export const anonymousToggle = q("#anonymousToggle");
export const anonymousHint = q("#anonymousHint");
export const glmApiKeyInput = q("#glmApiKey");
export const testGLMBtn = q("#testGLMBtn");
export const glmStatus = q("#glmStatus");
export const opencodeApiKeyInput = q("#opencodeApiKey");
export const testOpenCodeBtn = q("#testOpenCodeBtn");
export const opencodeStatus = q("#opencodeStatus");
export const batchTestOpenCodeBtn = q("#batchTestOpenCodeBtn");
export const opencodeBatchResults = q("#opencodeBatchResults");
export const saveSettingsBtn = q("#saveSettingsBtn");
export const arena = q("#arena");
export const judgePanel = q("#judgePanel");
export const progressBar = q("#progressBar");
export const progressFill = q("#progressFill");
export const progressText = q("#progressText");
export const modelCountText = q("#modelCountText");
export const roundCountText = q("#roundCountText");
export const themeToggle = q("#themeToggle");
export const experimentQuestions = q("#experimentQuestions");
export const experimentRepeats = q("#experimentRepeats");
export const experimentRounds = q("#experimentRounds");
export const experimentEstimate = q("#experimentEstimate");
export const startExperimentBtn = q("#startExperimentBtn");
export const experimentStatus = q("#experimentStatus");
export const experimentLive = q("#experimentLive");
export const experimentResult = q("#experimentResult");
