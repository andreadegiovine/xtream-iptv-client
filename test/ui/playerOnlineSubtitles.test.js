import { createPlayerPage } from '../../src/ui/pages/playerPage.js';
import { Action } from '../../src/core/input.js';
import { createNoticeService } from '../../src/ui/components/notice.js';

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ tracks = [], fetch, fileFetch = async () => ({ status: 404, headers: { get: () => null } }), url = 'http://h/movie/1.mp4', entryKey = 'movie:t603', tmdbId = null }) {
  let handlers = null;
  let now = 0;
  const engine = {
    available: () => true,
    start: jest.fn((url, opts) => {
      handlers = opts.handlers;
    }),
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    stop: jest.fn(),
    getTime: () => now,
    getDuration: () => 600000,
    getSubtitleTracks: () => tracks,
    setSubtitleTrack: jest.fn(),
  };
  const client = { streamUrl: () => url };
  const notices = createNoticeService({ root: document.body });
  const ctx = {
    createEngine: () => engine,
    notices,
    catalog: { pause() {}, resume() {} },
    settings: { get: async () => ({ bufferSeconds: 5, timeFormat: '24h' }) },
    active: { get: async () => ({ provider: { id: 'p' }, client, db: null }), authenticatedClient: async () => client },
    watch: { get: async () => null, save: async () => null },
    dialogs: { isOpen: () => false, choose: jest.fn() },
    router: { back: jest.fn() },
    openSubtitles: { enabled: true, fetch: jest.fn(fetch) },
    fetch: fileFetch,
  };
  const page = createPlayerPage(ctx, { type: 'movie', entryKey, tmdbId, title: 'Matrix', playlist: [{ id: 1, ext: 'mp4', title: '' }], index: 0 });
  document.body.appendChild(page.el);
  page.mount();
  return { ctx, page, engine, start: () => handlers && (handlers.onPrepared(), handlers.onBufferingDone()), setTime: (ms) => (now = ms) };
}

const noticeTexts = () => Array.from(document.querySelectorAll('.notice-text')).map((n) => n.textContent);

afterEach(() => {
  document.body.innerHTML = '';
});

function pressSubtitles(s) {
  const subtitles = Array.from(s.page.el.querySelectorAll('.player-btn')).find((b) => b.getAttribute('aria-label') === 'Subtitles');
  s.page.onAction(Action.DOWN); // focus on the controls: play / pause
  [Action.RIGHT, Action.RIGHT, Action.RIGHT].forEach((a) => s.page.onAction(a)); // forward 30 s, aspect ratio, subtitles
  expect(subtitles.classList.contains('focused')).toBe(true);
  s.page.onAction(Action.ENTER);
}

test('nothing is downloaded by itself: the list offers "Download from OpenSubtitles", then shows the downloaded subtitles in its place', async () => {
  let release;
  const s = setup({ fetch: () => new Promise((resolve) => (release = resolve)) });
  await wait();
  s.start();
  await wait(300);
  const lists = [];
  const answers = [(options) => options.find((o) => o.label === 'Download from OpenSubtitles').value, (options) => options[1].value];
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => {
    lists.push(options.map((o) => o.label));
    return answers.shift()(options);
  });
  pressSubtitles(s);
  await wait();
  expect(lists[0]).toEqual(['Off', 'Download from OpenSubtitles']);
  expect(s.ctx.openSubtitles.fetch).toHaveBeenCalledWith({ tmdbId: 603, languages: expect.any(Array) }, { url: 'http://h/movie/1.mp4' });
  expect(noticeTexts()).toContain('Downloading subtitles');
  release({ language: 'it', cues: [{ start: 1000, end: 3000, text: 'Ciao' }] });
  await wait(300);
  expect(noticeTexts()).toContain('Subtitles downloaded: Italiano');
  expect(lists[1]).toEqual(['Off', 'OpenSubtitles: Italiano', 'Align the downloaded subtitles']); // the download entry is gone
  s.setTime(1500);
  await wait(300);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('Ciao');
  expect(s.ctx.openSubtitles.fetch).toHaveBeenCalledTimes(1);
  s.page.destroy();
}, 10000);

