function createRuntime() {
  return {
    sessions: new Map(),
    sseClients: new Map(),
    experiments: new Map(),
    // Live upstream content is deliberately excluded from persisted records.
    experimentChats: new WeakMap()
  };
}

module.exports = { createRuntime };
