import { kvGet, kvSet, kvDelete } from '../db/kv.js';

/**
 * Aligning downloaded subtitles to the video they are shown on (the guided procedure of the player, ui/pages/player/subtitleAlign.js).
 * A point pairs the start of a line of the subtitles (`cue`, ms in the file) with the moment of the video it is heard (`video`, ms).
 * From the points: `video = cue × scale + offset`. One point gives the delay only; two or more the delay and the speed too (a file made
 * for a 25 fps release shown on a 23.976 one drifts by about 4 %). Kept per file of subtitles and video (`alignKey`).
 */

/** What the press of OK comes late by, on average, after the line is heard: taken off the moment of the video. */
export const REACTION_MS = 250;
/** Speeds that happen (frame-rate conversions are within ±5 %): outside, a point is probably paired with the wrong line. */
const MIN_SCALE = 0.95;
const MAX_SCALE = 1.05;
/** A point further than this from the line through the others (3 or more points) probably is wrong. */
const MAX_RESIDUAL_MS = 1500;

export const NO_TIMING = { offset: 0, scale: 1 };

/** The moment of the video of a time of the subtitles, and back. */
export const toVideo = (cueMs, timing = NO_TIMING) => cueMs * timing.scale + timing.offset;
export const toCue = (videoMs, timing = NO_TIMING) => (videoMs - timing.offset) / timing.scale;

/** video = cue × scale + offset through the points (least squares). */
function leastSquares(list) {
  const n = list.length;
  const mc = list.reduce((s, p) => s + p.cue, 0) / n;
  const mv = list.reduce((s, p) => s + p.video, 0) / n;
  const sxx = list.reduce((s, p) => s + (p.cue - mc) * (p.cue - mc), 0);
  const sxy = list.reduce((s, p) => s + (p.cue - mc) * (p.video - mv), 0);
  const scale = sxx > 0 ? sxy / sxx : 1;
  return { offset: mv - scale * mc, scale };
}

/**
 * The timing of a set of points: { offset, scale, ok, problem, worst }. `problem`: '' | 'speed' (outside what happens) | 'point' (one
 * point far from the line through the others: `worst` its index; for a bad speed the last). No points: no change.
 */
export function fitAlignment(points) {
  const list = (points || []).filter((p) => Number.isFinite(p.cue) && Number.isFinite(p.video));
  if (!list.length) return { ...NO_TIMING, ok: true, problem: '', worst: -1 };
  if (list.length === 1) return { offset: list[0].video - list[0].cue, scale: 1, ok: true, problem: '', worst: -1 };
  const { offset, scale } = leastSquares(list);
  // The point that does not agree: each one against the line through the others (a wrong point would pull the line of all of them
  // towards itself, and a right one would look wrong).
  let worst = -1;
  let worstError = 0;
  if (list.length >= 3) {
    list.forEach((p, i) => {
      const others = leastSquares(list.filter((q, j) => j !== i));
      const error = Math.abs(p.video - (p.cue * others.scale + others.offset));
      if (error > worstError) {
        worstError = error;
        worst = i;
      }
    });
  }
  if (scale < MIN_SCALE || scale > MAX_SCALE) return { offset, scale, ok: false, problem: 'speed', worst: list.length - 1 };
  if (list.length >= 3 && worstError > MAX_RESIDUAL_MS) return { offset, scale, ok: false, problem: 'point', worst };
  return { offset, scale, ok: true, problem: '', worst: -1 };
}

/** The key of an alignment: the provider, the title, the video (stream) and the file of subtitles it was made for. */
export const alignKey = ({ providerId = '', entryKey = '', streamId = '', fileId = '' }) => `subAlign:${providerId}|${entryKey}|${streamId}|${fileId}`;

/** The points saved for a video and file of subtitles (the profile's database): { points, offset, scale } or null. */
export function createAlignStore(db) {
  return {
    get: (key) => kvGet(db, key, null),
    save: (key, points) => {
      const fit = fitAlignment(points);
      return kvSet(db, key, { points, offset: fit.offset, scale: fit.scale, savedAt: Date.now() });
    },
    remove: (key) => kvDelete(db, key),
  };
}
