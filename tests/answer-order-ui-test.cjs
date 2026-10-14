const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  setAttribute(name, value) { this[name] = value; }
}
const models = ['A', 'B', 'C'].map(name => ({ name, id: name, provider: 'glm' }));
const elements = Object.fromEntries(['debugAnswerOrder', 'experimentAnswerOrder', 'experimentOrderPolicy'].map(id => ['#' + id, new Element(id)]));
const state = { config: { selectedModels: models.slice() } };
const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const context = vm.createContext({ state, q: id => elements[id], document: { createElement: tag => new Element(tag) }, escapeHtml });
context.updateConfigSummary = () => context.renderAnswerOrderEditors();
// Browser tests cover ESM loading; this sandbox injects the editor's dependencies.
const source = fs.readFileSync(path.join(__dirname, '../public/answer-order.js'), 'utf8')
  .replace(/^import .+;\r?$/gm, '').replace(/^export /gm, '');
vm.runInContext(source, context);
context.renderAnswerOrderEditors = vm.runInContext('createAnswerOrderUI({ onChange: () => updateConfigSummary() }).renderAnswerOrderEditors', context);
context.renderAnswerOrderEditors();
const debug = elements['#debugAnswerOrder'];
assert.equal(debug.children[0].children[1].disabled, true);
debug.children[1].children[1].onclick();
assert.deepEqual(state.config.selectedModels.map(m => m.name), ['B', 'A', 'C']);
assert.equal(elements['#experimentAnswerOrder'].children[0].children[0].textContent, '1. B');
const selected = [models[0], models[1], { name: 'D', id: 'D', provider: 'glm' }];
assert.deepEqual(Array.from(context.preserveModelOrder(state.config.selectedModels, selected), m => m.name), ['B', 'A', 'D']);
state.isExperimentRunning = true;
context.renderAnswerOrderEditors();
assert.ok(debug.children.every(row => row.children.slice(1).every(button => button.disabled)));
debug.children[0].children[2].onclick();
assert.deepEqual(state.config.selectedModels.map(m => m.name), ['B', 'A', 'C']);
assert.equal(elements['#experimentOrderPolicy'].disabled, true);

const stage = { candidates: ['A', 'B', 'C'], runs: [
  { speakerOrder: ['A', 'B', 'C'], votes: { A: 2, B: 1, C: 0 } },
  { speakerOrder: ['B', 'C', 'A'], votes: { A: 1, B: 1, C: 1 } },
  { speakerOrder: ['B', 'C', 'A'], votes: { A: 1, B: 1, C: 1 } },
  { speakerOrder: ['A', 'B', 'C'], votes: { A: 1, B: 0, C: 0 } },
  { votes: { A: 3, B: 0, C: 0 } }
] };
const html = context.stageOrderStatsHtml(stage);
assert.match(html, /<td>A<\/td><td>1<\/td><td>1<\/td><td>2<\/td><td>2.00<\/td><td>1<\/td><td>0<\/td>/);
assert.match(html, /<td>A<\/td><td>3<\/td><td>2<\/td><td>2<\/td><td>1.00<\/td><td>0<\/td><td>2<\/td>/);
assert.match(context.runOrderResultsHtml(stage.runs[1]), /最高票并列/);
assert.match(context.runOrderResultsHtml(stage.runs[0]), /1\. A → 2\. B → 3\. C/);
assert.match(context.runOrderResultsHtml({}), /未记录回答顺序/);
assert.match(context.runOrderResultsHtml(stage.runs[3]), /票数不完整/);
assert.ok(!context.runOrderResultsHtml({ speakerOrder: ['<img>'], votes: {} }).includes('<img>'));
console.log('PASS: 两个视图同步调序、重选保序、运行锁定、位置得票统计、并列与缺失记录');
