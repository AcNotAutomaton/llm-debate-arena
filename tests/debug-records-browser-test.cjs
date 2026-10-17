const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const models = ['Alpha', 'Beta'].map(name => ({ id: name, name, provider: 'deepseek' }));
  const debug = { id: 'debug-completed', type: 'debug', status: 'completed', createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:01:00Z',
    models, questions: ['单场可读性测试'], rounds: 1, temperature: 0.7, maxTokens: 2048, anonymous: true, speakerOrder: ['Alpha', 'Beta'],
    votes: { Alpha: 0, Beta: 2 }, individualVotes: models.map(model => ({ voter: model.name, chosen: 'Beta' })),
    history: models.map((model, i) => ({ step: i + 1, model: model.name, content: '完整回答 <img src=x onerror="window.injected=true">' })),
    evaluations: models.map(model => ({ model: model.name, evaluation: '评价内容\nwin_res：参与者B', winRes: '参与者B' })),
    judgeResult: { winner: 'Alpha', judgeText: '裁判评价：Alpha 论证更完整', scores: { Alpha: 9, Beta: 8 } }, recordFile: 'source.md' };
  const legacy = { id: 'legacy-old', type: 'debug', legacy: true, status: 'archived', createdAt: '2026-07-18T10:00:00Z',
    models, questions: ['历史单场问题'], rawMarkdown: '# LLM 辩论记录\n\nold answer <script>window.injected=true</script>' };
  const failed = { ...debug, id: 'debug-failed', status: 'failed', createdAt: '2026-10-15T10:00:00Z', error: '接口 401，已中断',
    history: debug.history.slice(0, 1), evaluations: [], votes: { Alpha: 0, Beta: 0 }, individualVotes: [], judgeResult: null };
  const experiment = { id: 'ranking', type: 'experiment', status: 'completed', createdAt: '2026-10-14T10:00:00Z',
    models, questions: ['排名问题'], ranking: ['Beta', 'Alpha'], stages: [], completedDebates: 1, totalDebates: 1 };
  const records = [debug, failed, experiment, legacy];
  await page.route('**/api/records', route => route.fulfill({ json: records.map(record => ({ id: record.id, type: record.type,
    legacy: record.legacy, createdAt: record.createdAt, models: ['Alpha', 'Beta'], status: record.status, questionPreview: record.questions[0],
    completedDebates: record.status === 'completed' ? 1 : 0, totalDebates: 1, ranking: record.ranking })) }));
  await page.route('**/api/records/*', route => route.fulfill({ json: records.find(record => route.request().url().endsWith('/' + record.id)) }));
  const output = path.join(__dirname, '../outputs/debug-records'); fs.mkdirSync(output, { recursive: true });
  const select = async id => {
    await page.locator(`.record-row[data-id="${id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#recordDetail').getAttribute('aria-busy') === 'false');
  };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  try {
    await page.goto(process.env.ARENA_URL || 'http://localhost:3457');
    await page.getByRole('button', { name: '实验记录', exact: true }).click();
    await page.locator('.record-debug-results').waitFor();
    assert.equal(await page.locator('.record-row').count(), 4);
    assert.equal(await page.locator('.record-ranking').count(), 0, 'debug records do not fabricate a staged ranking');
    assert.match(await page.locator('.record-debug-results').textContent(), /Beta2票/);
    assert.equal(await page.getByRole('tab', { name: '回答与互评' }).count(), 1);
    assert.equal(await page.locator('.record-speech').count(), 4);
    assert.match(await page.locator('.record-judge-text').textContent(), /Alpha/);
    assert.equal(await page.locator('#recordDetail img, #recordDetail script').count(), 0);
    await page.getByRole('tab', { name: '回答位置' }).click();
    assert.equal(await page.locator('#recordPositionsPanel tbody tr').count(), 2);
    await page.getByRole('tab', { name: '原题与参数' }).click();
    assert.match(await page.locator('.record-parameters').textContent(), /固定顺序/);
    assert.match(await page.locator('.record-initial-order').textContent(), /1\. Alpha → 2\. Beta/);
    await page.getByRole('tab', { name: '回答与互评' }).click();
    const downloading = page.waitForEvent('download'); await page.locator('#exportRecord').click();
    const download = await downloading; const exported = path.join(output, download.suggestedFilename()); await download.saveAs(exported);
    assert.equal(JSON.parse(fs.readFileSync(exported, 'utf8')).type, 'debug');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    await page.locator('#recordsTypeFilter').selectOption('debug');
    assert.equal(await page.locator('.record-row').count(), 3);
    await select('debug-failed'); assert.match(await page.locator('.record-alert').textContent(), /401/);
    await page.locator('#recordsStatusFilter').selectOption('archived');
    assert.equal(await page.locator('.record-row').count(), 1);
    await select('legacy-old');
    assert.match(await page.locator('.record-archive-note').textContent(), /不作推断/);
    assert.match(await page.locator('.record-legacy-text').textContent(), /old answer/);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.getByRole('tab', { name: '原题与参数' }).click();
    assert.match(await page.locator('.record-initial-order').textContent(), /未记录/);
    await page.locator('#recordsStatusFilter').selectOption('all');
    await page.locator('#recordsTypeFilter').selectOption('experiment');
    assert.equal(await page.locator('.record-row').count(), 1);
    await select('ranking'); assert.equal(await page.getByRole('tab', { name: '阶段票数' }).count(), 1);
    await page.locator('#recordsTypeFilter').selectOption('all'); await select('debug-completed');
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 850 }); await noOverflow();
      await page.screenshot({ path: path.join(output, 'detail-' + width + '.png'), fullPage: true });
      if (width <= 700) {
        await page.locator('#recordsBack').click();
        await page.locator('#recordsTypeFilter').selectOption('debug'); await noOverflow();
        await select('legacy-old'); await noOverflow(); await page.locator('#recordsBack').click();
        await select('debug-completed');
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: mixed record types, debug answers/votes/judge/export, legacy archives, type/status filters, safe text and mobile layouts');
  } finally { await browser.close(); }

})().catch(error => { console.error(error); process.exitCode = 1; });
