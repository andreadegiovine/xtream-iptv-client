/**
 * What a provider answers on a catch-up address the TV's player could not open (its error says only "connection failed"): one small
 * request (the first bytes) after the failure, never while something plays (many subscriptions allow one connection). For the log:
 * { status, type, host, redirected } or { error }.
 */
export async function probeAddress(url, { fetchImpl = (...args) => fetch(...args), timeoutMs = 8000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller && controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Range: 'bytes=0-1023' }, signal: controller ? controller.signal : undefined });
    let host = '';
    try {
      host = new URL(res.url || url).host;
    } catch {
      host = '';
    }
    const out = { status: res.status, type: (res.headers && res.headers.get && res.headers.get('content-type')) || '', host, redirected: Boolean(res.redirected) };
    try {
      if (res.body && res.body.cancel) res.body.cancel();
    } catch {
      /* the answer is not read any further */
    }
    return out;
  } catch (err) {
    return { error: (err && err.name === 'AbortError') ? 'no answer in time' : (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** "HTTP 404 · text/html · host example.com (redirected)", or "no answer (…)". */
export function probeText(answer) {
  if (!answer) return '';
  if (answer.error) return `no answer (${answer.error})`;
  return [`HTTP ${answer.status}`, answer.type || 'no type', answer.host ? `host ${answer.host}${answer.redirected ? ' (redirected)' : ''}` : ''].filter(Boolean).join(' · ');
}
