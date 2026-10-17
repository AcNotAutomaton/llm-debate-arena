function createRecordsService({ runtime, recordStore, debugStore }) {
  function excludedFiles(summaries) {
    const files = new Set();
    for (const summary of summaries) {
      try {
        const experiment = runtime.experiments.get(summary.id) || recordStore.readExperiment(summary.id);
        for (const stage of experiment?.stages || []) for (const run of stage.runs || []) {
          if (run.recordFile) files.add(run.recordFile.replace(/\\/g, '/'));
        }
      } catch { /* A damaged experiment must not hide other records. */ }
    }
    return files;
  }

  function list() {
    const experiments = recordStore.listExperiments(runtime.experiments);
    return experiments.map(record => ({ ...record, type: 'experiment' }))
      .concat(debugStore.list(excludedFiles(experiments)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function read(id) {
    if (id.startsWith('debug-')) return debugStore.read(id);
    if (id.startsWith('legacy-')) return debugStore.readLegacy(id, excludedFiles(recordStore.listExperiments(runtime.experiments)));
    const experiment = runtime.experiments.get(id) || recordStore.readExperiment(id);
    return experiment ? { ...experiment, type: 'experiment' } : null;
  }

  return { list, read, markdownPath: debugStore.markdownPath };
}

module.exports = { createRecordsService };
