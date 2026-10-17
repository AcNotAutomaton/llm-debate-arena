const express = require('express');
const cors = require('cors');
const path = require('node:path');
const { projectRoot: defaultRoot } = require('./config.cjs');
const { updateRankingSummary: defaultSummary } = require('./reports/ranking-summary.cjs');
const { createRuntime } = require('./runtime/state.cjs');
const { createEventHub } = require('./runtime/events.cjs');
const { createModelClient } = require('./providers/model-client.cjs');
const { createProviderCatalog } = require('./providers/catalog.cjs');
const { createRecordStore } = require('./storage/records.cjs');
const { createDebugRecordStore } = require('./storage/debug-records.cjs');
const { createRecordsService } = require('./services/records.cjs');
const { createEvaluationService } = require('./services/evaluation.cjs');
const { createDebateService } = require('./services/debate.cjs');
const { createExperimentService } = require('./services/experiment.cjs');
const { registerProviderRoutes } = require('./routes/providers.cjs');
const { registerDebateRoutes } = require('./routes/debates.cjs');
const { registerExperimentRoutes } = require('./routes/experiments.cjs');
const { registerRecordRoutes } = require('./routes/records.cjs');

function createApp({ projectRoot = defaultRoot, updateRankingSummary = defaultSummary } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(projectRoot, 'public')));

  const runtime = createRuntime();
  const events = createEventHub(runtime);
  const modelClient = createModelClient(events);
  const recordStore = createRecordStore({ projectRoot, updateRankingSummary: () => updateRankingSummary(projectRoot) });
  const debugStore = createDebugRecordStore({ projectRoot });
  const evaluation = createEvaluationService({ ...events, modelClient });
  const { startDebate } = createDebateService({ sessions: runtime.sessions, ...events, modelClient, evaluation, recordStore, debugStore });
  const experimentService = createExperimentService({ runtime, startDebate, recordStore });

  registerProviderRoutes(app, createProviderCatalog(modelClient));
  registerDebateRoutes(app, { runtime, startDebate, modelClient, recordStore });
  registerExperimentRoutes(app, { runtime, recordStore, experimentService });
  registerRecordRoutes(app, createRecordsService({ runtime, recordStore, debugStore }));
  return app;
}

module.exports = { createApp };
