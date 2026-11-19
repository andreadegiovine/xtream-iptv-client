import 'fake-indexeddb/auto';
import { openProviderDb } from '../../src/db/providerDb.js';
import { openAppDb } from '../../src/db/appDb.js';
import { dbPutMany } from '../../src/core/idb.js';
import { splitNames, peopleFromInfo, writePeople, titlesByName, runPeopleBackfill, countPeople, removePeople } from '../../src/services/peopleIndex.js';
import { createTmdbService, normalizeMeta } from '../../src/services/tmdbService.js';
import { personTitles, personFacts, longDate, yearsBetween, personRoles } from '../../src/ui/pages/personPage.js';

const instant = { run: (fn) => fn() };

test('names of the provider details: split, trimmed, without duplicates', () => {
  expect(splitNames('Will Smith, Martin Lawrence;  Téa Leoni , Will Smith')).toEqual(['Will Smith', 'Martin Lawrence', 'Téa Leoni']);
  expect(peopleFromInfo({ actors: 'A One, B Two', director: 'C Three' })).toEqual({ cast: ['A One', 'B Two'], director: ['C Three'] });
  expect(peopleFromInfo(null)).toEqual({ cast: [], director: [] });
});

test('the people index: a name (any case or accent) finds its titles by role; every title asked once, at the provider pace', async () => {
  const db = await openProviderDb(`people-${Math.random()}`);
  await dbPutMany(db, 'entries', [
    { key: 'movie:i1', type: 'movie', defaultId: 1, added: 10 },
    { key: 'movie:i2', type: 'movie', defaultId: 2, added: 20 },
    { key: 'series:i3', type: 'series', defaultId: 3, added: 30 },
  ]);
  const info = { 1: { cast: 'Will Smith, Martin Lawrence', director: 'Michael Bay' }, 2: { cast: 'Téa Leoni', director: 'Will Smith' }, 3: { cast: 'will smith' } };
  const xtream = { getVodInfo: jest.fn(async (id) => ({ info: info[id] })), getSeriesInfo: jest.fn(async (id) => ({ info: info[id] })) };
  expect(await runPeopleBackfill({ db, xtream, pace: instant, concurrency: 1 })).toBe(3);
  expect((await titlesByName(db, 'cast', 'WILL SMITH')).map((r) => r.key).sort()).toEqual(['movie:i1', 'series:i3']);
  expect((await titlesByName(db, 'director', 'Will Smith')).map((r) => r.key)).toEqual(['movie:i2']);
  expect((await titlesByName(db, 'cast', 'Tea Leoni')).map((r) => r.key)).toEqual(['movie:i2']);
  expect(await countPeople(db)).toBe(3);
  // Asked once: a second run asks nothing.
  expect(await runPeopleBackfill({ db, xtream, pace: instant, concurrency: 1 })).toBe(0);
  expect(xtream.getVodInfo).toHaveBeenCalledTimes(2);
  await writePeople(db, { key: 'movie:i2', type: 'movie', added: 20 }, { cast: '' }); // the title page writes what it reads
  expect(await titlesByName(db, 'cast', 'Tea Leoni')).toEqual([]);
  await removePeople(db);
  expect(await countPeople(db)).toBe(0);
});

test('a person and a company from TMDB: their facts and every title (the credits), kept a day; ids in the credits of a title', async () => {
  const db = await openAppDb(`people-tmdb-${Math.random()}`);
  const client = {
    enabled: true,
    person: jest.fn(async (id, language) => (language === 'it-IT'
      ? { id, name: 'Will Smith', biography: '', birthday: '1968-09-25', place_of_birth: 'Philadelphia', known_for_department: 'Acting', profile_path: '/w.jpg', combined_credits: { cast: [{ media_type: 'movie', id: 9, character: 'Mike Lowrey' }, { media_type: 'tv', id: 7, character: 'Will' }], crew: [{ media_type: 'movie', id: 9, job: 'Producer' }] } }
      : { id, biography: 'English bio' })),
    company: jest.fn(async (id) => ({ id, name: 'Studio', logo_path: '/l.png', headquarters: 'Burbank', origin_country: 'US' })),
    companyTitles: jest.fn(async (type, id, language, page) => ({ results: [{ id: type === 'movie' ? 100 + page : 200 + page }], total_pages: 2 })),
  };
  const svc = createTmdbService({ db, client, getLanguage: () => 'it-IT' });
  const person = await svc.person(31);
  expect(person).toMatchObject({ kind: 'person', name: 'Will Smith', biography: 'English bio', birthday: '1968-09-25', department: 'Acting' });
  expect(person.credits).toEqual([{ type: 'movie', tmdbId: 9, role: 'Mike Lowrey', department: 'Acting' }, { type: 'series', tmdbId: 7, role: 'Will', department: 'Acting' }, { type: 'movie', tmdbId: 9, role: 'Producer', department: '' }]);
  await svc.person(31);
  expect(client.person).toHaveBeenCalledTimes(2); // its page once (plus the English biography), then from the cache
  const company = await svc.company(5);
  expect(company).toMatchObject({ kind: 'company', name: 'Studio', headquarters: 'Burbank', country: 'US' });
  expect(company.credits.map((c) => `${c.type}:${c.tmdbId}`)).toEqual(['movie:101', 'movie:102', 'series:201', 'series:202']);
  const meta = normalizeMeta('movie', { id: 1, credits: { cast: [{ id: 31, name: 'Will Smith', character: 'Mike' }], crew: [{ id: 40, name: 'Michael Bay', job: 'Director' }] } });
  expect(meta.castList[0]).toMatchObject({ id: 31, name: 'Will Smith' });
  expect(meta.directorPeople).toEqual([{ id: 40, name: 'Michael Bay' }]);
  expect(meta.directors).toEqual(['Michael Bay']);
});

