import { dbGetAll, dbPut, dbDelete, deleteDb } from '../../core/idb.js';
import { kvGet, kvSet, kvDelete } from '../../db/kv.js';
import { deleteProviderDb } from '../../db/providerDb.js';
import { PROFILES_KEY, MAIN_ID, profileDbName } from '../profiles.js';

/**
 * What the device sync carries, as "kinds": one per thing that changes on its own, so two TVs changing different things never overwrite
 * each other. A kind is a string; its value is a plain object. Read from the databases (`collectLocal`) and written back (`applyChanges`).
 *
 * Shared by the whole app (app database):
 *   g:settings (without the settings of the device: DEVICE_SETTINGS), g:apiKeys, g:profiles (without their PINs), g:adultMarks,
 *   g:activeProviderId, g:alsoActiveProviderIds, prov:<id> (a provider)
 * Of each profile (<pid> "main": the app database; the others their own database):
 *   <pid>|w:<key> (watch state of a title / episode), <pid>|fav:<id> / pin:<id> / col:<id> (a favourite, a pinned entry, a collection),
 *   <pid>|kv:trakt.token, <pid>|kv:trakt.account, <pid>|kv:subAlign:... (subtitle alignments), <pid>|usage:<device> (minutes a kids
 *   profile watched today on that TV: the TVs add them up)
 * Never: the parental PIN and the profiles' PINs, the settings of the device, scheduled viewing, catalogs, guides, caches, queues.
 */

export const DEVICE_SETTINGS = ['textSize', 'screensaver', 'bufferSeconds'];
const GLOBAL_KV = ['apiKeys', 'adultMarks', 'activeProviderId', 'alsoActiveProviderIds'];
const PROFILE_KV = ['trakt.token', 'trakt.account'];
const PROFILE_KV_PREFIX = ['subAlign:'];
const USAGE_KEY = 'kidsUsage';
export const OTHER_USAGE_KEY = 'kidsUsage.others';

/** Lists kept as one array in a profile's database, synced one element at a time. */
const LISTS = {
  fav: { key: 'favorites', id: (e) => `${e.providerId || ''}|${e.entryKey}`, order: (e) => e.addedAt || 0 },
  pin: { key: 'pins', id: (e) => `${e.kind}|${e.type}|${e.id}`, order: (e) => e.addedAt || 0 },
  col: { key: 'collections', id: (e) => String(e.id), order: (e) => e.createdAt || 0 },
};

/** JSON with the keys of every object sorted: the same value gives the same text on every TV. */
export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
}

