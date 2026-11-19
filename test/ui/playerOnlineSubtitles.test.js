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
  expect(lists[1]).toEqual(['Off', 'OpenSubtitles: Italiano', 'Alignment of the downloaded subtitles']); // the download entry is gone
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

test('the guided alignment: a line confirmed, the video anchored to it, "Add point" twice, "Conclude": the timing used and saved', async () => {
  const s = setup({ fetch: async () => ({ language: 'it', matched: false, fileId: 42, cues: [{ start: 1000, end: 3000, text: 'Ciao' }, { start: 400000, end: 402000, text: 'Fine' }] }) });
  const saved = [];
  s.ctx.subtitleAlign = { get: async () => null, save: jest.fn(async (key, points) => saved.push({ key, points: points.slice() })) };
  await wait();
  s.start();
  await wait(100);
  const lists = [];
  const answers = [() => 'download', (options) => { lists.push(options.map((o) => o.label)); return 'align'; }, (options) => { lists.push(options.map((o) => o.label)); return null; }];
  s.ctx.dialogs.choose.mockImplementation(async ({ options }) => answers.shift()(options));
  pressSubtitles(s);
  await wait(300);
  expect(lists[0]).toEqual(['Off', 'OpenSubtitles: Italiano', 'Alignment of the downloaded subtitles']);
  const ui = s.page.el.querySelector('.align-ui');
  const key = (action, n = 1) => { for (let i = 0; i < n; i += 1) s.page.onAction(action); };
  const text = (sel) => ui.querySelector(sel).textContent;
  const focused = () => ui.querySelector('.focused');
  expect(text('.align-count')).toBe('Points defined 0 of at least 2');
  expect(ui.querySelector('.align-count').classList.contains('done')).toBe(false);
  expect(focused().className).toContain('subs'); // the focus starts on the bar of the subtitles
  expect(Array.from(ui.querySelectorAll('.align-btn')).every((b) => b.classList.contains('disabled'))).toBe(true);
  expect(text('.align-line')).toBe('Ciao');
  // Point 1: OK confirms the line (green), the focus on the video bar, the anchor at 1 s; Right × 4: 3 s.
  key(Action.ENTER);
  expect(ui.querySelector('.align-cursor').classList.contains('confirmed')).toBe(true);
  expect(focused().className).toContain('video');
  key(Action.RIGHT, 4);
  // OK plays video and subtitles together (this alignment), OK again stops on the anchor.
  key(Action.ENTER);
  expect(s.engine.play).toHaveBeenCalled();
  s.setTime(3500);
  await wait(300);
  expect(text('.align-line')).toBe('Ciao'); // at 3.5 s with the line at 3 s
  key(Action.ENTER);
  expect(s.engine.seekTo).toHaveBeenLastCalledWith(3000);
  key(Action.UP, 2); // the subtitles, then the panel: on "Add point"
  expect(focused().textContent).toBe('Add point');
  key(Action.ENTER);
  expect(saved[0].points).toEqual([{ cue: 1000, video: 3000 }]);
  expect(saved[0].key).toContain('|42');
  expect(text('.align-count')).toBe('Points defined 1 of at least 2');
  expect(focused().className).toContain('subs'); // the next point
  // Point 2: the next line, its anchor where the first point puts it (402 s): kept as it is.
  key(Action.RIGHT);
  expect(text('.align-line')).toBe('Fine');
  key(Action.ENTER);
  key(Action.UP, 2);
  key(Action.ENTER);
  expect(saved[1].points).toEqual([{ cue: 1000, video: 3000 }, { cue: 400000, video: 402000 }]);
  expect(text('.align-count')).toBe('Points defined 2');
  expect(ui.querySelector('.align-count').classList.contains('done')).toBe(true);
  expect(ui.querySelectorAll('.align-point').length).toBe(2);
  key(Action.UP); // the buttons: on "Conclude" (nothing to add)
  expect(focused().textContent).toBe('Conclude');
  key(Action.ENTER);
  expect(s.page.el.querySelector('.align-ui')).toBe(null);
  s.setTime(1500);
  await wait(300);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('');
  s.setTime(3500);
  await wait(300);
  expect(s.page.el.querySelector('.player-subtitle').textContent).toBe('Ciao');
  pressSubtitles(s); // the list says it is done
  await wait(300);
  expect(lists[1]).toContain('Alignment of the downloaded subtitles (done)');
  s.page.destroy();
}, 10000);

test('alignment: Edit and Remove on each point; Back from the video to the subtitles, to the panel, then out (the points stay)', async () => {
  const s = setup({ fetch: async () => ({ language: 'it', fileId: 7, cues: [{ start: 1000, end: 3000, text: 'Ciao' }, { start: 400000, end: 402000, text: 'Fine' }] }) });
  const saves = [];
  s.ctx.subtitleAlign = { get: async () => ({ points: [{ cue: 1000, video: 3000 }, { cue: 400000, video: 402000 }], offset: 2000, scale: 1 }), save: jest.fn(async (k, points) => saves.push(points.slice())) };
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
  expect(focused().className).toContain('subs'); // also with the points done
  key(Action.UP); // the buttons: Conclude (on)
  expect(focused().textContent).toBe('Conclude');
  key(Action.UP); // the last point: Edit
  expect(focused().textContent).toBe('Edit');
  key(Action.RIGHT);
  expect(focused().textContent).toBe('Remove');
  key(Action.ENTER); // point 2 removed
  expect(saves[0]).toEqual([{ cue: 1000, video: 3000 }]);
  expect(ui.querySelector('.align-count').textContent).toBe('Points defined 1 of at least 2');
  key(Action.LEFT);
  key(Action.ENTER); // Edit point 1: its line and anchor, on the video bar
  expect(focused().className).toContain('video');
  expect(ui.querySelector('.align-line').textContent).toBe('Ciao');
  s.page.onBack(); // video → subtitles
  expect(focused().className).toContain('subs');
  s.page.onBack(); // subtitles → panel
  expect(ui.querySelector('.align-btn.focused')).toBeTruthy();
  s.page.onBack(); // panel → out
  expect(s.page.el.querySelector('.align-ui')).toBe(null);
  s.page.destroy();
}, 10000);

test('an alignment saved before is used as soon as the same subtitles are downloaded again', async () => {
  const s = setup({ fetch: async () => ({ language: 'it', fileId: 42, cues: [{ start: 1000, end: 3000, text: 'Ciao' }] }) });
  s.ctx.subtitleAlign = { get: jest.fn(async () => ({ points: [{ cue: 1000, video: 3000 }, { cue: 400000, video: 402000 }], offset: 2000, scale: 1 })), save: jest.fn() };
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