test('the file has its own subtitles: they are listed with the download entry, nothing is downloaded until it is chosen', async () => {
  const s = setup({ tracks: [{ index: 2, language: 'ita' }], fetch: async () => ({ language: 'en', cues: [] }) });
  await wait();
  s.start();
  await wait(300);
  let labels = null;
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => {
    labels = options.map((o) => o.label);
    return null;
  });
  pressSubtitles(s);
  await wait(100);
  expect(s.ctx.openSubtitles.fetch).not.toHaveBeenCalled();
  expect(labels).toEqual(['Off', 'Italiano', 'Download from OpenSubtitles']);
  s.page.destroy();
}, 10000);

test('the guided alignment: two lines paired with the moment they are heard; the timing found is used and saved', async () => {
  const s = setup({ fetch: async () => ({ language: 'it', matched: false, fileId: 42, cues: [{ start: 1000, end: 3000, text: 'Ciao' }, { start: 400000, end: 402000, text: 'Fine' }] }) });
  const saved = [];
  s.ctx.subtitleAlign = { get: async () => null, save: jest.fn(async (key, points) => saved.push({ key, points: points.slice() })) };
  await wait();
  s.start();
  await wait(100);
  const answers = [() => 'download', (options) => {
    expect(options.map((o) => o.label)).toEqual(['Off', 'OpenSubtitles: Italiano', 'Align the downloaded subtitles']);
    return 'align';
  }];
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => answers.shift()(options));
  pressSubtitles(s);
  await wait(300);
  const ui = s.page.el.querySelector('.align-ui');
  expect(ui).toBeTruthy();
  expect(ui.querySelector('.align-line').textContent).toBe('Ciao'); // the line at the position, on screen
  const key = (action, n = 1) => { for (let i = 0; i < n; i += 1) s.page.onAction(action); };
  // Point 1: OK plays from just before the line; OK when heard (3.25 s, minus the reaction: 3 s).
  key(Action.ENTER);
  s.setTime(3250);
  await wait(250);
  key(Action.ENTER); // paused on the line
  key(Action.ENTER); // OK again: the focus on "Next"
  expect(ui.querySelector('.align-btn.focused').textContent).toBe('Next');
  key(Action.ENTER);
  expect(saved[0].points).toEqual([{ cue: 1000, video: 3000 }]);
  expect(saved[0].key).toContain('|42');
  // Point 2: the next line, heard at 402.25 s.
  key(Action.RIGHT); // the focus is back on the lines: the next one
  expect(ui.querySelector('.align-line').textContent).toBe('Fine');
  key(Action.ENTER);
  s.setTime(402250);
  await wait(250);
  key(Action.ENTER);
  key(Action.ENTER); // "Next"
  key(Action.ENTER);
  expect(saved[1].points.length).toBe(2);
  expect(ui.querySelector('.align-result').textContent).toMatch(/\+2\.0 s.*1\.000/);
  key(Action.UP); // after "Next" the focus is back on the lines: Up goes to the buttons, on "Finish" (the one that goes on)
  expect(ui.querySelector('.align-btn.focused').textContent).toBe('Finish');
  key(Action.ENTER);
  expect(s.page.el.querySelector('.align-ui')).toBe(null);
  // The lines two seconds later now.
  s.setTime(1500);
  await wait(300);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('');
  s.setTime(3500);
  await wait(300);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('Ciao');
  s.page.destroy();
}, 10000);

