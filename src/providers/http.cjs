const FETCH_HANDSHAKE_TIMEOUT_MS = 120000;

async function parseProviderResponse(resp) {
  const text = await resp.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!resp.ok || data.error) {
    const err = data.error || data;
    const msg = (err && (err.message || err.raw)) || `HTTP ${resp.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

// 带 handshake 超时的 fetch：若上游在 HANDSHAKE_MS 内未返回响应头则 abort
async function fetchWithHandshakeTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('handshake-timeout')), timeoutMs || FETCH_HANDSHAKE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round((timeoutMs || FETCH_HANDSHAKE_TIMEOUT_MS)/1000)}s 内未收到响应）`);
    }
    throw err;
  }
}

module.exports = { parseProviderResponse, fetchWithHandshakeTimeout };
