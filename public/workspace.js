// 页面组织独立于实验执行逻辑；切换入口不会中断运行。
(() => {
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
  [roundsInput, temperatureInput, maxTokensInput].forEach(input => input.addEventListener('change', () => saveSettingsBtn.click()));
  new MutationObserver(() => { q('#modelPickerHint').hidden = !!modelList.children.length; }).observe(modelList, { childList: true });
  q('#connectModelsBtn').onclick = () => settingsBtn.click();

  q('#newExperimentBtn').onclick = () => {
    q('#experimentSetup').hidden = false;
    q('#experimentMonitor').hidden = true;
    q('#newExperimentBtn').hidden = true;
  };

  const statusLabels = { completed: '已完成', running: '运行中', pending: '等待开始', tied: '出现并列', failed: '失败', interrupted: '已中断' };
  async function loadRecords() {
    const list = q('#recordsList');
    list.textContent = '正在读取实验记录…';
    try {
      const response = await fetch('/api/experiments');
      if (!response.ok) throw new Error('无法读取记录，请确认服务已更新');
      const records = await response.json();
      list.replaceChildren();
      if (!records.length) list.textContent = '还没有实验记录。完成第一组实验后会显示在这里。';
      records.forEach(record => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'record-card';
        const title = document.createElement('strong');
        title.textContent = `${new Date(record.createdAt).toLocaleString()} · ${statusLabels[record.status] || record.status}`;
        const description = document.createElement('span');
        description.textContent = `${record.models.join(' / ')} · ${record.completedDebates}/${record.totalDebates} 场`;
        button.append(title, description);
        button.onclick = async () => {
          const detail = q('#recordDetail');
          detail.textContent = '正在读取结果…';
          try {
            const data = await readExperiment(record.id);
            detail.innerHTML = `<h3>实验详情</h3><p>${escapeHtml(statusLabels[data.status] || data.status)}</p><h3>排名</h3>${data.ranking.length ? '<ol>' + data.ranking.map(name => '<li>' + escapeHtml(name) + '</li>').join('') + '</ol>' : '<p>尚未确定</p>'}`;
            if (data.tie) {
              const tie = document.createElement('p');
              tie.textContent = `第 ${data.tie.position} 名并列：${data.tie.models.join('、')}`;
              detail.appendChild(tie);
            }
            if (data.error) {
              const error = document.createElement('p'); error.textContent = data.error; detail.appendChild(error);
            }
            for (const stage of data.stages) {
              const group = document.createElement('details');
              const title = document.createElement('summary');
              title.textContent = `第 ${stage.position} 阶段 · ${Object.entries(stage.votes).map(([name, votes]) => `${name} ${votes}票`).join(' / ')}`;
              group.appendChild(title);
              stage.runs.forEach(run => {
                if (!run.recordFile) return;
                const link = document.createElement('a');
                link.href = '/api/debate-records/' + encodeURIComponent(run.recordFile);
                link.target = '_blank'; link.rel = 'noopener';
                link.textContent = `辩题 ${run.questionIndex} · 重复 ${run.repeat} · 查看讨论`;
                group.appendChild(link);
              });
              detail.appendChild(group);
            }
          } catch (error) { detail.textContent = error.message; }
        };
        list.appendChild(button);
      });
    } catch (error) { list.textContent = error.message; }
  }
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
    document.querySelectorAll('.workspace-view').forEach(view => view.hidden = view.id !== button.dataset.view);
    document.querySelectorAll('[data-view]').forEach(tab => tab.setAttribute('aria-current', tab === button ? 'page' : 'false'));
    if (button.dataset.view === 'recordsView') loadRecords();
  });
  q('#refreshRecords').onclick = loadRecords;
})();
