const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const GLM_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/go/v1';

module.exports = { projectRoot, DEEPSEEK_BASE_URL, GLM_BASE_URL, OPENCODE_BASE_URL };
