const { createApp } = require('./app.cjs');
const { updateRankingSummary } = require('./reports/ranking-summary.cjs');

const PORT = process.env.PORT || 3456;
try { updateRankingSummary(); }
catch (error) { console.error('排名汇总更新失败:', error.message); }
createApp().listen(PORT, () => {
  console.log('LLM 辩论竞技场已启动');
  console.log(`   本地访问: http://localhost:${PORT}`);
});
