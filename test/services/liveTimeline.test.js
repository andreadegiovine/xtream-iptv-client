import { canTimeshift, wallPosition, timelineBar, seekPlan, LIVE_SNAP_MS } from '../../src/services/liveTimeline.js';

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 21, 30, 20);
const programme = { start: Date.UTC(2026, 10, 25, 21, 0), stop: Date.UTC(2026, 10, 25, 22, 0) };

describe('live timeline (catch-up)', () => {
  test('a programme is reachable while it is within the archive', () => {
    expect(canTimeshift(programme, 3, NOW)).toBe(true);
    expect(canTimeshift(programme, 0, NOW)).toBe(false);
    expect(canTimeshift({ start: NOW + MIN, stop: NOW + 2 * MIN }, 3, NOW)).toBe(false);
    expect(canTimeshift({ start: NOW - 4 * 24 * 60 * MIN, stop: NOW }, 3, NOW)).toBe(false);
    expect(canTimeshift(null, 3, NOW)).toBe(false);
  });

  test('the instant on screen: timeshift start plus position, or now minus the pause', () => {
    expect(wallPosition({ tsBase: programme.start, position: 90, now: NOW })).toBe(programme.start + 90000);
    expect(wallPosition({ liveDelay: 5000, now: NOW })).toBe(NOW - 5000);
    expect(wallPosition({ liveDelay: 5000, pausedSince: NOW - 60000, now: NOW })).toBe(NOW - 65000);
  });

  test('the bar: programme seconds, live edge, how far behind', () => {
    const live = timelineBar(programme, { now: NOW });
    expect(live).toEqual({ position: 1820, duration: 3600, edge: 1820, behind: 0 });
    const back = timelineBar(programme, { tsBase: programme.start, position: 600, now: NOW });
    expect(back.position).toBe(600);
    expect(back.behind).toBe(1220000);
  });

  test('seeking: near live plays live, inside the stream seeks, elsewhere loads from the minute', () => {
    expect(seekPlan({ target: NOW + 10 * MIN, programme, now: NOW })).toEqual({ action: 'live' });
    expect(seekPlan({ target: NOW - LIVE_SNAP_MS / 2, programme, now: NOW })).toEqual({ action: 'live' });
    expect(seekPlan({ target: programme.start + 300000, programme, now: NOW, tsBase: programme.start, loaded: 1800 })).toEqual({ action: 'seek', seconds: 300 });
    expect(seekPlan({ target: programme.start + 10 * MIN + 25000, programme, now: NOW })).toEqual({ action: 'load', from: programme.start + 10 * MIN, startAt: 25 });
    expect(seekPlan({ target: programme.start - 10 * MIN, programme, now: NOW })).toEqual({ action: 'load', from: programme.start, startAt: 0 });
  });
});
