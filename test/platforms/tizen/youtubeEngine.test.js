import { videoIdOf, youtubeStreamUrl, playerPageUrl, applyBridgeMessage, createYouTubeEngine, waitForService, YOUTUBE_SERVICE_PORT } from '../../../platforms/tizen/youtubeEngine.js';
import { trailerKeyOf } from '../../../src/services/tmdbService.js';

const handlers = () => ({ onPrepared: jest.fn(), onEnded: jest.fn(), onBuffering: jest.fn(), onBufferingDone: jest.fn(), onError: jest.fn() });

test('stream url round trip', () => {
  expect(videoIdOf(youtubeStreamUrl('dQw4w9WgXcQ'))).toBe('dQw4w9WgXcQ');
  expect(videoIdOf('http://x/a.mp4')).toBe('');
});

test('player page: the on-TV service from a package, the page next to the app otherwise', () => {
  expect(playerPageUrl('abc', { protocol: 'file:' })).toBe(`http://localhost:${YOUTUBE_SERVICE_PORT}/player.html?videoId=abc`);
  expect(playerPageUrl('abc', { protocol: 'http:' })).toBe('yt-player.html?videoId=abc');
});

test('bridge messages drive the engine handlers and the clock', () => {
  const h = handlers();
  const clock = { time: 0, duration: 0 };
  applyBridgeMessage({ __ytbridge: true, type: 'ready' }, h, clock);
  applyBridgeMessage({ __ytbridge: true, type: 'time', t: 12000, d: 90000 }, h, clock);
  applyBridgeMessage({ __ytbridge: true, type: 'state', data: 3 }, h, clock);
  applyBridgeMessage({ __ytbridge: true, type: 'state', data: 1 }, h, clock);
  applyBridgeMessage({ __ytbridge: true, type: 'state', data: 0 }, h, clock);
  applyBridgeMessage({ __ytbridge: true, type: 'error', data: 153 }, h, clock);
  applyBridgeMessage({ type: 'ready' }, h, clock); // not from the bridge
  expect(h.onPrepared).toHaveBeenCalledTimes(1);
  expect(clock).toEqual({ time: 12000, duration: 90000 });
  expect(h.onBuffering).toHaveBeenCalled();
  expect(h.onBufferingDone).toHaveBeenCalled();
  expect(h.onEnded).toHaveBeenCalled();
  expect(h.onError).toHaveBeenCalledWith('YouTube 153');
});

test('the engine puts the player page in an iframe behind the app and removes it on stop', async () => {
  const engine = createYouTubeEngine();
  engine.start('youtube:dQw4w9WgXcQ', { handlers: handlers() });
  const frame = document.querySelector('iframe');
  expect(frame).not.toBeNull();
  expect(document.body.classList.contains('video-active')).toBe(true);
  await new Promise((r) => setTimeout(r, 5));
  expect(frame.getAttribute('src')).toBe('yt-player.html?videoId=dQw4w9WgXcQ');
  expect(engine.getSubtitleTracks()).toEqual([]);
  engine.stop();
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.body.classList.contains('video-active')).toBe(false);
});

test('TMDB trailer: UI language first, trailers before teasers, YouTube only', () => {
  const videos = { results: [
    { site: 'Vimeo', key: 'v1', type: 'Trailer', iso_639_1: 'it' },
    { site: 'YouTube', key: 'en1', type: 'Trailer', iso_639_1: 'en' },
    { site: 'YouTube', key: 'it-teaser', type: 'Teaser', iso_639_1: 'it' },
    { site: 'YouTube', key: 'it1', type: 'Trailer', iso_639_1: 'it' },
  ] };
  expect(trailerKeyOf(videos, 'it-IT')).toBe('it1');
  expect(trailerKeyOf(videos, 'de-DE')).toBe('en1');
  expect(trailerKeyOf({ results: [] }, 'it-IT')).toBe('');
  expect(trailerKeyOf(undefined)).toBe('');
});

describe('waitForService (the first trailer after the TV started)', () => {
  const file = { protocol: 'file:' };
  test('asks /health until the service listens, then the page can load', async () => {
    let calls = 0;
    const fetchImpl = jest.fn(async (url) => {
      calls += 1;
      expect(url).toBe(`http://localhost:${YOUTUBE_SERVICE_PORT}/health`);
      if (calls < 4) throw new TypeError('Failed to fetch'); // connection refused: not listening yet
      return { ok: true };
    });
    let t = 0;
    const up = await waitForService({ fetchImpl, location: file, now: () => t, wait: async (ms) => { t += ms; } });
    expect(up).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  test('gives up after the limit (the page loads anyway); nothing to wait for outside a package', async () => {
    let t = 0;
    const fetchImpl = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await waitForService({ fetchImpl, location: file, limitMs: 1000, pollMs: 300, now: () => t, wait: async (ms) => { t += ms; } })).toBe(false);
    const never = jest.fn();
    expect(await waitForService({ fetchImpl: never, location: { protocol: 'http:' } })).toBe(true);
    expect(never).not.toHaveBeenCalled();
  });
});

test('TMDB trailer: a subtitled one in the language of the app comes after the original; only a dubbed one is "local"', async () => {
  const { trailerOf, SUBTITLED_VIDEO } = await import('../../../src/services/tmdbService.js');
  ['Trailer Sub ITA', 'Trailer (SUB)', 'Teaser sottotitolato', 'Trailer Sottotitolato in italiano', 'VOSTFR', 'Trailer Legendado', 'Trailer [subbed]'].forEach((name) => expect(SUBTITLED_VIDEO.test(name)).toBe(true));
  ['Trailer Italiano Ufficiale', 'Official Trailer', 'Teaser Trailer', 'Submarine Trailer', 'Trailer 2'].forEach((name) => expect(SUBTITLED_VIDEO.test(name)).toBe(false));
  const videos = (list) => ({ results: list.map(([key, lang, type, name]) => ({ site: 'YouTube', key, iso_639_1: lang, type, name })) });
  const subbedOnly = videos([['itsub', 'it', 'Trailer', 'Trailer Sub ITA'], ['en1', 'en', 'Trailer', 'Official Trailer']]);
  expect(trailerOf(subbedOnly, 'it-IT')).toEqual({ key: 'en1', local: false });
  expect(trailerOf(videos([['itsub', 'it', 'Trailer', 'Trailer Sub ITA']]), 'it-IT')).toEqual({ key: 'itsub', local: false }); // nothing else
  // A dubbed teaser beats an English trailer: the language first.
  expect(trailerOf(videos([['en1', 'en', 'Trailer', 'Official Trailer'], ['itt', 'it', 'Teaser', 'Teaser Italiano']]), 'it-IT')).toEqual({ key: 'itt', local: true });
});
