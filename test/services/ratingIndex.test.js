import 'fake-indexeddb/auto';
import { openProviderDb } from '../../src/db/providerDb.js';
import { openAppDb } from '../../src/db/appDb.js';
import { dbPutMany } from '../../src/core/idb.js';
import { buildRatings, readRatings, removeRatings } from '../../src/services/ratingBuild.js';
import { createRatingIndex } from '../../src/services/ratingIndex.js';
import { setHidden } from '../../src/services/catalogQuery.js';

const meta = (type, id, certification, language = 'it-IT') => ({ key: `meta:${type}:${id}:${language}`, value: { tmdbId: id, title: '', certification }, fetchedAt: 1, expiresAt: Date.now() + 1e9 });

async function seed() {
  const db = await openProviderDb(`rating-index-${Math.random()}`);
  const appDb = await openAppDb(`rating-app-${Math.random()}`);
  await dbPutMany(db, 'entries', [
    { key: 'movie:t1', type: 'movie', tmdbId: 1, added: 10 },
    { key: 'movie:t2', type: 'movie', tmdbId: 2, added: 30 },
    { key: 'movie:t3', type: 'movie', tmdbId: 3, added: 20 },
    { key: 'movie:t4', type: 'movie', tmdbId: 4, added: 40 },
    { key: 'movie:i5', type: 'movie', added: 50 },
    { key: 'series:t1', type: 'series', tmdbId: 1, added: 5 },
  ]);
  await dbPutMany(appDb, 'tmdb', [meta('movie', 1, 'T'), meta('movie', 2, 'VM14'), meta('movie', 3, '14+'), meta('movie', 4, 'NR'), meta('series', 1, 'TV-MA'), meta('movie', 4, '18', 'en-US')]);
  return { db, appDb };
}

test('worked out in the background: titles grouped by the age of their rating ("VM14" and "14+" together), newest first, in the language of the app', async () => {
  const { db, appDb } = await seed();
  expect(await buildRatings({ db, appDb, language: 'it-IT' })).toBe(4);
  const saved = await readRatings(db, 'it-IT');
  expect(saved.movie).toEqual({ 0: ['movie:t1'], 14: ['movie:t2', 'movie:t3'] });
  expect(saved.series).toEqual({ 17: ['series:t1'] });
  expect(await readRatings(db, 'en-US')).toBe(null); // another language: worked out again
  const index = createRatingIndex({ active: { get: async () => ({ db }) }, getLanguage: () => 'it-IT' });
  expect(await index.list('movie')).toEqual([{ age: 0, count: 1 }, { age: 14, count: 2 }]);
  expect(await index.entryKeys('movie', '14')).toEqual(['movie:t2', 'movie:t3']);
  expect(Array.from((await index.ages()).entries()).sort()).toEqual([['movie:t1', 0], ['movie:t2', 14], ['movie:t3', 14], ['series:t1', 17]]);
  // A kids profile: hidden titles are not counted nor listed (a rating left empty goes).
  setHidden({ keys: new Set(['movie:t1', 'movie:t3']) });
  try {
    expect(await index.list('movie')).toEqual([{ age: 14, count: 1 }]);
    expect(await index.entryKeys('movie', 14)).toEqual(['movie:t2']);
  } finally {
    setHidden(null);
  }
  await removeRatings(db);
  expect(await index.list('movie')).toHaveLength(2); // kept until invalidated
  index.invalidate();
  expect(await index.list('movie')).toEqual([]);
});

test('a cancelled run writes nothing', async () => {
  const { db, appDb } = await seed();
  const controller = new AbortController();
  controller.abort();
  expect(await buildRatings({ db, appDb, language: 'it-IT', signal: controller.signal })).toBe(0);
  expect(await readRatings(db, 'it-IT')).toBe(null);
});
