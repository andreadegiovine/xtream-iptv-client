import { SYNC_REPO, SYNC_BRANCH, SYNC_TOKEN } from './config.js';

/**
 * The server of the sync: the GitHub repository of SYNC_REPO. Reads the file of an account (with its ETag: an unchanged file answers
 * 304, nothing is downloaded) and sends changes as a repository_dispatch event, which the repository's workflow checks and merges.
 * The token can only read and start that workflow (see docs/SYNC_REPO.md).
 */
const API = 'https://api.github.com';
/** Characters of one event at most (GitHub takes about 64 000); larger sends are split. */
export const MAX_EVENT = 60000;

export function createGithubTransport({ repo = SYNC_REPO, branch = SYNC_BRANCH, token = SYNC_TOKEN, fetchImpl = (...args) => fetch(...args), timeoutMs = 15000 } = {}) {
  const headers = (extra) => ({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...extra });
  const withTimeout = (promise, ms = timeoutMs) => {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('sync server: no answer')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  return {
    /** { status: 'same' } (unchanged since `etag`), { status: 'none' } (no such account), { status: 'ok', file, etag }. Throws offline. */
    async read(account, etag = '', { timeoutMs: readTimeout = timeoutMs } = {}) {
      const url = `${API}/repos/${repo}/contents/users/${account}.json?ref=${encodeURIComponent(branch)}`;
      const res = await withTimeout(fetchImpl(url, { cache: 'no-store', headers: headers({ Accept: 'application/vnd.github.raw+json', ...(etag ? { 'If-None-Match': etag } : {}) }) }), readTimeout);
      if (res.status === 304) return { status: 'same' };
      if (res.status === 404) return { status: 'none' };
      if (!res.ok) throw new Error(`sync server: HTTP ${res.status}`);
      const file = JSON.parse(await res.text());
      return { status: 'ok', file, etag: (res.headers && res.headers.get && res.headers.get('ETag')) || '' };
    },
    /** Sends one event (its payload under MAX_EVENT characters). */
    async send(payload) {
      const res = await withTimeout(
        fetchImpl(`${API}/repos/${repo}/dispatches`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ event_type: 'sync', client_payload: payload }) }),
      );
      if (res.status !== 204 && !res.ok) throw new Error(`sync server: HTTP ${res.status}`);
    },
  };
}
