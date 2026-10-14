import { createAnswerOrderUI } from './answer-order.js';
import { createSettingsUI } from './features/settings.js';
import { createDebugUI } from './features/debug.js';
import { createExperimentUI } from './features/experiment.js';
import { createRecordsUI } from './records.js';
import { initWorkspace } from './workspace.js';
import { initTheme } from './ui/theme.js';

let settingsUI;
let experimentUI;
const orderUI = createAnswerOrderUI({ onChange: () => settingsUI.updateConfigSummary() });
settingsUI = createSettingsUI({
  renderAnswerOrderEditors: orderUI.renderAnswerOrderEditors,
  updateExperimentEstimate: () => experimentUI?.updateExperimentEstimate()
});
createDebugUI({ updateConfigSummary: settingsUI.updateConfigSummary });
experimentUI = createExperimentUI({ updateConfigSummary: settingsUI.updateConfigSummary });
const recordsUI = createRecordsUI();
initWorkspace({ orderUI, recordsUI });
initTheme();
settingsUI.updateConfigSummary();
