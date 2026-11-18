import { dbGet, dbPut, dbClear, dbGetAllKeys, dbGetAll } from '../core/idb.js';
import { makeSearchKey } from './titleNormalizer.js';
import { posterUrl } from './tmdbClient.js';

export const META_TTL_MS = 120 * 24 * 3600 * 1000;
export const NOT_FOUND_TTL_MS = 7 * 24 * 3600 * 1000;
export const RECOMMENDATIONS_TTL_MS = 24 * 3600 * 1000;

/** Cache key of the metadata of one title in one language: independent of the provider. */
export const metaKey = (type, tmdbId, language) => `meta:${type}:${tmdbId}:${language}`;

const yearOf = (date) => Number.parseInt(String(date || '').slice(0, 4), 10) || null;

/** A title in a script an Italian or English reader cannot read (Greek, Cyrillic, Hebrew, Arabic, Thai, Japanese, Chinese, Korean). */
export const UNREADABLE_TITLE = /[\u0370-\u03FF\u0400-\u04FF\u0590-\u06FF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

/**
 * A video with subtitles burned in, by its name: many TMDB videos marked with a language are the original with subtitles in it
 * ("Trailer Sub ITA", "Sottotitolato", "VOST", "Legendado").
 */
export const SUBTITLED_VIDEO = /\bsub\b|\bsubs\b|\bsub[\s._-]?ita\b|sottotitolat|\bsubbed\b|\bsubtitled\b|\bvost|legendad|\bomu\b|untertitel/i;

/**
 * The best trailer: { key, local } (`local`: in the language of the app and not subtitled; '' / false when there is none).
 * Order: in the language of the app (dubbed), English, any other language, in the language of the app but subtitled; within each, a
 * trailer before a teaser.
 */
export function trailerOf(videos, language = '') {
  const list = ((videos && videos.results) || []).filter((v) => v && v.site === 'YouTube' && v.key && (v.type === 'Trailer' || v.type === 'Teaser'));
  const lang = String(language).slice(0, 2);
  const subtitled = (v) => SUBTITLED_VIDEO.test(String(v.name || ''));
  const group = (v) => {
    if (v.iso_639_1 === lang && !subtitled(v)) return 0;
    if (v.iso_639_1 === lang) return 3;
    return v.iso_639_1 === 'en' ? 1 : 2;
  };
  const rank = (v) => group(v) * 2 + (v.type === 'Trailer' ? 0 : 1);
  const best = list.slice().sort((a, b) => rank(a) - rank(b))[0];
  return best ? { key: best.key, local: group(best) === 0 } : { key: '', local: false };
}

/** YouTube key of the best trailer (see trailerOf). */
export const trailerKeyOf = (videos, language = '') => trailerOf(videos, language).key;

/**
 * What is kept in the database for every title of the catalog: only what the grids and the genre lists need.
 * Backdrop, plot, cast, companies and trailer are fetched when the title page opens (see `getFull`).
 */
export function gridMeta(meta) {
  return {
    tmdbId: meta.tmdbId,
    title: meta.title,
    poster: meta.poster,
    rating: meta.rating,
    genre: meta.genre,
    genreList: meta.genreList,
    year: meta.year,
    seasons: meta.seasons,
    episodes: meta.episodes,
    certification: meta.certification || '', // the age rating (country of the language of the app): kids profiles with a maximum
  };
}

/** Movie directors (crew job "Director"); for series the creators, falling back to directors of the crew. */
function directorsOf(data) {
  const crew = ((data.credits && data.credits.crew) || []).filter((c) => c.job === 'Director' && c.name).map((c) => c.name);
  const creators = (Array.isArray(data.created_by) ? data.created_by : []).map((c) => c.name).filter(Boolean);
  const names = creators.length ? creators : crew;
  return names.filter((n, i) => names.indexOf(n) === i).slice(0, 4);
}

/**
 * The age rating of a title for the country of the language of the app (it-IT → IT; a language alone: its usual country), else the US:
 * a movie's from its release dates (theatrical first), a series' from its content ratings. '' when TMDB has none.
 */
export function certificationOf(type, data, language = '') {
  const parts = String(language).split('-');
  const COUNTRY = { it: 'IT', en: 'US', es: 'ES', fr: 'FR', de: 'DE', pt: 'PT' };
  const country = (parts[1] || COUNTRY[parts[0]] || 'US').toUpperCase();
  const pick = (code) => {
    if (type === 'series') {
      const row = ((data.content_ratings && data.content_ratings.results) || []).find((r) => r.iso_3166_1 === code);
      return row && row.rating ? String(row.rating) : '';
    }
    const row = ((data.release_dates && data.release_dates.results) || []).find((r) => r.iso_3166_1 === code);
    const dates = (row && row.release_dates) || [];
    const byType = dates.slice().sort((a, b) => (a.type === 3 ? 0 : 1) - (b.type === 3 ? 0 : 1));
    const found = byType.find((d) => d.certification);
    return found ? String(found.certification) : '';
  };
  return pick(country) || (country !== 'US' ? pick('US') : '');
}

/** TMDB payload → what the UI needs. */
export function normalizeMeta(type, data, language = '') {
  const date = type === 'series' ? data.first_air_date : data.release_date;
  return {
    tmdbId: data.id,
    title: (type === 'series' ? data.name : data.title) || '',
    originalTitle: (type === 'series' ? data.original_name : data.original_title) || '',
    overview: data.overview || '',
    poster: posterUrl(data.poster_path),
    backdrop: posterUrl(data.backdrop_path, 'w1280'),
    rating: Number(data.vote_average) || null,
    genre: Array.isArray(data.genres) ? data.genres.map((g) => g.name).join(', ') : '',
    genreList: Array.isArray(data.genres) ? data.genres.map((g) => ({ id: g.id, name: g.name })) : [],
    runtime: type === 'movie' ? Number(data.runtime) || null : (Array.isArray(data.episode_run_time) && data.episode_run_time[0]) || null,
    year: yearOf(date),
    seasons: Number(data.number_of_seasons) || null,
    episodes: Number(data.number_of_episodes) || null,
    certification: certificationOf(type, data, language),
    trailerKey: trailerOf(data.videos, language).key,
    trailerLocal: trailerOf(data.videos, language).local, // in the language of the app, not subtitled: it wins over the provider's
    companies: (Array.isArray(data.production_companies) ? data.production_companies : [])
      .map((c) => ({ id: c.id, name: c.name || '', logo: posterUrl(c.logo_path, 'w185') }))
      .filter((c) => c.name),
    directors: directorsOf(data),
    castList: ((data.credits && data.credits.cast) || [])
      .slice(0, 20)
      .map((c) => ({ name: c.name || '', character: c.character || '', photo: posterUrl(c.profile_path, 'w185') }))
      .filter((c) => c.name),
  };
}

/**
 * Conservative title match for entries the provider gave no tmdb id: accept only when exactly one
 * result has the same normalized title (and the same year when the year is known).
 */
export function pickMatch(type, results, name, year) {
  const wanted = makeSearchKey(name);
  const hits = (results || []).filter((r) => {
    const titles = [type === 'series' ? r.name : r.title, type === 'series' ? r.original_name : r.original_title].map(makeSearchKey);
    if (!titles.includes(wanted)) return false;
    if (!year) return true;
    return yearOf(type === 'series' ? r.first_air_date : r.release_date) === year;
  });
  return hits.length === 1 ? hits[0].id : null;
}

/** Runs async jobs with a concurrency cap; `clear()` drops jobs that have not started yet. */
export function createQueue(concurrency = 3, onChange = null) {
  let running = 0;
  let waiting = [];
  const changed = () => onChange && onChange(running + waiting.length);
  function pump() {
    while (running < concurrency && waiting.length) {
      const job = waiting.shift();
      running += 1;
      job().finally(() => {
        running -= 1;
        pump();
        changed();
      });
    }
  }
  return {
    add(fn) {
      return new Promise((resolve) => {
        waiting.push(() => Promise.resolve().then(fn).then(resolve, () => resolve(null)));
        pump();
        changed();
      });
    },
    clear() {
      waiting = [];
      changed();
    },
    size: () => running + waiting.length,
  };
}

/**
 * TMDB metadata, cached by tmdb id and language (not by provider) for 120 days. A background job fills the
 * cache for the whole catalog; what the user is looking at (visible cards, an open page) is requested at
 * once by this service, and `onActivity(count)` tells the background job to wait while that goes on.
 */
export function createTmdbService({ db, client, getLanguage, now = Date.now, onActivity = null }) {
  let inFlight = 0;
  const report = () => onActivity && onActivity(inFlight + queue.size());
  const queue = createQueue(3, report);
  const memory = new Map();
  const fullMemory = new Map(); // detail-page metadata: kept for the session only, not in the database

  /** Runs a request the user is waiting for; while any is pending the background job holds back. */
  async function priority(fn) {
    inFlight += 1;
    report();
    try {
      return await fn();
    } finally {
      inFlight -= 1;
      report();
    }
  }

  async function cached(store, key, ttlFor, fetcher) {
    const hit = await dbGet(db, store, key);
    if (hit && (hit.expiresAt || 0) > now()) return hit;
    try {
      const value = await fetcher();
      const stamp = now();
      const record = { key, value, fetchedAt: stamp, expiresAt: stamp + ttlFor(value) };
      await dbPut(db, store, record);
      return record;
    } catch (err) {
      if (hit) return hit; // offline: an expired answer is better than none
      throw err;
    }
  }

  const ttl = (value) => (value ? META_TTL_MS : NOT_FOUND_TTL_MS);

  async function getMeta(type, tmdbId) {
    if (!client.enabled || !tmdbId) return null;
    const language = getLanguage();
    const key = metaKey(type, tmdbId, language);
    if (memory.has(key)) return memory.get(key);
    const record = await cached('tmdb', key, ttl, async () => {
      try {
        return gridMeta(normalizeMeta(type, await client.details(type, tmdbId, language, { full: false }), language));
      } catch (err) {
        if (err && err.details && err.details.status === 404) return null; // cached as "not found" for a week
        throw err;
      }
    });
    memory.set(key, record.value);
    return record.value;
  }

  /** Everything TMDB knows about a title (plot, cast, companies, backdrop, trailer), fetched when its page opens. */
  async function getFull(type, tmdbId) {
    if (!client.enabled || !tmdbId) return null;
    const language = getLanguage();
    const key = metaKey(type, tmdbId, language);
    if (fullMemory.has(key)) return fullMemory.get(key);
    try {
      const value = normalizeMeta(type, await client.details(type, tmdbId, language), language);
      fullMemory.set(key, value);
      return value;
    } catch (err) {
      if (err && err.details && err.details.status === 404) return null;
      return getMeta(type, tmdbId).catch(() => null); // offline: the light record of the grids is better than nothing
    }
  }

  async function matchTmdbId(type, name, year) {
    if (!client.enabled || type === 'live') return null;
    const key = `${type}:${makeSearchKey(name)}:${year || 0}`;
    const record = await cached('tmdb_match', key, ttl, async () => {
      const data = await client.search(type, name, year, getLanguage());
      return pickMatch(type, data && data.results, name, year);
    });
    return record.value || null;
  }

  /**
   * TMDB ids recommended for a title, or this week's trending titles when `id` is null: every page TMDB has (20 titles each; recommendations
   * rarely go past 2 pages), up to MAX_PAGES for the trending list. The rows show them lazily, so there is no reason to stop at 20.
   */
  const MAX_PAGES = 5;
  async function recommendations(type, id) {
    if (!client.enabled) return [];
    const language = getLanguage();
    const key = `rec:${type}:${id || 'trending'}:${language}`;
    const record = await cached('tmdb', key, () => RECOMMENDATIONS_TTL_MS, async () => {
      const page = (n) => (id ? client.recommendations(type, id, language, n) : client.trending(type, language, n));
      const first = await page(1);
      const results = ((first && first.results) || []).slice();
      const pages = Math.min(MAX_PAGES, Number(first && first.total_pages) || 1);
      for (let n = 2; n <= pages; n += 1) {
        const more = await page(n).catch(() => null);
        if (!more || !more.results || !more.results.length) break;
        results.push(...more.results);
      }
      const seen = new Set();
      return results.filter((r) => !seen.has(r.id) && seen.add(r.id)).map((r) => ({ id: r.id, popularity: Number(r.popularity) || 0 }));
    });
    return record.value || [];
  }

  return {
    get enabled() {
      return client.enabled;
    },
    getMeta,
    getFull,
    /** How many titles have their metadata downloaded (all languages). */
    async countMeta() {
      return (await dbGetAllKeys(db, 'tmdb', { range: IDBKeyRange.bound('meta:', 'meta:\uffff') })).length;
    },
    /**
     * The metadata saved before the titles were localized (patch 161) with a title in another script: marked expired, so the background
     * download fetches them again (kept until then, offline too). Resolves with how many.
     */
    async expireUnreadableTitles() {
      const records = (await dbGetAll(db, 'tmdb')).filter((r) => r && String(r.key).indexOf('meta:') === 0 && r.value && UNREADABLE_TITLE.test(r.value.title || ''));
      for (const record of records) {
        await dbPut(db, 'tmdb', { ...record, expiresAt: 0 });
        memory.delete(record.key);
      }
      return records.length;
    },
    /**
     * The metadata saved before it carried the age rating (patch 187): marked expired, so the background download fetches it again (kept
     * until then). Needed once a kids profile has a maximum rating. Resolves with how many.
     */
    async expireWithoutCertification() {
      const records = (await dbGetAll(db, 'tmdb')).filter((r) => r && String(r.key).indexOf('meta:') === 0 && r.value && r.value.certification === undefined && (r.expiresAt || 0) > now());
      for (const record of records) {
        await dbPut(db, 'tmdb', { ...record, expiresAt: 0 });
        memory.delete(record.key);
      }
      return records.length;
    },
    /** The age rating of every title with metadata in the language of the app: Map(`type:tmdbId` → rating). */
    async certifications() {
      const suffix = `:${getLanguage()}`;
      const out = new Map();
      (await dbGetAll(db, 'tmdb')).forEach((r) => {
        const key = String(r && r.key);
        if (key.indexOf('meta:') !== 0 || !key.endsWith(suffix) || !r.value || !r.value.certification) return;
        out.set(key.slice(5, key.length - suffix.length), r.value.certification); // meta:<type>:<tmdbId>:<language>
      });
      return out;
    },
    /** Forgets every cached answer (metadata, matches, genres, recommendations). */
    async clearAll() {
      memory.clear();
      fullMemory.clear();
      await dbClear(db, 'tmdb');
      await dbClear(db, 'tmdb_match');
    },
    recommendations,
    matchTmdbId,
    /** Metadata for a detail page: provider tmdb id first, otherwise a conservative title match. */
    forEntry(entry) {
      if (!client.enabled || entry.type === 'live') return Promise.resolve(null);
      return priority(async () => {
        const id = entry.tmdbId || (await matchTmdbId(entry.type, entry.name, entry.year));
        return id ? getFull(entry.type, id) : null;
      });
    },
    /** Fills visible cards with TMDB title / poster / series counts as the answers arrive. */
    enrich(entries, cards, type, onMeta, keepQueue = false) {
      if (!keepQueue) queue.clear();
      if (!client.enabled || type === 'live') return;
      entries.forEach((entry, i) => {
        if (!entry.tmdbId) return;
        queue.add(async () => {
          const meta = await getMeta(type, entry.tmdbId);
          if (!meta || !cards[i]) return;
          cards[i].update({
            title: meta.title || undefined,
            poster: meta.poster,
            year: meta.year || entry.year || undefined,
            seasons: type === 'series' ? meta.seasons : undefined,
            episodes: type === 'series' ? meta.episodes : undefined,
            rating: meta.rating || undefined,
          });
          if (onMeta) onMeta(entry, i, meta);
        });
      });
    },
    queue,
  };
}
