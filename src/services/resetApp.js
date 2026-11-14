import { deleteDb, transactionDone } from '../core/idb.js';
import { providerDbName } from '../db/providerDb.js';
import { PROFILE_DB_PREFIX, PROFILES_KEY, MAIN_ID, profileDbName } from './profiles.js';
import { kvGet } from '../db/kv.js';

/** Empties every object store of an open database (the app DB stays open: the page is reloaded afterwards). */
export async function clearAllStores(db) {
  const names = Array.from(db.objectStoreNames);
  if (!names.length) return;
  const tx = db.transaction(names, 'readwrite');
  names.forEach((name) => tx.objectStore(name).clear());
  await transactionDone(tx);
}

/**
 * Back to the first start: stops background work, deletes every provider database and all app data
 * (providers, settings, keys, watch state, favourites, caches) and the browser storage.
 */
export async function resetApp({ db, providers, stopWork = () => {}, storages = [], databases = () => (typeof indexedDB !== 'undefined' && indexedDB.databases ? indexedDB.databases() : Promise.resolve([])) }) {
  stopWork();
  const names = new Set((await providers.list()).map((p) => providerDbName(p.id)));
  // The databases of the profiles too (their names are in the profile list, emptied with the app database).
  ((await kvGet(db, PROFILES_KEY, null)) || []).forEach((p) => p.id !== MAIN_ID && names.add(profileDbName(p.id)));
  try {
    (await databases()).forEach((info) => info && (/^provider_/.test(info.name) || info.name.indexOf(PROFILE_DB_PREFIX) === 0) && names.add(info.name));
  } catch {
    /* listing not supported: the known providers are enough */
  }
  for (const name of names) await deleteDb(name);
  await clearAllStores(db);
  storages.forEach((storage) => {
    try {
      storage.clear();
    } catch {
      /* storage unavailable */
    }
  });
}
