/**
 * The progress bar of a live channel whose provider keeps its past (catch-up): the bar is the programme on, from its start to its end; the
 * part after now (the live edge) is not reached yet. What plays is either the live stream (behind live by the time it was paused) or a
 * timeshift stream that starts at `tsBase` (a wall-clock instant). Pure functions: the player keeps the state.
 */

/** Within this of now a position counts as live: seeking there plays the live stream again. */
export const LIVE_SNAP_MS = 20 * 1000;

/** The days the provider keeps reach the start of `programme` (it began, and not further back than the archive). */
export function canTimeshift(programme, archiveDays, now = Date.now()) {
  return Boolean(programme && archiveDays > 0 && programme.start < now && programme.stop > programme.start && now - programme.start < archiveDays * 24 * 3600 * 1000);
}

/**
 * The instant on screen: the timeshift stream's start plus its position, or (live stream) now minus the time spent paused (frozen while
 * paused).
 */
export function wallPosition({ tsBase = null, position = 0, liveDelay = 0, pausedSince = null, now = Date.now() }) {
  if (tsBase !== null) return tsBase + (Number(position) || 0) * 1000;
  return (pausedSince !== null ? pausedSince : now) - liveDelay;
}

/**
 * The bar in seconds of the programme: { position, duration, edge } (edge: where live is, the bar is not navigable after it) and
 * `behind` (ms behind live).
 */
export function timelineBar(programme, state) {
  const now = state.now === undefined ? Date.now() : state.now;
  const duration = Math.max(0, (programme.stop - programme.start) / 1000);
  const wall = wallPosition({ ...state, now });
  const clamp = (s) => Math.min(Math.max(0, s), duration);
  return { position: clamp((wall - programme.start) / 1000), duration, edge: clamp((now - programme.start) / 1000), behind: Math.max(0, now - wall) };
}

/**
 * How to show `target` (a wall-clock instant): `{ action: 'live' }` near live (the live stream), `{ action: 'seek', seconds }` inside the
 * timeshift stream already loaded (`loaded`: its length in seconds), otherwise `{ action: 'load', from, startAt }`: a timeshift stream from
 * the minute (the address has no seconds), started `startAt` seconds in. The target is kept between the programme's start and now.
 */
export function seekPlan({ target, programme, now = Date.now(), tsBase = null, loaded = 0 }) {
  const to = Math.max(programme.start, Math.min(target, now));
  if (now - to < LIVE_SNAP_MS) return { action: 'live' };
  if (tsBase !== null && to >= tsBase && to <= tsBase + Math.max(0, loaded - 2) * 1000) return { action: 'seek', seconds: (to - tsBase) / 1000 };
  const from = Math.floor(to / 60000) * 60000;
  return { action: 'load', from, startAt: Math.round((to - from) / 1000) };
}
