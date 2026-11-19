import 'fake-indexeddb/auto';
import { openAppDb } from '../../src/db/appDb.js';
import { fitAlignment, toVideo, toCue, alignKey, createAlignStore, NO_TIMING } from '../../src/services/subtitleAlign.js';
import { zoomWindow, lineAt, suggestLine } from '../../src/ui/pages/player/subtitleAlign.js';

test('one point: the delay; two or more: delay and speed (a 25 fps file on a 23.976 video)', () => {
  expect(fitAlignment([])).toMatchObject({ offset: 0, scale: 1, ok: true });
  expect(fitAlignment([{ cue: 10000, video: 12500 }])).toMatchObject({ offset: 2500, scale: 1, ok: true });
  const speed = 25 / 23.976;
  const points = [{ cue: 60000, video: 60000 * speed + 1000 }, { cue: 3600000, video: 3600000 * speed + 1000 }];
  const fit = fitAlignment(points);
  expect(fit.ok).toBe(true);
  expect(fit.scale).toBeCloseTo(speed, 5);
  expect(fit.offset).toBeCloseTo(1000, 3);
  expect(toCue(toVideo(1234567, fit), fit)).toBeCloseTo(1234567, 3);
});

test('points that cannot be right: an impossible speed, a point far from the others', () => {
  expect(fitAlignment([{ cue: 60000, video: 60000 }, { cue: 120000, video: 180000 }])).toMatchObject({ ok: false, problem: 'speed' });
  const bad = fitAlignment([{ cue: 60000, video: 62000 }, { cue: 1800000, video: 1802000 }, { cue: 3600000, video: 3620000 }, { cue: 900000, video: 902000 }]);
  expect(bad).toMatchObject({ ok: false, problem: 'point', worst: 2 });
});

test('saved per video and file of subtitles, with the timing worked out', async () => {
  const store = createAlignStore(await openAppDb(`align-${Math.random()}`));
  const key = alignKey({ providerId: 'p', entryKey: 'movie:t1', streamId: '7', fileId: '42' });
  expect(key).toBe('subAlign:p|movie:t1|7|42');
  expect(await store.get(key)).toBe(null);
  await store.save(key, [{ cue: 1000, video: 3000 }]);
  expect(await store.get(key)).toMatchObject({ points: [{ cue: 1000, video: 3000 }], offset: 2000, scale: 1 });
  await store.remove(key);
  expect(await store.get(key)).toBe(null);
});

test('the zoomed bars: two minutes around the cursor, inside the video; the line to start from and the next suggested', () => {
  expect(zoomWindow(30000, 600000)).toEqual({ start: 0, end: 120000 });
  expect(zoomWindow(300000, 600000)).toEqual({ start: 240000, end: 360000 });
  expect(zoomWindow(590000, 600000)).toEqual({ start: 480000, end: 600000 });
  const cues = [{ start: 1000, end: 2000 }, { start: 300000, end: 301000 }, { start: 700000, end: 701000 }, { start: 900000, end: 901000 }];
  expect(lineAt(cues, 250000, NO_TIMING)).toBe(1);
  expect(lineAt(cues, 302000, { offset: 2000, scale: 1 })).toBe(1); // in the timing of now
  expect(suggestLine(cues, 1000)).toBe(2); // about ten minutes later
  expect(suggestLine(cues, 900000)).toBe(1); // near the end: ten minutes before
});

test('the anchor moves faster while the key is held', async () => {
  const { dragStep } = await import('../../src/ui/pages/player/subtitleAlign.js');
  expect([0, 3, 4, 9, 10, 19, 20, 50].map(dragStep)).toEqual([500, 500, 1000, 1000, 3000, 3000, 10000, 10000]);
});