test('alignment panel: the buttons in a row (Left / Right), the points above them (Up / Down); "Back" while paused plays on', async () => {
  const s = setup({ fetch: async () => ({ language: 'it', fileId: 7, cues: [{ start: 1000, end: 3000, text: 'Ciao' }, { start: 400000, end: 402000, text: 'Fine' }] }) });
  s.ctx.subtitleAlign = { get: async () => ({ points: [{ cue: 1000, video: 3000 }], offset: 2000, scale: 1 }), save: jest.fn(async () => undefined) };
  await wait();
  s.start();
  await wait(100);
  const answers = [() => 'download', () => 'align'];
  s.ctx.dialogs.choose.mockImplementation(async () => answers.shift()());
  pressSubtitles(s);
  await wait(300);
  const ui = s.page.el.querySelector('.align-ui');
  const key = (action, n = 1) => { for (let i = 0; i < n; i += 1) s.page.onAction(action); };
  const focused = () => ui.querySelector('.focused');
  key(Action.UP); // from the lines: the buttons (Next and Finish off: Back)
  expect(focused().textContent).toBe('Back');
  key(Action.RIGHT);
  expect(focused().textContent).toBe('Next');
  key(Action.UP); // the points saved
  expect(focused().className).toContain('align-point');
  key(Action.DOWN); // back to the buttons
  expect(focused().className).toContain('align-btn');
  key(Action.DOWN); // back to the lines
  expect(focused().className).toContain('subs');
  // Paused on a line, "Back": the video plays on, Left / Right by a second again.
  key(Action.RIGHT);
  key(Action.ENTER);
  s.setTime(400500);
  await wait(250);
  key(Action.ENTER); // paused
  key(Action.ENTER); // on Next
  key(Action.LEFT); // Back
  expect(focused().textContent).toBe('Back');
  key(Action.ENTER);
  expect(focused().className).toContain('video');
  expect(ui.querySelector('.align-help').textContent).toMatch(/as soon as you hear/);
  s.page.destroy();
}, 10000);

test('an alignment saved before is used as soon as the same subtitles are downloaded again', async () => {
  const s = setup({ fetch: async () => ({ language: 'it', fileId: 42, cues: [{ start: 1000, end: 3000, text: 'Ciao' }] }) });
  s.ctx.subtitleAlign = { get: jest.fn(async () => ({ points: [{ cue: 1000, video: 3000 }], offset: 2000, scale: 1 })), save: jest.fn() };
  await wait();
  s.start();
  await wait(100);
  const answers = [() => 'download', (options) => options[1].value];
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => answers.shift()(options));
  pressSubtitles(s);
  await wait(300);
  s.setTime(1500);
  await wait(300);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('');
  s.setTime(3500);
  await wait(300);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('Ciao');
  s.page.destroy();
}, 10000);

test('the subtitle line moves above the progress bar while the controls are shown, and back when they fade', async () => {
  jest.useFakeTimers();
  const s = setup({ fetch: async () => null });
  const line = s.page.el.querySelector('.player-subtitle');
  const controls = s.page.el.querySelector('.player-controls');
  Object.defineProperty(controls, 'offsetHeight', { configurable: true, value: 260 });
  jest.advanceTimersByTime(10000); // the controls shown at the start fade out
  expect(line.style.transform).toBe('');
  s.page.onAction(Action.DOWN);
  // 188 px from the bottom (260 - 96 of shade above the bar + 24) instead of the 56 of the stylesheet: moved with a transform.
  expect(line.style.transform).toBe('translateY(-132px)');
  expect(line.style.bottom).toBe('');
  jest.advanceTimersByTime(10000);
  expect(line.style.transform).toBe('');
  s.page.destroy();
  jest.useRealTimers();
});

test('an MKV whose player sends no lines: the app reads its text tracks and draws the chosen one', async () => {
  const fs = require('fs');
  const path = require('path');
  if (typeof global.TextDecoder === 'undefined') global.TextDecoder = require('util').TextDecoder;
  const file = fs.readFileSync(path.join(__dirname, '../fixtures/subs.mkv'));
  const fileFetch = async (u, init) => {
    const [from, to] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).slice(1).map(Number);
    const end = Math.min(to, file.length - 1);
    const slice = file.subarray(from, end + 1);
    return { status: 206, headers: { get: () => `bytes ${from}-${end}/${file.length}` }, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
  };
  const s = setup({ tracks: [{ index: 2, language: '' }, { index: 3, language: '' }], fetch: async () => null, fileFetch, url: 'http://h/movie/1.mkv' });
  await wait();
  s.start();
  await wait(100);
  let labels = null;
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => {
    labels = options.map((o) => o.label);
    return options[1].value;
  });
  pressSubtitles(s);
  await wait(400);
  expect(labels).toEqual(['Off', 'Italiano', 'English · forced', 'Download from OpenSubtitles']); // the player's own (silent) tracks are not listed
  s.setTime(1500);
  await wait(500);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('Prima riga');
  expect(s.engine.setSubtitleTrack).toHaveBeenCalledWith(null);
  s.page.destroy();
}, 10000);

