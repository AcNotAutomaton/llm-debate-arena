const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedRecordId = text; } } });
  });
  const names = ['GLM-5.3', 'Kimi-K3', 'MiniMax-M3', 'Qwen3.8-Max-Long-Model-Identifier-With-No-Breakpoints-2026'];
  const models = names.map(name => ({ id: name, name, provider: 'deepseek' }));
  const stages = names.slice(0, -1).map((winner, i) => {
    const candidates = names.slice(i);
    const runs = [0, 1].map(repeat => {
      const order = candidates.slice(repeat).concat(candidates.slice(0, repeat));
      const individualVotes = candidates.map((voter, index) => ({ voter, chosen: candidates.length === 4 && index === 1 ? candidates[1] : winner }));
      const votes = Object.fromEntries(candidates.map(name => [name, individualVotes.filter(v => v.chosen === name).length]));
      return { debateId: 'debate-' + i + '-' + repeat, questionIndex: 1, repeat: repeat + 1, discussionRounds: 1, speakerOrder: order, votes, individualVotes, recordFile: '2026-10-12_00-00-00-12345678.md' };
    });
    return { position: i + 1, candidates, winner, runs, votes: Object.fromEntries(candidates.map(name => [name, runs.reduce((total, run) => total + run.votes[name], 0)])) };
  });
  const base = { models, ranking: names, stages, questions: ['在并发渲染与乐观更新下，如何设计一致的 React 状态系统？\n请分析过时响应、失败回滚与 hydration，并给出可验证的不变量。'], completedDebates: 6, totalDebates: 6, repetitions: 2, rounds: 1, temperature: 0.7, maxTokens: 8192, protocol: 'same-question-v6', orderPolicy: 'rotate', liveChat: { reasoning: 'temporary-live-only' } };
  const statuses = ['completed', 'failed', 'interrupted', 'running', 'tied', 'completed', 'completed', 'completed'];
  const records = statuses.map((status, i) => ({ ...base, id: 'record-' + i, createdAt: new Date(Date.UTC(2026, 9, 12 - i, 2)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, 12 - i, 3)).toISOString(), status,
    ...(i === 1 ? { error: '上游接口连续返回错误，实验已停止；此前完成的结果已保存。', ranking: [names[0]], completedDebates: 2 } : {}),
    ...(i === 4 ? { tie: { position: 1, models: names.slice(0, 2), reason: '累计最高票并列' }, ranking: [] } : {}),
    ...(i === 6 ? { questions: ['<img src=x onerror="window.injected=true">'], ranking: [], stages: [], rounds: undefined, repetitions: undefined, protocol: 'reciprocal-qa-v5' } : {})
  }));
  let listMode = 'normal';
  let slowFirst = false;
  await page.route('**/api/experiments', route => listMode === 'error' ? route.fulfill({ status: 503, contentType: 'text/plain', body: 'upstream unavailable' }) : route.fulfill({ json: listMode === 'empty' ? [] : records.map(record => ({ id: record.id, createdAt: record.createdAt, status: record.status, models: names, questionPreview: record.questions[0], ranking: record.ranking, completedDebates: record.completedDebates, totalDebates: record.totalDebates })) }));
  await page.route('**/api/experiments/record-*', async route => {
    const record = records.find(item => route.request().url().endsWith('/' + item.id));
    if (slowFirst && record.id === 'record-0') await new Promise(resolve => setTimeout(resolve, 250));
    return route.fulfill(record.id === 'record-7' ? { status: 404, json: { error: '记录不存在' } } : { json: record });
  });
  const output = path.join(__dirname, '../outputs/records-ui');
  fs.mkdirSync(output, { recursive: true });
  const pick = async id => {
    await page.locator(`.record-row[data-id="${id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#recordDetail').getAttribute('aria-busy') === 'false');
  };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '页面不能横向溢出');
  try {
    await page.goto(process.env.ARENA_URL || 'http://localhost:3458');
    await page.getByRole('button', { name: '实验记录', exact: true }).click();
    await page.locator('.record-ranking li').first().waitFor();
    assert.equal(await page.locator('.record-row').count(), 8);
    assert.equal(await page.locator('.record-ranking li').count(), 4);
    assert.equal(await page.locator('.record-stage').count(), 3);
    assert.equal(await page.locator('.record-stage').first().getAttribute('open'), '');
    assert.match(await page.locator('.record-vote-row').first().textContent(), /GLM-5.36票/);
    await noOverflow();
    await page.screenshot({ path: path.join(output, 'desktop-dark.png'), fullPage: true });
    await page.locator('.record-ballots').first().locator('summary').click();
    assert.equal(await page.locator('.record-ballots').first().locator('li').count(), 4);
    await page.getByRole('tab', { name: '回答位置' }).click();
    assert.equal(await page.locator('#recordPositionsPanel table').count(), 3);
    await page.screenshot({ path: path.join(output, 'desktop-positions.png'), fullPage: true });
    await page.getByRole('tab', { name: '原题与参数' }).click();
    assert.match(await page.locator('.record-question').textContent(), /hydration/);
    await page.getByRole('tab', { name: '原题与参数' }).press('Home');
    assert.equal(await page.getByRole('tab', { name: '阶段票数' }).getAttribute('aria-selected'), 'true');
    await page.locator('#copyRecordId').click();
    assert.equal(await page.evaluate(() => window.copiedRecordId), 'record-0');
    const downloading = page.waitForEvent('download');
    await page.locator('#exportRecord').click();
    const download = await downloading;
    const exportedFile = path.join(output, download.suggestedFilename());
    await download.saveAs(exportedFile);
    const exported = JSON.parse(fs.readFileSync(exportedFile, 'utf8'));
    assert.equal(exported.id, 'record-0'); assert.equal(Object.hasOwn(exported, 'liveChat'), false);

    await page.locator('#recordsStatusFilter').selectOption('failed');
    assert.equal(await page.locator('.record-row').count(), 1);
    await pick('record-1'); assert.match(await page.locator('.record-alert').textContent(), /上游接口/);
    assert.equal(await page.locator('.record-ranking li').count(), 1);
    await page.locator('#recordsStatusFilter').selectOption('all');
    await page.locator('#recordsSearch').fill('record-2'); assert.equal(await page.locator('.record-row').count(), 1);
    await page.locator('#recordsSearch').fill('不存在的模型');
    assert.match(await page.locator('#recordsList').textContent(), /没有匹配/);
    await page.getByRole('button', { name: '清除筛选' }).click();
    await page.locator('#recordsSort').selectOption('oldest');
    assert.equal(await page.locator('.record-row').first().getAttribute('data-id'), 'record-7');
    await page.locator('#recordsSort').selectOption('newest');
    await pick('record-4'); assert.match(await page.locator('.record-alert').textContent(), /并列/);
    await pick('record-6'); assert.equal(await page.locator('#recordDetail img').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await pick('record-7'); assert.match(await page.locator('#recordDetail').textContent(), /读取失败/);
    slowFirst = true;
    await page.locator('.record-row[data-id="record-0"]').click();
    await page.locator('.record-row[data-id="record-1"]').click();
    await page.locator('.record-alert').waitFor();
    await page.waitForTimeout(350);
    assert.match(await page.locator('.record-alert').textContent(), /上游接口/);
    slowFirst = false;
    await pick('record-0');
    await page.locator('#refreshRecords').click();
    await page.waitForFunction(() => !document.querySelector('#refreshRecords').disabled);
    assert.equal(await page.locator('.record-row[aria-pressed="true"]').getAttribute('data-id'), 'record-0');
    listMode = 'error';
    await page.locator('#refreshRecords').click();
    await page.locator('#recordsNotice').filter({ hasText: '无法读取' }).waitFor();
    assert.equal(await page.locator('.record-row').count(), 8);
    listMode = 'empty'; await page.locator('#refreshRecords').click();
    await page.waitForFunction(() => !document.querySelector('#refreshRecords').disabled);
    assert.match(await page.locator('#recordsList').textContent(), /暂无实验记录/);
    listMode = 'normal'; await page.locator('#refreshRecords').click();
    await page.locator('.record-ranking li').first().waitFor();
    await page.locator('#themeToggle').click();
    await page.screenshot({ path: path.join(output, 'desktop-light.png'), fullPage: true });
    await page.locator('#themeToggle').click();
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 700) {
        await page.locator('.record-row[data-id="record-0"]').click();
        await page.waitForFunction(() => document.querySelector('#recordDetail').getAttribute('aria-busy') === 'false');
        assert.equal(await page.locator('#recordsSidebar').isVisible(), false);
      }
      await page.getByRole('tab', { name: '阶段票数' }).click();
      await noOverflow();
      await page.screenshot({ path: path.join(output, 'detail-' + width + '.png'), fullPage: true });
      await page.getByRole('tab', { name: '回答位置' }).click(); await noOverflow();
      if (width <= 700) {
        await page.screenshot({ path: path.join(output, 'positions-' + width + '.png'), fullPage: true });
        await page.locator('#recordsBack').click();
        assert.equal(await page.locator('#recordsSidebar').isVisible(), true);
        await page.screenshot({ path: path.join(output, 'list-' + width + '.png'), fullPage: true });
        await page.locator('#recordsStatusFilter').selectOption('failed'); await pick('record-1');
        await noOverflow();
        await page.locator('#recordsBack').click(); await page.locator('#recordsStatusFilter').selectOption('all');
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: 记录筛选排序、详情标签、逐票记录、复制下载、竞态、空/错/旧记录、安全转义、深浅主题和320/390/768/1440布局');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
