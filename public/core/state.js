export const COLORS = [
  { bg: "#4f46e5", name: "Indigo" },
  { bg: "#059669", name: "Emerald" },
  { bg: "#dc2626", name: "Red" },
  { bg: "#d97706", name: "Amber" },
  { bg: "#7c3aed", name: "Violet" },
  { bg: "#0891b2", name: "Cyan" },
  { bg: "#db2777", name: "Pink" },
  { bg: "#65a30d", name: "Lime" },
];

export const state = {
  config: {
    deepseekApiKey: "",
    deepseekModels: [],
    glmApiKey: "",
    glmModels: [],
    opencodeApiKey: "",
    opencodeModels: [],
    rounds: 3,
    temperature: 0.7,
    maxTokens: 2048,
    anonymous: true,
    selectedModels: [],
  },
  debateId: null,
  eventSource: null,
  isRunning: false,
};
