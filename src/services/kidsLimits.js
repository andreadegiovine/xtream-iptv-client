import { kvGet, kvSet } from '../db/kv.js';

/**
 * Limits of a kids profile (set by an admin in the profile form): no watching before / after a time of day, a daily maximum of minutes,
 * a minimum and a maximum age rating (titles rated outside that range are hidden everywhere). Every one optional.
 * `limits`: { before: 'HH:MM' | '', after: 'HH:MM' | '', minutes: number (0: none), minAge: number | null, maxAge: number | null }.
 */

/** The ratings to choose from, as ages (null: no limit). */
export const AGES = [null, 0, 6, 10, 12, 14, 16, 18];

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** '7:5' and the like are refused; '07:30' / '7:30' → '07:30'; '' stays ''. Null when not a time. */
export function normalizeTime(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const m = TIME.exec(value);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}
const minutesOfDay = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/** The limits as kept in a profile: only for a kids profile, invalid values dropped. */
export function cleanLimits(raw) {
  const src = raw || {};
  const minutes = Math.max(0, Math.floor(Number(src.minutes) || 0));
  const age = (value) => {
    const n = value === null || value === undefined || value === '' ? null : Number(value);
    return AGES.indexOf(n) >= 0 ? n : null;
  };
  return { before: normalizeTime(src.before) || '', after: normalizeTime(src.after) || '', minutes, minAge: age(src.minAge), maxAge: age(src.maxAge) };
}

/** Is it outside the hours allowed? `before`: no watching before that time; `after`: none from that time on. */
export function outsideHours(limits, date) {
  if (!limits) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  if (limits.before && now < minutesOfDay(limits.before)) return true;
  if (limits.after && now >= minutesOfDay(limits.after)) return true;
  return false;
}

/**
 * The minimum age of an age rating, whatever the country (TMDB's of the language of the app, or the guide's): letters of the usual
 * systems, otherwise the first number in it ("VM14", "M/12", "16", "6+"). Null when unknown (such titles are not hidden).
 */
const LETTERS = {
  G: 0, U: 0, T: 0, A: 0, APTA: 0, AL: 0, TP: 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, 'TV-Y7-FV': 7, PG: 8, 'TV-PG': 10, BA: 6,
  'PG-13': 13, 'TV-14': 14, R: 17, 'TV-MA': 17, 'NC-17': 18, X: 18, XXX: 18,
};
export function ratingAge(rating) {
  const text = String(rating || '').trim().toUpperCase();
  if (!text) return null;
  if (Object.prototype.hasOwnProperty.call(LETTERS, text)) return LETTERS[text];
  const m = /(\d{1,2})/.exec(text);
  return m ? Number(m[1]) : null;
}

/** A rating range is set (a kids profile with a minimum or a maximum rating)? */
export const hasRange = (limits) => Boolean(limits) && ((limits.minAge !== null && limits.minAge !== undefined) || (limits.maxAge !== null && limits.maxAge !== undefined));

/** Rated outside the range the profile may see (below the minimum or above the maximum)? Unknown ratings never are. */
export function outOfRange(rating, limits) {
  if (!hasRange(limits)) return false;
  const age = ratingAge(rating);
  if (age === null) return false;
  if (limits.minAge !== null && limits.minAge !== undefined && age < limits.minAge) return true;
  return limits.maxAge !== null && limits.maxAge !== undefined && age > limits.maxAge;
}

/** The rating range of the profile in use: its limits when it is a kids profile with a range, otherwise null. */
export const rangeOf = (profile) => (profile && profile.kids && hasRange(profile.limits) ? profile.limits : null);

const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const USAGE_KEY = 'kidsUsage';

/**
 * The limits of the profile in use (`getLimits()`: null for a profile without any) and the minutes watched today, kept in the profile's
 * database. `blocked()` → '' or the reason ('hours' | 'minutes').
 */
export function createKidsLimits({ db, getLimits, now = () => new Date() }) {
  let usage = null; // { day, ms }
  async function load() {
    const today = dayOf(now());
    if (!usage) usage = (await kvGet(db, USAGE_KEY, null)) || { day: today, ms: 0 };
    if (usage.day !== today) usage = { day: today, ms: 0 };
    return usage;
  }
  return {
    active: () => Boolean(getLimits()),
    async blocked() {
      const limits = getLimits();
      if (!limits) return '';
      if (outsideHours(limits, now())) return 'hours';
      if (limits.minutes > 0 && (await load()).ms >= limits.minutes * 60000) return 'minutes';
      return '';
    },
    /** Adds watching time (ms) to today's count. */
    async add(ms) {
      if (!getLimits() || !(ms > 0)) return;
      const current = await load();
      current.ms += ms;
      await kvSet(db, USAGE_KEY, current);
    },
    /** Minutes left today (Infinity without a daily limit). */
    async minutesLeft() {
      const limits = getLimits();
      if (!limits || !(limits.minutes > 0)) return Infinity;
      return Math.max(0, limits.minutes - (await load()).ms / 60000);
    },
  };
}
