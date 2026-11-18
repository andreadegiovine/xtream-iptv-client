import { dbPut, dbGet, dbDelete } from '../core/idb.js';
import { ratingAge } from './kidsLimits.js';

/**
 * The age ratings of the catalog, worked out in the background (the genre worker, phase "ratings", after the TMDB download): every film
 * and series with a TMDB id gets the age of its TMDB rating (country of the language of the app; "VM14" and "14+" are both 14), read from
 * the metadata saved in the app database. Kept in the provider database as one record (`meta` RATINGS_KEY):
 * { language, builtAt, movie: { [age]: [entry key, newest first] }, series: {…} }. Titles without a known rating are in no group.
 * Read by the sidebar's "Rating" group (ratingIndex.js) and by the kids profiles' rating range (main.js).
 */
export const RATINGS_KEY = 'ratings';
const TYPES = ['movie', 'series'];

/** Walks a cursor without holding anything but what `each` keeps. */
function walk(store, { index = null, range = null, direction = 'next' }, each) {
  return new Promise((resolve, reject) => {
    const source = index ? store.index(index) : store;
    const request = source.openCursor(range, direction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      each(cursor.value);
      cursor.continue();
    };
  });
}

/** Builds and saves the record. Resolves with how many titles have a rating. */
export async function buildRatings({ db, appDb, language, signal = null, gate = () => Promise.resolve(), emit = () => {} }) {
  const aborted = () => Boolean(signal && signal.aborted);
  await gate();
  const suffix = `:${language}`;
  const ages = new Map(); // `type:tmdbId` → age
  await walk(appDb.transaction('tmdb', 'readonly').objectStore('tmdb'), { range: IDBKeyRange.bound('meta:', 'meta:￿') }, (record) => {
    const key = String(record.key);
    if (!key.endsWith(suffix) || !record.value || !record.value.certification) return;
    const age = ratingAge(record.value.certification);
    if (age !== null) ages.set(key.slice(5, key.length - suffix.length), age); // meta:<type>:<tmdbId>:<language>
  });
  if (aborted()) return 0;
  const out = { key: RATINGS_KEY, language, builtAt: Date.now() };
  let rated = 0;
  for (const type of TYPES) {
    await gate();
    if (aborted()) return 0;
    const groups = {};
    await walk(db.transaction('entries', 'readonly').objectStore('entries'), { index: 'byTypeAdded', range: IDBKeyRange.bound([type, 0], [type, Number.MAX_SAFE_INTEGER]), direction: 'prev' }, (entry) => {
      if (!entry.tmdbId) return;
      const age = ages.get(`${type}:${entry.tmdbId}`);
      if (age === undefined) return;
      (groups[age] = groups[age] || []).push(entry.key);
      rated += 1;
    });
    out[type] = groups;
  }
  if (aborted()) return 0;
  await dbPut(db, 'meta', out);
  emit({ event: 'info', message: `Ratings: ${rated} titles` });
  return rated;
}

/** The saved record (null when there is none, or it was worked out for another language). */
export async function readRatings(db, language) {
  const record = await dbGet(db, 'meta', RATINGS_KEY);
  return record && record.language === language ? record : null;
}

export const removeRatings = (db) => dbDelete(db, 'meta', RATINGS_KEY);