/** A quick 53-bit hash of a text (changes only; nothing secret). */
export function hashText(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The section of a kind, for the counts of the Settings page. */
export function sectionOf(kind) {
  if (kind.indexOf('prov:') === 0) return 'providers';
  if (kind === 'g:profiles') return 'profiles';
  if (kind.indexOf('g:') === 0) return 'settings';
  const rest = kind.slice(kind.indexOf('|') + 1);
  if (rest.indexOf('w:') === 0) return 'watch';
  if (rest.indexOf('fav:') === 0) return 'favorites';
  if (rest.indexOf('col:') === 0) return 'collections';
  if (rest.indexOf('pin:') === 0) return 'pins';
  if (rest.indexOf('kv:trakt') === 0) return 'trakt';
  return 'other';
}

const stripSettings = (settings) => {
  const out = { ...settings };
  DEVICE_SETTINGS.forEach((key) => delete out[key]);
  return out;
};
const stripPins = (profiles) => (profiles || []).map((p) => ({ ...p, pin: null }));

/** The profiles of the app: their ids (always "main", with the others when there are profiles). */
export async function profileIds(db) {
  const list = (await kvGet(db, PROFILES_KEY, null)) || [];
  const ids = list.map((p) => p.id);
  if (ids.indexOf(MAIN_ID) < 0) ids.unshift(MAIN_ID);
  return ids;
}

/**
 * Everything this TV has that is synced: Map(kind → value). `openProfileDb(pid)` opens the database of a profile other than the main one
 * (closed again here). `device`: this TV's name (its kids minutes).
 */
export async function collectLocal({ db, openProfileDb, device }) {
  const out = new Map();
  const settings = await kvGet(db, 'settings', null);
  if (settings) out.set('g:settings', stripSettings(settings));
  const profiles = await kvGet(db, PROFILES_KEY, null);
  if (profiles && profiles.length) out.set('g:profiles', stripPins(profiles));
  for (const key of GLOBAL_KV) {
    const value = await kvGet(db, key, undefined);
    if (value !== undefined && value !== null) out.set(`g:${key}`, value);
  }
  (await dbGetAll(db, 'providers')).forEach((p) => out.set(`prov:${p.id}`, p));

  for (const pid of await profileIds(db)) {
    const pdb = pid === MAIN_ID ? db : await openProfileDb(pid);
    try {
      const kvs = await dbGetAll(pdb, 'kv');
      const byKey = new Map(kvs.map((r) => [r.key, r.value]));
      PROFILE_KV.forEach((key) => {
        if (byKey.has(key) && byKey.get(key) !== null && byKey.get(key) !== undefined) out.set(`${pid}|kv:${key}`, byKey.get(key));
      });
      kvs.forEach((r) => {
        if (PROFILE_KV_PREFIX.some((prefix) => r.key.indexOf(prefix) === 0) && r.value !== null && r.value !== undefined) out.set(`${pid}|kv:${r.key}`, r.value);
      });
      Object.keys(LISTS).forEach((tag) => {
        const list = byKey.get(LISTS[tag].key);
        if (Array.isArray(list)) list.forEach((e) => e && out.set(`${pid}|${tag}:${LISTS[tag].id(e)}`, e));
      });
      const usage = byKey.get(USAGE_KEY);
      if (usage && usage.day && usage.ms > 0) out.set(`${pid}|usage:${device}`, { day: usage.day, ms: usage.ms });
      (await dbGetAll(pdb, 'watch')).forEach((w) => out.set(`${pid}|w:${w.key}`, w));
    } finally {
      if (pid !== MAIN_ID && pdb && pdb.close) pdb.close();
    }
  }
  return out;
}

/**
 * Writes changes into the databases: [{ kind, value }] (value null: removed). Global kinds first (the profiles), then each profile's in
 * one go. `device`: this TV (its own kids minutes are never taken from another TV).
 */
export async function applyChanges({ db, openProfileDb, device, changes, removeProfileDb = deleteDb, removeProviderDb = deleteProviderDb }) {
  const global = changes.filter((c) => c.kind.indexOf('g:') === 0 || c.kind.indexOf('prov:') === 0);
  const perProfile = new Map();
  changes
    .filter((c) => global.indexOf(c) < 0)
    .forEach((c) => {
      const pid = c.kind.slice(0, c.kind.indexOf('|'));
      if (!pid) return;
      if (!perProfile.has(pid)) perProfile.set(pid, []);
      perProfile.get(pid).push(c);
    });

  for (const { kind, value } of global) {
    if (kind === 'g:settings') {
      const local = (await kvGet(db, 'settings', null)) || {};
      const device = {};
      DEVICE_SETTINGS.forEach((key) => {
        if (key in local) device[key] = local[key];
      });
      if (value) await kvSet(db, 'settings', { ...value, ...device });
      else await kvSet(db, 'settings', device);
    } else if (kind === 'g:profiles') {
      const local = (await kvGet(db, PROFILES_KEY, null)) || [];
      const pins = new Map(local.map((p) => [p.id, p.pin || null]));
      const next = (value || []).map((p) => ({ ...p, pin: pins.has(p.id) ? pins.get(p.id) : null }));
      await kvSet(db, PROFILES_KEY, next);
      // A profile removed on another TV: its data goes here too.
      const kept = new Set(next.map((p) => p.id));
      for (const p of local) if (p.id !== MAIN_ID && !kept.has(p.id)) await removeProfileDb(profileDbName(p.id)).catch(() => undefined);
    } else if (kind.indexOf('g:') === 0) {
      const key = kind.slice(2);
      if (value === null || value === undefined) await kvDelete(db, key);
      else await kvSet(db, key, value);
    } else {
      const id = kind.slice(5);
      if (value) await dbPut(db, 'providers', { ...value, id });
      else {
        await dbDelete(db, 'providers', id);
        await removeProviderDb(id).catch(() => undefined);
      }
    }
  }

  for (const [pid, list] of perProfile) {
    const pdb = pid === MAIN_ID ? db : await openProfileDb(pid);
    try {
      const lists = {};
      for (const { kind, value } of list) {
        const rest = kind.slice(pid.length + 1);
        const tag = rest.slice(0, rest.indexOf(':'));
        const id = rest.slice(tag.length + 1);
        if (tag === 'w') {
          if (value) await dbPut(pdb, 'watch', { ...value, key: id });
          else await dbDelete(pdb, 'watch', id);
        } else if (tag === 'kv') {
          if (value === null || value === undefined) await kvDelete(pdb, id);
          else await kvSet(pdb, id, value);
        } else if (tag === 'usage') {
          if (id === device) continue;
          const others = (await kvGet(pdb, OTHER_USAGE_KEY, null)) || {};
          if (value) others[id] = { day: value.day, ms: value.ms };
          else delete others[id];
          await kvSet(pdb, OTHER_USAGE_KEY, others);
        } else if (LISTS[tag]) {
          if (!lists[tag]) lists[tag] = [];
          lists[tag].push({ id, value });
        }
      }
      for (const tag of Object.keys(lists)) {
        const spec = LISTS[tag];
        const current = (await kvGet(pdb, spec.key, null)) || [];
        const byId = new Map(current.map((e) => [spec.id(e), e]));
        lists[tag].forEach(({ id, value }) => {
          if (value) byId.set(id, value);
          else byId.delete(id);
        });
        // The order of the list: the one it had, the new ones where their date puts them.
        const next = Array.from(byId.values()).sort((a, b) => spec.order(a) - spec.order(b));
        await kvSet(pdb, spec.key, next);
      }
    } finally {
      if (pid !== MAIN_ID && pdb && pdb.close) pdb.close();
    }
  }
}

/** Every synced thing of this TV removed (before taking what an account holds: "replace the data of this TV"). */
export async function clearLocal({ db, openProfileDb, device }) {
  const local = await collectLocal({ db, openProfileDb, device });
  // The settings are replaced, never emptied. The data of the other profiles goes with their databases (removed with the profiles list).
  const changes = Array.from(local.keys())
    .filter((kind) => kind !== 'g:settings' && (kind.indexOf('|') < 0 || kind.indexOf(`${MAIN_ID}|`) === 0))
    .map((kind) => ({ kind, value: null }));
  await applyChanges({ db, openProfileDb, device, changes });
}
