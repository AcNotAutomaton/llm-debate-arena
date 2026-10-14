const fs = require('node:fs');
const path = require('node:path');
const experimentProtocol = require('../protocols/experiment-protocol.cjs');

function createRecordStore({ projectRoot, updateRankingSummary }) {
  function saveDebate(debateId, s) {
    try {
      const dir = path.join(projectRoot, 'debates');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const now = new Date();
      const filename = now.getFullYear() + '-' +
        String(now.getMonth()+1).padStart(2,'0') + '-' +
        String(now.getDate()).padStart(2,'0') + '_' +
        String(now.getHours()).padStart(2,'0') + '-' +
        String(now.getMinutes()).padStart(2,'0') + '-' +
        String(now.getSeconds()).padStart(2,'0') + '-' + debateId.slice(0, 8) + '.md';
      let md = '# LLM \u8fa9\u8bba\u8bb0\u5f55\n\n';
      if (s.aborted) md += '**状态**: ❌ 辩论因错误中断\n\n';
      md += '**\u95ee\u9898**: ' + s.question + '\n\n';
      md += '**\u53c2\u4e0e\u6a21\u578b**: ' + s.models.map(m => m.name).join(', ') + '\n\n---\n\n';
      md += '**每轮回答顺序**: ' + s.speakerOrder.map((name, i) => `${i + 1}. ${name}`).join(' → ') + '\n\n';
      if (s.orderPolicy) md += '**顺序策略**: ' + (s.orderPolicy === 'fixed' ? '固定顺序' : '逐场轮换') + '\n\n';
      if (s.protocol) md += `**实验协议**: ${s.protocol}\n\n**评价规则**: ${s.rubric || experimentProtocol.rubric}\n\n---\n\n`;
      for (let i = 0; i < s.history.length; i++) {
        md += '## \u7b2c' + (i+1) + '\u6b65 - ' + s.history[i].model + '\n\n';
        if (s.history[i].phase) md += `**环节**: ${s.history[i].phase}${s.history[i].partner ? '；**对话对象**: ' + s.history[i].partner : ''}\n\n`;
        md += s.history[i].content + '\n\n---\n\n';
      }
      if (s.evaluations && s.evaluations.length > 0) {
        md += "## 模型互评\n\n";
        for (var k = 0; k < s.evaluations.length; k++) {
          var ev = s.evaluations[k];
          md += "**" + ev.model + "**：\n\n" + ev.evaluation + "\n\n---\n\n";
        }
      }
      fs.writeFileSync(path.join(dir, filename), md, 'utf-8');
      console.log('Debate saved: ' + filename);
      return filename;
    } catch (e) { console.error('Save failed:', e.message); }
  }

  function saveExperiment(experiment) {
    const dir = path.join(projectRoot, 'experiments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, experiment.id + '.json'), JSON.stringify(experiment, null, 2), 'utf8');
    if (experiment.status === 'completed') {
      try { updateRankingSummary(); }
      catch (error) { console.error('排名汇总更新失败:', error.message); }
    }
  }
  function listExperiments(experiments) {
    const dir = path.join(projectRoot, 'experiments');
    const items = [];
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      try {
        const item = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        const live = experiments.get(item.id) || item;
        items.push({ id: live.id, createdAt: live.createdAt, status: !experiments.has(item.id) && ['running', 'pending'].includes(live.status) ? 'interrupted' : live.status,
          models: live.models.map(m => m.name), completedDebates: live.completedDebates, totalDebates: live.totalDebates,
          questionPreview: (live.questions || []).join(' / ').replace(/\s+/g, ' ').trim().slice(0, 240),
          ranking: live.ranking || [], protocol: live.protocol, orderPolicy: live.orderPolicy });
      } catch { /* A damaged record does not block the list. */ }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function readExperiment(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const file = path.join(projectRoot, 'experiments', id + '.json');
    if (!fs.existsSync(file)) return null;
    const experiment = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (['pending', 'running'].includes(experiment.status)) {
      experiment.status = 'interrupted';
      experiment.error = '服务曾重启，实验未继续运行；已完成的场次仍保存在结果中';
    }
    return experiment;
  }

  function debateRecordPath(filename) {
    const file = path.join(projectRoot, 'debates', filename);
    return fs.existsSync(file) ? file : null;
  }

  return { saveDebate, saveExperiment, listExperiments, readExperiment, debateRecordPath };
}

module.exports = { createRecordStore };
