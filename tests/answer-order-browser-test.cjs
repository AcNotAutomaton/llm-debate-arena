const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const models = ['Alpha', 'Beta', 'Gamma'].map(name => ({ id: name.toLowerCase(), name, provider: 'deepseek' }));
  let experimentRequest, debugRequest;
  const run = { speakerOrder: ['Beta', 'Alpha', 'Gamma'], votes: { Beta: 1, Alpha: 2, Gamma: 0 }, questionIndex: 1, repeat: 1, discussionRounds: 1, recordFile: '2026-10-12_00-00-00-12345678.md' };
  const data = { id: 'browser-mock', status: 'completed', models: [models[1], models[0], models[2]], protocol: 'same-question-v6', orderPolicy: 'fixed', ranking: ['Alpha', 'Beta', 'Gamma'], totalDebates: 1, completedDebates: 1,
    stages: [{ position: 1, candidates: ['Beta', 'Alpha', 'Gamma'], votes: run.votes, winner: 'Alpha', runs: [run] }], current: null, liveChat: null };
  await page.route('**/api/test-connection', route => route.fulfill({ json: { success: true, models } }));
  await page.route('**/api/experiments', route => {
    if (route.request().method() === 'POST') {
      experimentRequest = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { id: data.id } });
    }
    return route.fulfill({ json: [{ id: data.id, createdAt: new Date().toISOString(), status: data.status, models: data.models.map(m => m.name), completedDebates: 1, totalDebates: 1 }] });
  });
  await page.route('**/api/experiments/browser-mock', route => route.fulfill({ json: data }));
  await page.route('**/api/debate', route => {
    debugRequest = route.request().postDataJSON();
    return route.fulfill({ json: { debateId: 'debug-mock' } });
  });
  await page.route('**/api/debate/debug-mock/stream', route => route.fulfill({
    contentType: 'text/event-stream', body: 'event: debate-start\ndata: ' + JSON.stringify({ models: debugRequest.models, speakerOrder: debugRequest.models.map(m => m.name) }) + '\n\nevent: debate-end\ndata: ' + JSON.stringify({ evaluations: debugRequest.models.map(m => ({ model: m.name, winRes: '参与者B', evaluation: 'win_res：参与者B' })) }) + '\n\n'
  }));
  const output = path.join(__dirname, '../outputs/answer-order');
  fs.mkdirSync(output, { recursive: true });
  try {
    await page.goto(process.env.ARENA_URL || 'http://localhost:3457');
    await page.locator('#connectModelsBtn').click();
    await page.locator('#deepseekApiKey').fill('mock-browser-key');
    await page.locator('#testDSBtn').click();
    await page.locator('#dsStatus').filter({ hasText: '3' }).waitFor();
    await page.locator('#saveSettingsBtn').click();
    for (let i = 0; i < models.length; i++) await page.locator('#m-' + i).check();
    await page.locator('#experimentAnswerOrder li').nth(1).getByRole('button', { name: 'Beta：提前回答' }).click();
    assert.equal(await page.locator('#experimentAnswerOrder li span').first().textContent(), '1. Beta');
    await page.locator('#experimentOrderPolicy').selectOption('fixed');
    await page.locator('#experimentQuestions').fill('顺序测试');
    await page.screenshot({ path: path.join(output, 'desktop-setup.png'), fullPage: true });
    await page.getByRole('button', { name: '单场调试', exact: true }).click();
    assert.equal(await page.locator('#debugAnswerOrder li span').first().textContent(), '1. Beta');
    await page.locator('#questionInput').fill('单场顺序测试');
    await page.locator('#startBtn').click();
    await page.locator('#judgePanel').waitFor({ state: 'visible' });
    assert.deepEqual(debugRequest.models.map(m => m.name), ['Beta', 'Alpha', 'Gamma']);
    assert.match(await page.locator('#debugActualOrder').textContent(), /1\. Beta → 2\. Alpha → 3\. Gamma/);
    assert.match(await page.locator('#judgePanel').textContent(), /最高票：Alpha/);
    await page.screenshot({ path: path.join(output, 'desktop-debug.png'), fullPage: true });
    await page.getByRole('button', { name: '排名实验', exact: true }).click();
    await page.locator('#startExperimentBtn').click();
    await page.locator('#experimentResult details').waitFor();
    assert.equal(experimentRequest.orderPolicy, 'fixed');
    assert.deepEqual(experimentRequest.models.map(m => m.name), ['Beta', 'Alpha', 'Gamma']);
    await page.locator('#experimentResult details > summary').click();
    assert.match(await page.locator('#experimentResult').textContent(), /2位 Alpha：2票/);
    await page.screenshot({ path: path.join(output, 'desktop-result.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'mobile-result.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '移动端页面不能横向溢出');
    await page.locator('#newExperimentBtn').click();
    await page.screenshot({ path: path.join(output, 'mobile-setup.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole('button', { name: '实验记录', exact: true }).click();
    await page.locator('.record-row').click();
    await page.locator('#recordDetail .record-run').waitFor();
    assert.match(await page.locator('#recordDetail .record-run-order li').nth(1).textContent(), /2Alpha2票/);
    await page.getByRole('tab', { name: '原题与参数' }).click();
    assert.match(await page.locator('.record-initial-order').textContent(), /1\. Beta → 2\. Alpha → 3\. Gamma/);
    await page.getByRole('tab', { name: '回答位置' }).click();
    assert.equal(await page.locator('#recordDetail .answer-order-table tbody tr').count(), 3);
    await page.getByRole('tab', { name: '阶段票数' }).click();
    await page.screenshot({ path: path.join(output, 'mobile-record.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole('button', { name: '单场调试', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'mobile-debug.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(errors, []);
    console.log('PASS: 浏览器调序、两入口请求、结果位置对应、桌面/移动截图与无页面错误');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
