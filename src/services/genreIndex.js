import { dbGetAllKeys, dbDeleteMany, dbGetAll, dbPutMany, dbDelete } from '../core/idb.js';
import { buildEntryGenreRows } from './grouping.js';
import { bumpGenresRev } from './derivedStore.js';
import { listGenres, genreEntryKeys, genreCounts, countTitlesWithGenres } from './catalogQuery.js';
import { removeRatings } from './ratingBuild.js';
import { removePeople, countPeople } from './peopleIndex.js';
/** The genre work on the main thread (no worker): its code is loaded only then. */
const runGenreBackfillForProvider = (args) => import(/* webpackChunkName: "genres-local" */ './genreBackfill.js').then((m) => m.runGenreBackfillForProvider(args));
import { createGate } from '../core/gate.js';
import { log } from '../core/logger.js';

const STORE = 'entry_genre_tmdb';
const WATCH_MS = 4000;
const UI_RELEASE_MS = 800;

/**
 * Genres of the active provider's catalog. Provider genres come with the catalog sync. The rest is found in the
 * background by a worker (TMDB or the provider's detail call) and never depends on which titles are opened.
 * Every spelling is normalised (not translated) so the same genre is one sidebar entry.
 */
export function createGenreIndex({ active, syncLog = null, getTmdbKey = () => '', getLanguage = () => 'en', createWorker = null, isBusy = () => false }) {
  let worker = null;
  let running = false;
  let again = false;
  let watcher = null;
  let sent = false;
  let stopRun = null;
  let controller = null;
  let cancelled = false;
  let releaseTimer = null;
  const holds = { busy: false, ui: false };
  const gate = createGate();

  function setPaused(paused) {
    if (paused === gate.isPaused()) return;
    if (paused) gate.pause();
    else gate.resume();
    if (worker) worker.postMessage({ op: paused ? 'pause' : 'resume' });
  }

  const refreshPause = () => setPaused(holds.busy || holds.ui);

  function watch() {
    clearInterval(watcher);
    holds.busy = isBusy();
    refreshPause();
    watcher = setInterval(() => {
      holds.busy = isBusy();
      refreshPause();
    }, WATCH_MS);
  }

  /**
   * Makes the background download wait while something else needs the network: `reason` "ui" is the user
   * browsing (visible cards, an open page: asked from TMDB at once), released a moment after the last request.
   */
  function hold(reason, on) {
    if (reason !== 'ui') return;
    clearTimeout(releaseTimer);
    if (on) {
      holds.ui = true;
      refreshPause();
    } else {
      releaseTimer = setTimeout(() => {
        holds.ui = false;
        refreshPause();
      }, UI_RELEASE_MS);
    }
  }

  function runInWorker(payload) {
    return new Promise((resolve, reject) => {
      let instance;
      try {
        instance = createWorker();
      } catch (err) {
        reject(err);
        return;
      }
      worker = instance;
      stopRun = () => {
        instance.terminate();
        worker = null;
        resolve(0);
      };
      const timer = setTimeout(() => {
        instance.terminate();
        worker = null;
        reject(new Error('worker did not report ready'));
      }, 4000);
      instance.onmessage = (event) => {
        const message = event.data || {};
        if (message.event === 'ready') {
          clearTimeout(timer);
          sent = true;
          instance.postMessage({ op: 'start', ...payload });
          if (gate.isPaused()) instance.postMessage({ op: 'pause' });
        } else if (message.event === 'info') {
          log[message.level === 'warn' ? 'warn' : 'info'](message.message);
        } else if (message.event === 'done') {
          instance.terminate();
          worker = null;
          resolve(message.done || 0);
        }
      };
      instance.onerror = (event) => {
        clearTimeout(timer);
        instance.terminate();
        worker = null;
        reject(new Error((event && event.message) || 'worker error'));
      };
    });
  }

  /** Stops the search now (the titles found so far stay). */
  let inFlight = Promise.resolve(0); // the work running now (backfill or one phase): restart() waits for it to stop

  function stop() {
    again = false;
    cancelled = true;
    if (controller) controller.abort();
    if (stopRun) stopRun();
  }

  /**
   * Starts (or queues) the background work for the active provider: first the TMDB download of every title
   * (`force` downloads again what is still fresh), then the provider's genres for what is still without.
   */
  // The catalog changed since the genres and ratings were last worked out (true at start: the first run does everything once).
  let dirty = true;
  /** The catalog changed (a sync, new TMDB ids from the title details): the next run works genres and ratings out again. */
  const markDirty = () => {
    dirty = true;
  };

  function backfill({ force = false } = {}) {
    if (running) {
      again = true;
      return Promise.resolve(0);
    }
    inFlight = runPhases(force);
    return inFlight;
  }

  /** Stops what is running (a provider genre search, say) and starts the work again from the first phase, the TMDB download. */
  async function restart() {
    dirty = true; // a new key: everything again
    stop();
    await inFlight.catch(() => 0);
    again = false;
    return backfill();
  }

  /** One phase on its own (the "update metadata" operations). */
  const download = (force = false) => phase('tmdb', force);
  const findGenres = () => phase('genres', false);
  /** The age ratings of the catalog worked out again from the saved TMDB metadata (no request): the "Rating" group of the sidebar. */
  const findRatings = () => phase('ratings', false);
  /** The people the provider names in its details (the person page without TMDB): every title not asked yet. */
  const findPeople = () => phase('people', false);
  /** The TMDB genres written again from the metadata already saved (no request), also when a download is not due. */
  function restore() {
    if (running) return Promise.resolve(0);
    cancelled = false;
    return trackAs('genres', 'restore'); // the Genres row of Settings: with TMDB its genres are these
  }

  function phase(name, force) {
    if (running) return Promise.resolve(0);
    cancelled = false;
    inFlight = track(name, force);
    return inFlight;
  }

  const track = (name, force) => trackAs(name, name, force);
  /** Runs `phaseName`, logged (Settings tables, operations in progress) as `logName`. */
  function trackAs(logName, phaseName, force = false) {
    return syncLog ? syncLog.track(logName, () => run(phaseName, force), { cancel: stop }) : run(phaseName, force);
  }

  async function runPhases(force) {
    cancelled = false;
    running = true;
    let done = 0;
    try {
      const downloaded = getTmdbKey() ? await track('tmdb', force) : 0;
      done += downloaded;
      // Genres and ratings are worked out again only when something can have changed: new metadata, or a catalog that changed since the
      // last run (markDirty) — they used to run, and tell it, after every trigger (each sync, each batch of title details).
      const wasDirty = dirty;
      dirty = false; // a change from now on asks for the next run
      const needed = force || wasDirty || downloaded > 0;
      // With TMDB the genres are its own, written from the metadata (titles still without any): logged as the Genres row.
      if (!cancelled && getTmdbKey() && needed) await trackAs('genres', 'restore');
      // The ratings of the metadata just downloaded (also of titles added by a sync).
      if (!cancelled && getTmdbKey() && needed) await track('ratings', false);
      if (cancelled && wasDirty) dirty = true; // stopped before genres and ratings were worked out: still to do
      // The provider's genre search only without TMDB: with a key TMDB's genres replace the provider's, asking the provider is wasted.
      if (!cancelled && !getTmdbKey()) done += await track('genres', false);
      // Without TMDB the person page reads the cast and directors the provider names: every title asked once, slowly.
      if (!cancelled && !getTmdbKey()) await track('people', false);
    } finally {
      running = false;
    }
    if (again && !cancelled) {
      again = false;
      done += await runPhases(false);
    }
    return done;
  }

  async function run(name, force) {
    const current = await active.get();
    if (!current) return 0;
    const wasRunning = running;
    running = true;
    sent = false;
    let done = 0;
    const p = current.provider;
    const payload = {
      provider: { id: p.id, type: p.type || 'xtream', baseUrl: p.baseUrl, username: p.username, password: p.password },
      // The other active providers (catalogUnion.js): their titles are asked to them.
      others: (current.active || []).slice(1).map((o) => ({ id: o.id, slot: o.slot, type: o.type || 'xtream', baseUrl: o.baseUrl, username: o.username, password: o.password })),
      tmdbKey: getTmdbKey(),
      language: getLanguage(),
      phase: name,
      force,
    };
    watch();
    controller = new AbortController();
    try {
      try {
        done = createWorker ? await runInWorker(payload) : await runGenreBackfillForProvider({ ...payload, gate: gate.wait, signal: controller.signal, emit: (m) => m.event === 'info' && log[m.level === 'warn' ? 'warn' : 'info'](m.message) });
      } catch (err) {
        if (sent) throw err; // the worker was running: do not start it twice
        log.warn('Genre worker unavailable, using the main thread:', err.message);
        done = await runGenreBackfillForProvider({ ...payload, gate: gate.wait, signal: controller.signal, emit: (m) => m.event === 'info' && log[m.level === 'warn' ? 'warn' : 'info'](m.message) });
      }
    } catch (err) {
      log.warn('Background metadata job failed', err && err.message);
    } finally {
      await bumpGenresRev(current.db).catch(() => undefined); // genre lists and counts derived from it are worked out again
      running = wasRunning;
      stopRun = null;
      controller = null;
      clearInterval(watcher);
    }
    return done;
  }

  return {
    backfill,
    markDirty,
    restart,
    download,
    findGenres,
    findRatings,
    findPeople,
    restore,
    hold,
    stop,
    /** Genres for the sidebar: [{ key, name }], only those that still have at least one title. */
    async list(type) {
      const current = await active.get();
      return current ? listGenres(current.db, type) : [];
    },
    async counts(type) {
      const current = await active.get();
      return current ? genreCounts(current.db, type) : new Map();
    },
    async entryKeys(type, genreKey) {
      const current = await active.get();
      return current ? genreEntryKeys(current.db, type, genreKey) : [];
    },
    /** How many movies and series have a genre (Settings › TMDB). */
    async countWithGenres() {
      const current = await active.get();
      return current ? countTitlesWithGenres(current.db).catch(() => 0) : 0;
    },
    /** Forgets the people found in the provider's details (asked again at the next run). */
    async clearPeople() {
      const current = await active.get();
      if (current) await removePeople(current.db);
    },
    /** How many titles were asked for their people. */
    async countPeople() {
      const current = await active.get();
      return current ? countPeople(current.db).catch(() => 0) : 0;
    },
    /** Forgets the age ratings worked out (the "Rating" group goes until they are worked out again). */
    async clearRatings() {
      const current = await active.get();
      if (current) await removeRatings(current.db);
    },
    /** A new TMDB key makes the "nothing found" markers stale: forget them so the next run asks TMDB again. */
    async forgetMisses() {
      const current = await active.get();
      if (!current) return;
      const keys = await dbGetAllKeys(current.db, STORE);
      await dbDeleteMany(current.db, STORE, keys.filter((key) => key.endsWith('|none')));
    },
    /** "Remove all TMDB data" also forgets the genres it provided (provider ones stay). */
    async clearTmdb() {
      const current = await active.get();
      if (!current) return;
      const keys = await dbGetAllKeys(current.db, STORE);
      await dbDeleteMany(current.db, STORE, keys.filter((key) => key.endsWith('|tmdb')));
      await dbDelete(current.db, 'meta', 'genres:source');
      // TMDB's genres had replaced the provider's list for those titles: the list comes back from the entries.
      const entries = await dbGetAll(current.db, 'entries');
      await dbPutMany(current.db, 'entry_genre', buildEntryGenreRows(entries.filter((entry) => entry.genres && entry.genres.length)));
    },
  };
}
