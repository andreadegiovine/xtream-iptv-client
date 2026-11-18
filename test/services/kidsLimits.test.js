import 'fake-indexeddb/auto';
import { openAppDb } from '../../src/db/appDb.js';
import { normalizeTime, cleanLimits, outsideHours, ratingAge, outOfRange, hasRange, rangeOf, createKidsLimits, AGES } from '../../src/services/kidsLimits.js';
import { createXmltvParser } from '../../src/services/xmltv.js';

test('times: hh:mm kept, h:mm padded, anything else refused, empty allowed', () => {
  expect(normalizeTime('7:30')).toBe('07:30');
  expect(normalizeTime('21:05')).toBe('21:05');
  expect(normalizeTime('')).toBe('');
  expect(normalizeTime('24:00')).toBe(null);
  expect(normalizeTime('7.30')).toBe(null);
});

test('limits cleaned: bad values dropped, only the ages offered', () => {
  expect(cleanLimits({ before: '7:00', after: 'x', minutes: '90', minAge: 6, maxAge: 12 })).toEqual({ before: '07:00', after: '', minutes: 90, minAge: 6, maxAge: 12 });
  expect(cleanLimits({ maxAge: 11, minutes: -5 })).toEqual({ before: '', after: '', minutes: 0, minAge: null, maxAge: null });
  expect(cleanLimits(null).maxAge).toBe(null);
  expect(AGES[0]).toBe(null);
});

test('hours: before the first allowed time, and from the last one on', () => {
  const at = (h, m = 0) => new Date(2026, 10, 18, h, m);
  const limits = { before: '08:00', after: '20:30' };
  expect(outsideHours(limits, at(7, 59))).toBe(true);
  expect(outsideHours(limits, at(8, 0))).toBe(false);
  expect(outsideHours(limits, at(20, 29))).toBe(false);
  expect(outsideHours(limits, at(20, 30))).toBe(true);
  expect(outsideHours({ before: '', after: '' }, at(3))).toBe(false);
});

test('age of a rating, whatever the country; unknown ones never hide', () => {
  expect(['T', 'G', 'TV-Y', 'U'].map(ratingAge)).toEqual([0, 0, 0, 0]);
  expect(['VM14', 'VM18', '6+', 'M/12', '16', 'PG-13', 'TV-MA', 'R'].map(ratingAge)).toEqual([14, 18, 6, 12, 16, 13, 17, 17]);
  expect(ratingAge('')).toBe(null);
  expect(ratingAge('NR')).toBe(null);
  const upTo12 = { minAge: null, maxAge: 12 };
  expect(outOfRange('VM14', upTo12)).toBe(true);
  expect(outOfRange('12', upTo12)).toBe(false);
  expect(outOfRange('NR', { minAge: 6, maxAge: 6 })).toBe(false); // unknown: never out
  expect(outOfRange('VM18', { minAge: null, maxAge: null })).toBe(false);
  // A minimum too: below it is out (a profile for older kids without the toddler titles)
  const sixToTwelve = { minAge: 6, maxAge: 12 };
  expect(['T', 'TV-Y', '6+', '10', 'PG-13', 'VM14'].map((r) => outOfRange(r, sixToTwelve))).toEqual([true, true, false, false, true, true]);
  expect(hasRange({ minAge: 0, maxAge: null })).toBe(true);
  expect(hasRange({ minAge: null, maxAge: null })).toBe(false);
  expect(rangeOf({ kids: false, limits: sixToTwelve })).toBe(null);
  expect(rangeOf({ kids: true, limits: sixToTwelve })).toBe(sixToTwelve);
});

test('daily minutes: counted in the profile database, a new day starts from zero; hours checked too', async () => {
  const db = await openAppDb(`kids-limits-${Math.random()}`);
  let now = new Date(2026, 10, 18, 10, 0);
  let limits = { before: '', after: '', minutes: 30, maxAge: null };
  const svc = createKidsLimits({ db, getLimits: () => limits, now: () => now });
  expect(await svc.blocked()).toBe('');
  await svc.add(20 * 60000);
  expect(Math.round(await svc.minutesLeft())).toBe(10);
  await svc.add(10 * 60000);
  expect(await svc.blocked()).toBe('minutes');
  // Another service on the same database (the app started again): the same count.
  expect(await createKidsLimits({ db, getLimits: () => limits, now: () => now }).blocked()).toBe('minutes');
  now = new Date(2026, 10, 19, 10, 0);
  expect(await svc.blocked()).toBe('');
  limits = { before: '11:00', after: '', minutes: 0, maxAge: null };
  expect(await svc.blocked()).toBe('hours');
  limits = null;
  expect(await svc.blocked()).toBe('');
  expect(svc.active()).toBe(false);
});

test('the guide gives the age rating of a programme', () => {
  const got = [];
  const parser = createXmltvParser({ now: Date.UTC(2026, 10, 2, 12), onProgramme: (p) => got.push(p) });
  parser.push('<tv><programme start="20261102110000 +0000" stop="20261102130000 +0000" channel="a"><title>Film</title><rating system="IT"><value>VM14</value></rating></programme>'
    + '<programme start="20261102130000 +0000" stop="20261102140000 +0000" channel="a"><title>News</title></programme></tv>');
  expect(got.map((p) => p.rating)).toEqual(['VM14', undefined]);
});
