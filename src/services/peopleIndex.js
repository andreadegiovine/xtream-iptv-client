import { dbPut, dbClear, dbGetAllKeys, requestToPromise } from '../core/idb.js';
import { makeSearchKey } from './titleNormalizer.js';
import { createPacer } from './pacer.js';

/**
 * The people the provider names in the details of its titles (`info.cast` / `info.actors`, `info.director`): the person page without TMDB.
 * One record per title in the `people` store of the provider database, indexed by role and folded name ('cast:will smith'), so a name
 * finds its titles at once. Filled by the genre worker (phase "people": every film and series asked once, at an adaptive pace; the genre
 * search writes them too), and by the title page for what it opens. Names are free text: the same spelling is the same person.
 */
export const PEOPLE_STORE = 'people';
const ROLES = ['cast', 'director'];

/** "Will Smith, Martin Lawrence;  Téa Leoni" → ['Will Smith', 'Martin Lawrence', 'Téa Leoni'] (at most 30). */
export function splitNames(text) {
  const out = [];
  String(text || '')
    .split(/[,;/|]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 1)
    .forEach((name) => {
      if (out.indexOf(name) < 0) out.push(name);
    });
  return out.slice(0, 30);
}

/** The names of a provider's details: { cast: [...], director: [...] }. */
export function peopleFromInfo(info) {
  const src = info || {};
  return { cast: splitNames(src.cast || src.actors), director: splitNames(src.director) };
}

export const nameKey = (role, name) => `${role}:${makeSearchKey(name)}`;

/** Saves what the details of `entry` name (an empty record when nothing: it is not asked again). */
export function writePeople(db, entry, info) {
  const people = peopleFromInfo(info);
  const names = [];
  ROLES.forEach((role) => people[role].forEach((name) => {
    const key = nameKey(role, name);
    if (key !== `${role}:` && names.indexOf(key) < 0) names.push(key);
  }));
  return dbPut(db, PEOPLE_STORE, { key: entry.key, type: entry.type, added: entry.added || 0, names });
}

/** The titles naming `name` in `role` ('cast' | 'director'): [{ key, type, added }]. */
export async function titlesByName(db, role, name) {
  if (!db.objectStoreNames.contains(PEOPLE_STORE)) return [];
  const rows = await requestToPromise(db.transaction(PEOPLE_STORE, 'readonly').objectStore(PEOPLE_STORE).index('byName').getAll(nameKey(role, name)));
  return rows.map((row) => ({ key: row.key, type: row.type, added: row.added }));
}

const NAMES_TTL_MS = 10 * 60 * 1000;
const namesCache = new WeakMap(); // db → { readAt, promise: ['cast:will smith', …] }: the distinct names, read once in a while

/** Every distinct name of the store ('cast:will smith', 'director:…'), one pass over the index keys. */
function allNames(db, now = Date.now()) {
  const hit = namesCache.get(db);
  if (hit && now - hit.readAt < NAMES_TTL_MS) return hit.promise;
  const promise = new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(PEOPLE_STORE, 'readonly');
    const request = tx.objectStore(PEOPLE_STORE).index('byName').openKeyCursor(null, 'nextunique');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      out.push(String(cursor.key));
      cursor.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
  namesCache.set(db, { readAt: now, promise });
  promise.catch(() => namesCache.delete(db));
  return promise;
}

/** "will smith" → "Will Smith" (the store keeps the folded spelling only). */
export const displayName = (folded) => String(folded || '').replace(/(^|\s)(\S)/g, (m, space, letter) => space + letter.toUpperCase());

/** True when every word of the query starts a word of the name ("smi" and "will sm" find "will smith"). */
export function nameMatches(folded, query) {
  const words = ` ${folded}`;
  return makeSearchKey(query).split(' ').filter(Boolean).every((w) => words.indexOf(` ${w}`) >= 0);
}

/**
 * The people the provider names whose name matches `query` (the search page without TMDB): [{ name, roles: ['cast', 'director'] }],
 * shorter names first (the closest match), at most `limit`.
 */
export async function peopleMatching(db, query, limit = 30) {
  if (!db.objectStoreNames.contains(PEOPLE_STORE) || makeSearchKey(query).length < 2) return [];
  const found = new Map(); // folded name → roles
  (await allNames(db)).forEach((key) => {
    const cut = key.indexOf(':');
    const role = key.slice(0, cut);
    const folded = key.slice(cut + 1);
    if (!folded || !nameMatches(folded, query)) return;
    if (!found.has(folded)) found.set(folded, []);
    found.get(folded).push(role);
  });
  return Array.from(found.keys())
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
    .slice(0, limit)
    .map((folded) => ({ name: displayName(folded), roles: found.get(folded) }));
}

/** How many titles were asked (the Settings row). */
export const countPeople = (db) => dbGetAllKeys(db, PEOPLE_STORE).then((keys) => keys.length);
export const removePeople = (db) => dbClear(db, PEOPLE_STORE);

/** Films and series not asked yet, newest first (`limit` at most). */
async function missing(db, type, limit, tried) {
  const known = new Set(await dbGetAllKeys(db, PEOPLE_STORE));
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction('entries', 'readonly');
    const request = tx.objectStore('entries').index('byTypeAdded').openCursor(IDBKeyRange.bound([type, 0], [type, Number.MAX_SAFE_INTEGER]), 'prev');
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const entry = cursor.value;
      if (!known.has(entry.key) && !tried.has(entry.key)) out.push(entry);
      if (out.length < limit) cursor.continue();
    };
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => resolve(out);
  });
}

const BATCH = 60;
const MAX_FAILURES = 8;
/**
 * Asks the provider the details of every film and series not asked yet and saves the people they name. Same pace as the genre search
 * (pacer.js); after MAX_FAILURES failures in a row it stops (the next run goes on). Resolves with how many titles were asked.
 */
export async function runPeopleBackfill({ db, xtream, signal = null, gate = () => Promise.resolve(), emit = () => {}, limit = 3000, pace = createPacer({ max: 6, start: 2 }), concurrency = 6 }) {
  let total = 0;
  let failures = 0;
  let stopped = false;
  const aborted = () => Boolean(signal && signal.aborted);
  for (const type of ['movie', 'series']) {
    const tried = new Set();
    let list = await missing(db, type, BATCH, tried);
    while (list.length && total < limit && !stopped && !aborted()) {
      await gate();
      let next = 0;
      const worker = async () => {
        while (next < list.length && total < limit && !stopped && !aborted()) {
          const entry = list[next];
          next += 1;
          await gate();
          tried.add(entry.key);
          try {
            const raw = await pace.run(() => (type === 'series' ? xtream.getSeriesInfo(entry.defaultId) : xtream.getVodInfo(entry.defaultId)));
            failures = 0;
            await writePeople(db, entry, raw && raw.info);
            total += 1;
          } catch (err) {
            failures += 1;
            if (failures >= MAX_FAILURES && !stopped) {
              stopped = true;
              emit({ event: 'info', level: 'warn', message: `People: the provider failed ${failures} times in a row (${(err && err.message) || err}), the search goes on at the next run` });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
      emit({ event: 'progress', done: total });
      list = await missing(db, type, BATCH, tried);
    }
  }
  return total;
}

