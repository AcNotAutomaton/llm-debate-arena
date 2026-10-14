import { q, settingsBtn, modelList, roundsInput, temperatureInput, maxTokensInput, anonymousToggle, saveSettingsBtn, arena, judgePanel, progressBar } from './core/dom.js';
// 页面组织独立于实验执行逻辑；切换入口不会中断运行。
export function initWorkspace({ orderUI, recordsUI }) {
  const moveField = (input, target) => q(target).appendChild(input.closest('.form-group'));
  const oldModelGroup = modelList.closest('.form-group');
  q('#experimentModelPicker').appendChild(modelList);
  oldModelGroup.remove();
  moveField(roundsInput, '#debugParameters');
  moveField(anonymousToggle, '#debugParameters');
  moveField(temperatureInput, '#advancedParameters');
  moveField(maxTokensInput, '#advancedParameters');
  q('#debugOutput').append(progressBar, arena, judgePanel);
  modelList.addEventListener('change', () => saveSettingsBtn.click());
  orderUI.renderAnswerOrderEditors();
  [roundsInput, temperatureInput, maxTokensInput].forEach(input => input.addEventListener('change', () => saveSettingsBtn.click()));
  new MutationObserver(() => { q('#modelPickerHint').hidden = !!modelList.children.length; }).observe(modelList, { childList: true });
  q('#connectModelsBtn').onclick = () => settingsBtn.click();

  q('#newExperimentBtn').onclick = () => {
    q('#experimentSetup').hidden = false;
    q('#experimentMonitor').hidden = true;
    q('#experimentChat').hidden = true;
    q('#newExperimentBtn').hidden = true;
  };

  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
    document.querySelectorAll('.workspace-view').forEach(view => view.hidden = view.id !== button.dataset.view);
    document.querySelectorAll('[data-view]').forEach(tab => tab.setAttribute('aria-current', tab === button ? 'page' : 'false'));
    if (button.dataset.view === 'recordsView') recordsUI.load();
  });
}
