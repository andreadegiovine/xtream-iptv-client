import { sha256, utf8 } from '../core/crypto.js';

/**
 * Trial and activation of the "_trial" builds (docs/LICENSING.md). The device has a key made from an id of the system that stays the same
 * across reinstalls (Tizen DUID, webOS LGUDID, ANDROID_ID, the computer's id: `platform.deviceId()`); the id itself never leaves the
 * device, only its key. The licence service (a Cloudflare worker over a private GitHub repository) says whether the key was paid for
 * or when its trial ends, the trial starting on the server the first time the key is seen (reinstalling does not start it again).
 * Once activated, it is saved here and the service is not asked again.
 */
export const TRIAL_DAYS = 30;
// Never checked (no network, or the service unreachable since the first start): the app works this long, then it waits for a check.
export const OFFLINE_GRACE_MS = 3 * 24 * 3600 * 1000;
export const LICENSE_KV = 'license';
const CHECK_TIMEOUT_MS = 15000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U (read aloud or typed without mistakes)
export const KEY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** The key of a device id: 60 bits of SHA-256("xtream-iptv:" + id) in base32, as "ABCD-EFGH-JKMN". */
export async function deviceKeyOf(rawId) {
  const hash = await sha256(utf8(`xtream-iptv:${rawId}`));
  let bits = '';
  for (let i = 0; i < 8; i += 1) bits += `0000000${hash[i].toString(2)}`.slice(-8);
  let out = '';
  for (let i = 0; i < 12; i += 1) out += ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/**
 * What the app may do: { state: 'active' | 'trial' | 'expired' | 'pending', key, endsAt?, left? (ms) }. `pending`: never checked, within
 * the offline grace; `expired` with `offline: true`: never checked and the grace is over (a check is needed, not a payment).
 */
export function statusOf(saved, key, now) {
  if (!saved || saved.key !== key) return { state: 'pending', key };
  if (saved.active) return { state: 'active', key };
  if (saved.endsAt) {
    const left = saved.endsAt - (now + (saved.skew || 0));
    return { state: left > 0 ? 'trial' : 'expired', key, endsAt: saved.endsAt, left: Math.max(0, left) };
  }
  if (saved.firstSeen && now - saved.firstSeen >= OFFLINE_GRACE_MS) return { state: 'expired', key, offline: true };
  return { state: 'pending', key };
}

/** "12 days, 4 hours" style parts of a countdown: { days, hours, minutes }. */
export function countdownParts(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 };
}

/**
 * `store`: { get(), set(value) } of the saved record; `deviceId()`: Promise of the system's id (null where there is none: a random id
 * kept in `fallbackStorage`, for the browser of development); `url`: the licence service.
 */
export function createLicensing({ store, deviceId = async () => null, fallbackStorage = null, url = '', fetchImpl = (...args) => fetch(...args), now = () => Date.now() }) {
  let keyPromise = null;
  let last = null;
  const listeners = new Set();

  function key() {
    if (!keyPromise) {
      keyPromise = Promise.resolve()
        .then(() => deviceId())
        .catch(() => null)
        .then((id) => deviceKeyOf(id || fallbackId()));
    }
    return keyPromise;
  }

  /** No id from the system (a browser): a random one, kept as long as the browser keeps it. */
  function fallbackId() {
    const name = 'xtream-device-id';
    try {
      let id = fallbackStorage && fallbackStorage.getItem(name);
      if (!id) {
        id = `browser-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        if (fallbackStorage) fallbackStorage.setItem(name, id);
      }
      return id;
    } catch {
      return 'browser';
    }
  }

  function publish(status) {
    last = status;
    listeners.forEach((fn) => fn(status));
    return status;
  }

  async function ask(k) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller && controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${url}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k }), signal: controller ? controller.signal : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The state of this device: activated (saved: never asked again), otherwise asked to the service (the trial's end, started there on
   * the first request); without an answer, what was saved (the trial's end on the clock of the TV, corrected by the last answer's).
   */
  async function check() {
    const k = await key();
    const saved = await store.get().catch(() => null);
    if (saved && saved.key === k && saved.active) return publish(statusOf(saved, k, now()));
    let answer = null;
    try {
      answer = url ? await ask(k) : null;
    } catch {
      answer = null;
    }
    let record = saved && saved.key === k ? saved : { key: k, firstSeen: now() };
    if (answer && answer.active) record = { key: k, active: true, activatedAt: now() };
    else if (answer && answer.endsAt) record = { key: k, endsAt: Number(answer.endsAt), skew: answer.now ? Number(answer.now) - now() : 0, checkedAt: now() };
    if (record !== saved) await store.set(record).catch(() => undefined);
    return publish(statusOf(record, k, now()));
  }

  return {
    key,
    check,
    /** The last state known (null before the first check). */
    status: () => last,
    /** The same state with the countdown worked out again now (no request). */
    refresh: async () => publish(statusOf(await store.get().catch(() => null), await key(), now())),
    /** fn(status) at every check. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The page that pays for this device (the QR code). */
    payUrl: async () => `${url}/pay?key=${encodeURIComponent(await key())}`,
  };
}
