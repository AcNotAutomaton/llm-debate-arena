const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const debugId = /^debug-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const legacyId = /^legacy-[0-9a-f]{32}$/;

function debugRecord(session) {
  const models = session.models.map(({ id, name, provider }) => ({ id, name, provider }));
  const speakerOrder = session.speakerOrder || models.map(model => model.name);
  const votes = Object.fromEntries(models.map(model => [model.name, 0]));
  const evaluations = (session.evaluations || []).map(({ model, evaluation, winRes }) => ({ model, evaluation, winRes }));
  const individualVotes = evaluations.map(evaluation => {
    let chosen = evaluation.winRes || '';
    if (session.anonymous !== false && /^参与者[A-Z]$/.test(chosen)) chosen = models[chosen.charCodeAt(3) - 65]?.name || '';
    if (!Object.hasOwn(votes, chosen)) chosen = '';
    if (chosen) votes[chosen]++;
    return { voter: evaluation.model, chosen: chosen || null };
  });
  // Explicit fields keep credentials, request config and live reasoning out of history.
  return {
    id: 'debug-' + session.id, type: 'debug', debateId: session.id,
    status: session.aborted ? 'failed' : session.status,
    createdAt: new Date(session.createdAt).toISOString(), updatedAt: new Date().toISOString(),
    questions: [session.question], models, rounds: session.rounds, temperature: session.temperature,
    maxTokens: session.maxTokens, anonymous: session.anonymous !== false, speakerOrder,
    history: session.history.map(({ model, label, step, answerPosition, content }) => ({ model, label, step, answerPosition, content })),
    evaluations, votes, individualVotes,
    judgeResult: session.judgeResult ? { judgeText: session.judgeResult.judgeText, scores: session.judgeResult.scores, winner: session.judgeResult.winner } : null,
    recordFile: session.recordFile || null,
    error: session.aborted ? session.evaluationError || session.history.at(-1)?.content || '单场调试中断' : null
  };
}

function debugSummary(record) {
  return { id: record.id, type: 'debug', legacy: !!record.legacy, createdAt: record.createdAt,
    status: record.status, models: record.models.map(model => model.name),
    questionPreview: (record.questions || []).join(' / ').replace(/\s+/g, ' ').trim().slice(0, 240),
    completedDebates: record.status === 'completed' ? 1 : record.legacy ? null : 0, totalDebates: 1 };
}

function createDebugRecordStore({ projectRoot }) {
  const dir = path.join(projectRoot, 'debates');
  const legacyCache = new Map();
  let legacyPaths = new Map();

  function markdownPath(relative) {
    if (typeof relative !== 'string' || !relative.endsWith('.md')) return null;
    const file = path.resolve(dir, relative);
    if (!file.startsWith(dir + path.sep)) return null;
    try {
      const real = fs.realpathSync(file);
      return real.startsWith(fs.realpathSync(dir) + path.sep) && fs.lstatSync(file).isFile() ? file : null;
    } catch { return null; }
  }

  function save(session) {
    if (session.experimentId) return;
    const record = debugRecord(session);
    if (!debugId.test(record.id)) throw new Error('无效的单场记录编号');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, record.id + '.json'), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  function read(id) {
    if (!debugId.test(id)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
      return record.id === id && record.type === 'debug' && typeof record.createdAt === 'string' &&
        Array.isArray(record.models) && record.models.every(model => typeof model?.name === 'string') ? record : null;
    } catch { return null; }
  }

  function legacyMetadata(relative, file) {
    const stat = fs.statSync(file);
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (legacyCache.get(relative)?.key === key) return legacyCache.get(relative).record;
    const markdown = fs.readFileSync(file, 'utf8');
    const header = markdown.split(/^## 第\d+步 - /m)[0];
    let record = null;
    if (markdown.startsWith('# LLM 辩论记录') && !/^\*\*实验协议\*\*[:：]/m.test(header)) {
      const models = /^\*\*参与模型\*\*[:：]\s*([^\n]+)/m.exec(header)?.[1].split(/[,，]\s*/).map(name => ({ name: name.trim() })).filter(model => model.name);
      const question = /^\*\*问题\*\*[:：]\s*([\s\S]*?)\n\*\*参与模型\*\*[:：]/m.exec(header)?.[1].trim();
      if (models?.length && question) {
        const stamp = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(path.basename(relative));
        const date = stamp ? new Date(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}+08:00`) : stat.mtime;
        record = { id: 'legacy-' + crypto.createHash('sha256').update(relative).digest('hex').slice(0, 32),
          type: 'debug', legacy: true, status: /^\*\*状态\*\*[:：].*中断/m.test(header) ? 'failed' : 'archived',
          createdAt: Number.isNaN(date.getTime()) ? stat.mtime.toISOString() : date.toISOString(),
          questions: [question], models, recordFile: relative };
      }
    }
    legacyCache.set(relative, { key, record });
    return record;
  }

  function list(excluded = new Set()) {
    const records = [], covered = new Set(excluded);
    if (!fs.existsSync(dir)) return records;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const record = read(name.slice(0, -5));
      if (!record) continue;
      records.push(debugSummary(record));
      if (record.recordFile) covered.add(record.recordFile.replace(/\\/g, '/'));
    }
    const paths = new Map(), seen = new Set();
    function visit(folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.name === 'order-checks') continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) { visit(file); continue; }
        const relative = path.relative(dir, file).replace(/\\/g, '/');
        if (!entry.isFile() || !entry.name.endsWith('.md') || covered.has(relative)) continue;
        seen.add(relative);
        try {
          const record = legacyMetadata(relative, file);
          if (record) { records.push(debugSummary(record)); paths.set(record.id, record); }
        } catch { /* One unreadable archive does not block history. */ }
      }
    }
    visit(dir);
    legacyPaths = paths;
    for (const relative of legacyCache.keys()) if (!seen.has(relative)) legacyCache.delete(relative);
    return records;
  }

  function readLegacy(id, excluded) {
    if (!legacyId.test(id)) return null;
    list(excluded);
    const record = legacyPaths.get(id);
    const file = record && markdownPath(record.recordFile);
    return file ? { ...record, rawMarkdown: fs.readFileSync(file, 'utf8') } : null;
  }

  return { save, list, read, readLegacy, markdownPath };
}

module.exports = { createDebugRecordStore, debugRecord };
