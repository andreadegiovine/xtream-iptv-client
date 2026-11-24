import { AppError, ErrorCode } from './errors.js';

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

/** Opens a database; `upgrade(db, oldVersion, newVersion, tx)` runs inside the versionchange tx. */
/**
 * Called when a connection of this context is closed because a newer schema was opened elsewhere (another context of a newer build): its
 * reads would fail from then on, every page showing nothing. The app sets it (main.js: log and start again); workers leave it empty.
 */
let versionChangeHandler = null;
export function onVersionChange(handler) {
  versionChangeHandler = handler;
}

export function openDb(name, version, { upgrade } = {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = (event) => {
      try {
        if (upgrade) upgrade(request.result, event.oldVersion, event.newVersion, request.transaction);
      } catch (err) {
        request.transaction.abort();
        reject(new AppError(ErrorCode.STORAGE, 'Database upgrade failed', { cause: err }));
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = (event) => {
        db.close();
        // (A database being deleted — a provider removed, a reset — has no new version: not a newer schema.)
        if (versionChangeHandler && event && event.newVersion) versionChangeHandler({ name, from: event.oldVersion, to: event.newVersion });
      };
      resolve(db);
    };
    request.onerror = () =>
      reject(new AppError(ErrorCode.STORAGE, 'Cannot open database', { cause: request.error }));
    request.onblocked = () =>
      reject(new AppError(ErrorCode.STORAGE, 'Database is blocked by another connection'));
  });
}

/** Runs stepwise migrations: migrations[n] upgrades the schema from n-1 to n. */
export function runMigrations(db, tx, oldVersion, newVersion, migrations) {
  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    const migrate = migrations[version];
    if (!migrate) throw new Error(`Missing migration to version ${version}`);
    migrate(db, tx);
  }
}

export function deleteDb(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

/**
 * How many writes went to the stores the device sync carries (kv, watch, providers) since the start: its background round reads every
 * synced thing only when this moved (services/sync/engine.js).
 */
const SYNCED = { kv: true, watch: true, providers: true };
let syncedWrites = 0;
export const syncedWriteCount = () => syncedWrites;
const noteWrite = (store) => {
  if (SYNCED[store]) syncedWrites += 1;
};

export function dbGet(db, store, key) {
  return requestToPromise(db.transaction(store).objectStore(store).get(key));
}

export function dbGetAll(db, store) {
  return requestToPromise(db.transaction(store).objectStore(store).getAll());
}

export function dbPut(db, store, value) {
  noteWrite(store);
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return transactionDone(tx);
}

/**
 * Writes in batches so one huge transaction never blocks the UI thread.
 * `onBatch(done, total)` is awaited after each batch (progress, pausing, cancellation).
 */
export async function dbPutMany(db, store, values, batchSize = 2000, onBatch) {
  noteWrite(store);
  for (let i = 0; i < values.length; i += batchSize) {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    values.slice(i, i + batchSize).forEach((value) => os.put(value));
    await transactionDone(tx);
    if (onBatch) await onBatch(Math.min(i + batchSize, values.length), values.length);
  }
}

/** Primary keys of a store (or of an index range), without reading the values. */
export function dbGetAllKeys(db, store, { index, range } = {}) {
  const os = db.transaction(store).objectStore(store);
  return requestToPromise((index ? os.index(index) : os).getAllKeys(range));
}

export function dbGetAllRange(db, store, range) {
  return requestToPromise(db.transaction(store).objectStore(store).getAll(range));
}

export async function dbDeleteMany(db, store, keys, batchSize = 2000) {
  noteWrite(store);
  for (let i = 0; i < keys.length; i += batchSize) {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    keys.slice(i, i + batchSize).forEach((key) => os.delete(key));
    await transactionDone(tx);
  }
}

export function dbDelete(db, store, key) {
  noteWrite(store);
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return transactionDone(tx);
}

export function dbClear(db, store) {
  noteWrite(store);
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return transactionDone(tx);
}