test('the titles of a person page: TMDB credits and provider names together, roles under each, newest first, only what the profile may see', async () => {
  const catalog = {
    'movie:t9': { key: 'movie:t9', type: 'movie', added: 10 },
    'series:t7': { key: 'series:t7', type: 'series', added: 30 },
    'movie:i5': { key: 'movie:i5', type: 'movie', added: 20 },
  };
  const info = { credits: [{ type: 'movie', tmdbId: 9, role: 'Mike Lowrey' }, { type: 'movie', tmdbId: 9, role: 'Producer' }, { type: 'series', tmdbId: 7, role: 'Will' }, { type: 'movie', tmdbId: 99, role: 'X' }] };
  const byName = async (role) => (role === 'director' ? [{ key: 'movie:i5' }] : [{ key: 'movie:t9' }]);
  const list = await personTitles({ info, name: 'Will Smith', kind: 'person', getEntryOf: async (key) => catalog[key] || null, byName });
  expect(list.map((e) => `${e.key}=${e.roleText}`)).toEqual(['series:t7=Will', 'movie:i5=Director', 'movie:t9=Mike Lowrey, Producer']);
  // Without TMDB: the names only; a kids profile: what it must not see is not there.
  const only = await personTitles({ info: null, name: 'Will Smith', kind: 'person', getEntryOf: async (key) => (key === 'movie:i5' ? null : catalog[key] || null), byName });
  expect(only.map((e) => `${e.key}=${e.roleText}`)).toEqual(['movie:t9=Cast']);
});

test('facts: born (age), died (age at death), a company headquarters and parent', () => {
  expect(longDate('1968-09-25', 'en-US')).toBe('September 25, 1968');
  expect(yearsBetween('1968-09-25', '', new Date(2026, 10, 18))).toBe(58);
  expect(yearsBetween('1930-05-31', '2010-05-30')).toBe(79);
  expect(personFacts({ kind: 'person', birthday: '1930-05-31', deathday: '2010-05-30', placeOfBirth: 'SF' }, 'en-US')).toEqual(['Born May 31, 1930 · SF', 'Died May 30, 2010 (79 years)']);
  expect(personFacts({ kind: 'company', headquarters: 'Burbank', parent: 'WBD', homepage: 'https://wb.com/' })).toEqual(['Headquarters: Burbank', 'Part of WBD', 'wb.com']);
});

test('the provider database gains the people store without a rebuild', async () => {
  const db = await openProviderDb(`people-upgrade-${Math.random()}`);
  expect(db.objectStoreNames.contains('people')).toBe(true);
});

test('favourite people and companies: by TMDB id (else by name), for every provider, listed on the Favorites page only', async () => {
  const { createFavoritesService, personKey } = await import('../../src/services/favorites.js');
  const { visibleFavorites } = await import('../../src/services/favoriteEntries.js');
  const db = await openAppDb(`people-fav-${Math.random()}`);
  const favorites = createFavoritesService({ db });
  expect(personKey({ kind: 'person', id: 31, name: 'Will Smith' })).toBe('person:t31');
  expect(personKey({ kind: 'person', id: null, name: 'Attore Uno' })).toBe('person:nattore uno');
  expect(await favorites.togglePerson({ kind: 'person', id: 31, name: 'Will Smith', photo: 'p.jpg' })).toBe(true);
  expect(await favorites.togglePerson({ kind: 'company', id: 5, name: 'Studio' })).toBe(true);
  expect(await favorites.hasPerson({ kind: 'person', id: 31 })).toBe(true);
  expect(await favorites.hasPerson({ kind: 'person', id: null, name: 'Will Smith' })).toBe(false); // the key is the TMDB id
  const ctx = { favorites, epg: null, collections: null };
  const current = { provider: { id: 'p2' }, db: await openProviderDb(`people-fav-p-${Math.random()}`) };
  const shown = await visibleFavorites(ctx, current); // another provider: still there
  expect(shown.map((e) => `${e.type}:${e.name}`).sort()).toEqual(['company:Studio', 'person:Will Smith']);
  expect(shown.find((e) => e.type === 'person').person).toEqual({ kind: 'person', id: 31, name: 'Will Smith', photo: 'p.jpg', subtitle: '' });
  // Seen again on its page: the line under its card (roles; a company its counts) kept up to date.
  await favorites.refreshPerson({ kind: 'person', id: 31, name: 'Will Smith', subtitle: 'Acting · Production' });
  await favorites.refreshPerson({ kind: 'company', id: 5, name: 'Studio', subtitle: '12 movies · 3 TV series' });
  const again = await visibleFavorites(ctx, current);
  expect(again.map((e) => `${e.name}=${e.subtitle}`).sort()).toEqual(['Studio=12 movies · 3 TV series', 'Will Smith=Acting · Production']);
  expect(await favorites.togglePerson({ kind: 'person', id: 31, name: 'Will Smith' })).toBe(false);
  expect(await favorites.hasPerson({ kind: 'person', id: 31 })).toBe(false);
});

test('the roles of a person in the info line: known for first, then the most frequent departments; without TMDB the provider roles', () => {
  const info = { department: 'Directing', credits: [{ department: 'Acting' }, { department: 'Acting' }, { department: 'Production' }, { department: 'Directing' }] };
  expect(personRoles(info)).toEqual(['Directing', 'Acting', 'Production']);
  expect(personRoles(null, [{ roleText: 'Cast' }, { roleText: 'Director' }, { roleText: 'Cast' }])).toEqual(['Cast', 'Director']);
});
