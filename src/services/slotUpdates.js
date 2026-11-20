/**
 * Updates kept on the device (the "_autoupdate" packages with the loader of src/boot/loader.js, which gives `window.__XI_SLOTS__`).
 * An update is downloaded into the slot not in use: every file of the build listed in its files.json, checked against its SHA-256, then
 * `slot.json` with state "trial". The loader starts it on trial at the next start (see loader.js); nothing is kept from a download that
 * did not finish (the slot is emptied).
 */

/** The slots of this start, or null (a package that keeps no updates on the device: the older packages load them from the network). */
export const slotsApi = () => (typeof window !== 'undefined' && window.__XI_SLOTS__ ? window.__XI_SLOTS__ : null);

/** The files of a build with their SHA-256: [{ path, sha256 }] from files.json ("all"); null when the build does not list them. */
export async function buildManifest(base, fetchImpl) {
  const res = await fetchImpl(`${base}files.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`files.json: HTTP ${res.status}`);
  const list = (await res.json()).all;
  if (!Array.isArray(list) || !list.length) return null;
  const valid = list.filter((f) => f && /^(js|css|fonts)\/[\w.-]+$/.test(f.path) && /^[0-9a-f]{64}$/.test(f.sha256));
  if (valid.length !== list.length || !valid.some((f) => f.path === 'js/main.js')) throw new Error('files.json: invalid list');
  return valid;
}

async function sha256(bytes, slots) {
  const subtle = typeof crypto !== 'undefined' && crypto.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    try {
      const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
      return Array.prototype.map.call(digest, (b) => `0${b.toString(16)}`.slice(-2)).join('');
    } catch {
      /* not on this page (no secure context): the plain one */
    }
  }
  return slots.sha256Hex(bytes);
}

/**
 * Downloads an update ({ version, base }) into the free slot. `onProgress(done, total)`. Throws when a file cannot be downloaded or does
 * not match its SHA-256 (the slot is emptied).
 */
export async function installToSlot(update, { slots = slotsApi(), fetchImpl = (...args) => fetch(...args), onProgress = null } = {}) {
  if (!slots) throw new Error('no slots on this device');
  const slot = slots.free();
  const present = await slots.meta(slot).catch(() => null);
  if (present && present.version === update.version && present.state === 'trial') return slot; // already downloaded, waiting for a start
  const files = await buildManifest(update.base, fetchImpl);
  if (!files) throw new Error(`version ${update.version} does not list the SHA-256 of its files`);
  await slots.remove(slot);
  try {
    let done = 0;
    for (const file of files) {
      const res = await fetchImpl(`${update.base}${file.path}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${file.path}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) throw new Error(`${file.path}: empty`);
      const hash = await sha256(bytes, slots);
      if (hash !== file.sha256) throw new Error(`${file.path}: SHA-256 does not match`);
      await slots.write(slot, file.path, bytes.buffer);
      done += 1;
      if (onProgress) onProgress(done, files.length);
    }
    // Last: the slot exists for the loader only once every file is there.
    await slots.write(slot, 'slot.json', JSON.stringify({ version: update.version, state: 'trial', files: files.map((f) => f.path), savedAt: Date.now() }));
  } catch (err) {
    await slots.remove(slot).catch(() => undefined);
    throw err;
  }
  return slot;
}

const FAILED_KEY = 'xi.updateFailed';

/** The update that failed its trial start (set by the loader), once: { version, reason, at } or null. */
export function takeFailedUpdate(storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    const raw = storage && storage.getItem(FAILED_KEY);
    if (!raw) return null;
    storage.removeItem(FAILED_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const SKIP_KEY = 'xi.skipVersion';
/** A version that failed its trial is not downloaded again by the check in the background (only when asked from Settings). */
export function skippedVersion(storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    return (storage && storage.getItem(SKIP_KEY)) || '';
  } catch {
    return '';
  }
}
export function skipVersion(version, storage = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    if (storage) storage.setItem(SKIP_KEY, version);
  } catch {
    /* storage not available */
  }
}
