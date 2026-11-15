import { certificationOf } from '../../src/services/tmdbService.js';

test('age rating: the country of the language of the app, else the US; theatrical release first; series from content ratings', () => {
  const movie = { release_dates: { results: [
    { iso_3166_1: 'US', release_dates: [{ type: 4, certification: '' }, { type: 3, certification: 'PG-13' }] },
    { iso_3166_1: 'IT', release_dates: [{ type: 4, certification: 'VM14' }, { type: 3, certification: 'T' }] },
  ] } };
  expect(certificationOf('movie', movie, 'it-IT')).toBe('T');
  expect(certificationOf('movie', movie, 'en-US')).toBe('PG-13');
  expect(certificationOf('movie', movie, 'de-DE')).toBe('PG-13'); // none for Germany: the US one
  expect(certificationOf('movie', { release_dates: { results: [] } }, 'it-IT')).toBe('');
  const series = { content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }, { iso_3166_1: 'IT', rating: '14+' }] } };
  expect(certificationOf('series', series, 'it')).toBe('14+');
  expect(certificationOf('series', series, 'fr-FR')).toBe('TV-MA');
  expect(certificationOf('series', {}, 'it-IT')).toBe('');
});