test('another app in front: the video stops; back in the app it starts again', async () => {
  const s = setup({ fetch: async () => null });
  await wait();
  s.start();
  await wait(50);
  expect(s.engine.start).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  await wait(50);
  expect(s.engine.stop).toHaveBeenCalled();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
  await wait(50);
  expect(s.engine.start).toHaveBeenCalledTimes(2);
  s.page.destroy();
  delete document.hidden;
});

test('another app in front while paused: back in the app it is paused again on the first picture', async () => {
  const s = setup({ fetch: async () => null });
  await wait();
  s.start();
  await wait(50);
  s.page.onAction(Action.PLAY_PAUSE); // paused
  expect(s.engine.pause).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  await wait(50);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
  await wait(50);
  expect(s.engine.start).toHaveBeenCalledTimes(2);
  expect(s.engine.pause).toHaveBeenCalledTimes(1); // not before it plays
  s.start();
  await wait(50);
  expect(s.engine.pause).toHaveBeenCalledTimes(2); // paused again
  expect(s.page.el.querySelector('.player-status').textContent).toBe('Paused');
  s.page.destroy();
  delete document.hidden;
});

test('an MP4 with tx3g tracks: the app reads them and draws the chosen one', async () => {
  const fs = require('fs');
  const path = require('path');
  if (typeof global.TextDecoder === 'undefined') global.TextDecoder = require('util').TextDecoder;
  const file = fs.readFileSync(path.join(__dirname, '../fixtures/subs.mp4'));
  const fileFetch = async (u, init) => {
    const [from, to] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).slice(1).map(Number);
    const end = Math.min(to, file.length - 1);
    const slice = file.subarray(from, end + 1);
    return { status: 206, headers: { get: () => `bytes ${from}-${end}/${file.length}` }, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
  };
  const s = setup({ tracks: [{ index: 3, language: '' }], fetch: async () => null, fileFetch });
  await wait();
  s.start();
  await wait(100);
  let labels = null;
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => {
    labels = options.map((o) => o.label);
    return options[2].value;
  });
  pressSubtitles(s);
  await wait(400);
  expect(labels).toEqual(['Off', 'Italiano', 'English', 'Download from OpenSubtitles']);
  s.setTime(3500);
  await wait(500);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('Hello\nworld, again');
  s.page.destroy();
}, 10000);

test('the TMDB id the title page found (its key has none: found by TMDB search or the details) is the one OpenSubtitles is asked for', async () => {
  const s = setup({ entryKey: 'movie:i77', tmdbId: 603, fetch: async () => ({ language: 'it', cues: [{ start: 1000, end: 3000, text: 'Ciao' }] }) });
  await wait();
  s.start();
  await wait(300);
  const answers = [(options) => options.find((o) => o.label === 'Download from OpenSubtitles').value, (options) => options[1].value];
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => answers.shift()(options));
  pressSubtitles(s);
  await wait(300);
  expect(s.ctx.openSubtitles.fetch).toHaveBeenCalledWith({ tmdbId: 603, languages: expect.any(Array) }, { url: 'http://h/movie/1.mp4' });
  s.setTime(1500);
  await wait(300);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('Ciao');
  s.page.destroy();
}, 10000);

test('no TMDB id at all: a notice says nothing was found (it used to end in silence)', async () => {
  const s = setup({ entryKey: 'movie:i77', fetch: async () => null });
  await wait();
  s.start();
  await wait(300);
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => options.find((o) => o.label === 'Download from OpenSubtitles').value);
  pressSubtitles(s);
  await wait(300);
  expect(s.ctx.openSubtitles.fetch).not.toHaveBeenCalled();
  expect(noticeTexts().some((text) => /no subtitles|not found|No subtitles/i.test(text))).toBe(true);
  s.page.destroy();
}, 10000);
