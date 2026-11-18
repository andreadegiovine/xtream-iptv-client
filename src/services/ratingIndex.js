import { visibleKeys } from './catalogQuery.js';
import { readRatings } from './ratingBuild.js';

/**
 * The age ratings of the catalog for the sidebar's "Rating" group of Movies and TV Series: the record the genre worker writes (phase
 * "ratings", ratingBuild.js), read once per provider and kept until `invalidate()` (the catalog or the ratings changed). Only what this
 * profile may see is listed and counted.
 */
export function createRatingIndex({ active, getLanguage }) {
  let job = null; // { db, promise of the record or null }

  async function record() {
    const current = await active.get();
    if (!current) return null;
    if (!job || job.db !== current.db) job = { db: current.db, promise: readRatings(current.db, getLanguage()).catch(() => null) };
    return job.promise;
  }

  return {
    /** The ratings of a type as [{ age, count }], youngest first. */
    async list(type) {
      const saved = await record();
      const groups = (saved && saved[type]) || {};
      return Object.keys(groups)
        .map(Number)
        .sort((a, b) => a - b)
        .map((age) => ({ age, count: visibleKeys(groups[age]).length }))
        .filter((g) => g.count > 0);
    },
    /** The keys of the titles of one rating (an age), newest first. */
    async entryKeys(type, age) {
      const saved = await record();
      return visibleKeys((saved && saved[type] && saved[type][Number(age)]) || []);
    },
    /** Every rated title: Map(entry key → age) (the kids profiles' range). */
    async ages() {
      const saved = await record();
      const out = new Map();
      if (saved) ['movie', 'series'].forEach((type) => Object.keys(saved[type] || {}).forEach((age) => saved[type][age].forEach((key) => out.set(key, Number(age)))));
      return out;
    },
    invalidate() {
      job = null;
    },
  };
}
