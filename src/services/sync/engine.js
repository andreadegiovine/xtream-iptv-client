import { kvGet, kvSet, kvDelete } from '../../db/kv.js';
import { syncedWriteCount } from '../../core/idb.js';
import { log } from '../../core/logger.js';
import { collectLocal, applyChanges, clearLocal, canonical, hashText, sectionOf } from './items.js';
import { deriveAccount, itemId, seal, open, sealCheck, checkOpens, normalizeUsername } from './account.js';
import { MAX_EVENT } from './transport.js';

/**
 * The device sync: this TV's data and the account's, kept the same on every TV that uses the account.
 *
 * State of this TV (app database, kv STATE_KEY, never synced): { username, password, keys, device, rev, etag, items: { <id>: { k (kind),
 * h (hash of the value, null when removed), t (time of that version), x (removed), p (sent at, until the server shows it) } } }: what
 * this TV and the server last agreed on, item by item.
 *
 * A round (`run`):
 * - the server's file is read when it changed (ETag); its items newer than the agreed version are opened;
 * - an item changed only on the server is written here (`apply`: at the start, before the app reads its data; later rounds leave them
 *   for the next start); changed only here, or on both (this TV wins: its change is the newer one), it is sent;
 * - everything here not yet agreed is sent, removals included; sent items not on the server after PENDING_MS are sent again.
 * Sending is one event, or a few when large: the server's workflow merges them (the newer of each item).
 */
export const STATE_KEY = 'deviceSync';
const PENDING_MS = 3 * 60 * 1000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const newDevice = () => `tv-${Math.random().toString(36).slice(2, 10)}`;

/**
 * The decisions of a round (pure): `local` Map(kind → { h, value }), `items` the agreed state, `remote` Map(id → { kind, value, x, t })
 * of the server's changed items (opened), `remoteTimes` Map(id → t) of every server item (null when the file was not read).
 * Returns { apply: [{ id, kind, value, t, x }], send: [{ id, kind, value, x }] }.
 */
export function planRound({ local, items, remote, remoteTimes, idOf, now, applyRemote, replaceLocal = false }) {
  const apply = [];
  const send = [];
  let skipped = 0;
  const handled = new Set();
  remote.forEach((r, id) => {
    const agreed = items[id];
    const kind = r.kind || (agreed && agreed.k);
    if (!kind) return;
    handled.add(kind);
    const here = local.get(kind);
    const changedHere = agreed ? (here ? here.h !== agreed.h : !agreed.x) : Boolean(here);
    if (changedHere && !replaceLocal) {
      send.push(here ? { id, kind, value: here.value, x: false } : { id, kind, value: null, x: true });
    } else if (applyRemote || replaceLocal) {
      apply.push({ id, kind, value: r.x ? null : r.value, t: r.t, x: r.x });
    } else skipped += 1;
  });
  local.forEach((here, kind) => {
    if (handled.has(kind)) return;
    const id = idOf(kind);
    const agreed = items[id];
    if (replaceLocal) return;
    if (!agreed || agreed.x || agreed.h !== here.h) send.push({ id, kind, value: here.value, x: false });
    else if (agreed.p && remoteTimes && (remoteTimes.get(id) || 0) < agreed.t && now - agreed.p > PENDING_MS) send.push({ id, kind, value: here.value, x: false });
  });
  if (!replaceLocal) {
    Object.keys(items).forEach((id) => {
      const agreed = items[id];
      if (!agreed.k || agreed.x || handled.has(agreed.k) || local.has(agreed.k)) return;
      send.push({ id, kind: agreed.k, value: null, x: true });
    });
  }
  return { apply, send, skipped };
}

/** Splits sealed items into events under MAX_EVENT characters. */
export function batches(items, overhead = 400) {
  const out = [];
  let current = [];
  let size = overhead;
  items.forEach((item) => {
    const length = JSON.stringify(item).length + 1;
    if (length + overhead > MAX_EVENT) return; // one item larger than an event: left out (logged by the caller)
    if (current.length && size + length > MAX_EVENT) {
      out.push(current);
      current = [];
      size = overhead;
    }
    current.push(item);
    size += length;
  });
  if (current.length) out.push(current);
  return out;
}

export function createSyncEngine({ db, openProfileDb, transport, now = Date.now }) {
  let state = null;
  let running = Promise.resolve();
  const ids = new Map(); // kind → id (HMAC), computed once

  // syncedWriteCount() after the last round that read this TV's data (its own writes included): unchanged, nothing new to send. Once
  // an hour the data is read anyway (a write made while a round ran).
  let seenWrites = -1;
  let lastFull = 0;
  const FULL_EVERY_MS = 60 * 60 * 1000;
  const load = async () => {
    if (!state) {
      state = await kvGet(db, STATE_KEY, null);
      // The ids already agreed with the server need no HMAC again (thousands of watch states).
      if (state) Object.keys(state.items || {}).forEach((id) => state.items[id].k && ids.set(state.items[id].k, id));
    }
    return state;
  };
  const save = () => kvSet(db, STATE_KEY, state);
  const idOfAsync = async (kind) => {
    if (!ids.has(kind)) ids.set(kind, await itemId(state.keys, kind));
    return ids.get(kind);
  };

  /** This TV's items with their hashes; their ids computed ahead (planRound is synchronous). */
  async function localItems() {
    const raw = await collectLocal({ db, openProfileDb, device: state.device });
    const out = new Map();
    for (const [kind, value] of raw) {
      out.set(kind, { value, h: hashText(canonical(value)) });
      await idOfAsync(kind);
    }
    return out;
  }

  /** The server's items newer than what was agreed, opened: Map(id → { kind, value, x, t }); and every item's time. */
  async function openChanged(file, all = false) {
    const remote = new Map();
    const times = new Map();
    const fileItems = (file && file.items) || {};
    for (const id of Object.keys(fileItems)) {
      const it = fileItems[id];
      times.set(id, it.t);
      const agreed = state.items[id];
      if (!all && agreed && agreed.t >= it.t) {
        if (agreed.p && agreed.t <= it.t) delete agreed.p; // the server has what this TV sent
        continue;
      }
      if (it.x) {
        remote.set(id, { kind: agreed ? agreed.k : null, value: null, x: true, t: it.t });
        continue;
      }
      try {
        const { k, v } = await open(state.keys, it.c);
        remote.set(id, { kind: k, value: v, x: false, t: it.t });
        ids.set(k, id);
      } catch (err) {
        log.warn('Sync: an item could not be opened', err && err.message);
      }
    }
    return { remote, times };
  }

  async function send(list, create = null) {
    if (!list.length) return 0;
    const sealed = [];
    const at = now();
    for (const it of list) sealed.push({ i: it.id, t: at, d: state.device, x: it.x, c: it.x ? '' : await seal(state.keys, { k: it.kind, v: it.value }) });
    const groups = batches(sealed);
    const sent = groups.reduce((n, g) => n + g.length, 0);
    if (sent < sealed.length) log.warn(`Sync: ${sealed.length - sent} items too large to send`);
    // A new account goes with every event: the first one the server merges makes it (the others find it there).
    for (const group of groups) await transport.send({ account: state.keys.account, auth: state.keys.auth, ...(create ? { create } : {}), items: group });
    const sentIds = new Set([].concat(...groups).map((it) => it.i));
    list.forEach((it) => {
      if (!sentIds.has(it.id)) return;
      state.items[it.id] = { k: it.kind, h: it.x ? null : hashText(canonical(it.value)), t: at, x: it.x, p: at };
    });
    state.lastPush = at;
    state.touched = dayOf(at);
    return sentIds.size;
  }

  /** One round. `pull`: read the server; `applyRemote`: write its changes here (only before the app reads its data). */
  /**
   * One round. `pull`: read the server; `applyRemote`: write its changes here (only before the app reads its data); `sendLocal`: send
   * this TV's changes (not at the start: the background round does it a minute later, so the start never waits for them).
   */
  async function round({ pull = true, applyRemote = false, sendLocal = true, readTimeoutMs } = {}) {
    await load();
    if (!state) return { applied: 0, sent: 0 };
    let remote = new Map();
    let times = null;
    let create = null;
    let etag = state.etag;
    const pending = Object.keys(state.items).some((id) => state.items[id].p);
    const today = dayOf(now());
    // Nothing written to the synced stores since the last round, nothing waiting, the day already told: nothing to do (no read of the data).
    if (!pull && !pending && sendLocal && seenWrites === syncedWriteCount() && state.touched === today && now() - lastFull < FULL_EVERY_MS) return { applied: 0, sent: 0 };
    let remoteChanged = false;
    if (pull || pending) {
      const res = await transport.read(state.keys.account, state.etag, readTimeoutMs ? { timeoutMs: readTimeoutMs } : undefined);
      if (res.status === 'ok') {
        etag = res.etag;
        state.rev = res.file.rev;
        ({ remote, times } = await openChanged(res.file));
        remoteChanged = remote.size > 0;
        if (res.file.fails && res.file.fails.day === today && res.file.fails.count >= 5) state.locked = res.file.fails.day;
      } else if (res.status === 'none' && !pending) {
        // The account is not there (removed by the server's cleanup after 30 days without use): made again with what this TV has.
        state.items = {};
        create = { check: await sealCheck(state.keys) };
      }
    }
    // The start: the server unchanged, nothing to write here: this TV's data is not even read (the start never waits for it).
    if (!sendLocal && !remoteChanged) {
      if (etag) state.etag = etag;
      await save();
      return { applied: 0, sent: 0 };
    }
    const local = await localItems();
    const plan = planRound({ local, items: state.items, remote, remoteTimes: times, idOf: (k) => ids.get(k), now: now(), applyRemote });
    if (!sendLocal) plan.send = [];
    // Changes of the server left for the next start: the file is read again then (not answered "unchanged").
    if (!plan.skipped) state.etag = etag;
    if (plan.apply.length) {
      await applyChanges({ db, openProfileDb, device: state.device, changes: plan.apply.map((a) => ({ kind: a.kind, value: a.value })) });
      plan.apply.forEach((a) => {
        state.items[a.id] = { k: a.kind, h: a.x ? null : hashText(canonical(a.value)), t: a.t, x: a.x };
      });
    }
    const sent = await send(plan.send, create);
    // Once a day at least the server hears from this TV (an account not heard from for 30 days is removed).
    if (sendLocal && !sent && (create || state.touched !== today)) {
      await transport.send({ account: state.keys.account, auth: state.keys.auth, ...(create ? { create } : {}), items: [] });
      state.touched = today;
    }
    state.lastSync = now();
    state.lastError = '';
    await save();
    if (sendLocal) {
      seenWrites = syncedWriteCount();
      lastFull = now();
    }
    return { applied: plan.apply.length, sent };
  }

  const serial = (work) => {
    const next = running.then(work, work);
    running = next.catch(() => undefined);
    return next;
  };

  const engine = {
    /** Whether this TV uses an account. */
    async connected() {
      return Boolean(await load());
    },
    async info() {
      const s = await load();
      if (!s) return null;
      return { username: s.username, password: s.password, lastSync: s.lastSync || 0, lastPush: s.lastPush || 0, rev: s.rev || 0, lastError: s.lastError || '', locked: s.locked === dayOf(now()) };
    },
    /**
     * Logs in. Resolves { status }: 'wrong' (the account exists, the password does not open it), 'none' (no such account: made only
     * when `create`), 'created', 'empty' (it exists with nothing in it), 'remote' (it holds data: `replace()` takes it, `cancel()` forgets
     * the login). `password` must be long enough (MIN_PASSWORD, checked by the page).
     */
    async login(username, password, { create = false } = {}) {
      const keys = await deriveAccount(username, password);
      const res = await transport.read(keys.account, '');
      const base = { username: normalizeUsername(username), password: String(password), keys, device: (state && state.device) || newDevice(), rev: 0, etag: '', items: {} };
      if (res.status === 'none') {
        if (!create) return { status: 'none' };
        state = base;
        await transport.send({ account: keys.account, auth: keys.auth, create: { check: await sealCheck(keys) }, items: [] });
        await save();
        return { status: 'created' };
      }
      if (!res.file || !(await checkOpens(keys, res.file.check))) return { status: 'wrong' };
      state = base;
      const count = Object.keys(res.file.items || {}).filter((id) => !res.file.items[id].x).length;
      engine.pendingFile = res;
      if (!count) {
        await save();
        return { status: 'empty' };
      }
      return { status: 'remote', count };
    },
    /** After a login: this TV's synced data replaced by the account's (then the app starts again). */
    async replace() {
      const res = engine.pendingFile;
      engine.pendingFile = null;
      await clearLocal({ db, openProfileDb, device: state.device });
      state.items = {};
      state.etag = res.etag;
      state.rev = res.file.rev;
      const { remote } = await openChanged(res.file, true);
      const local = new Map();
      const plan = planRound({ local, items: {}, remote, remoteTimes: null, idOf: () => '', now: now(), applyRemote: true, replaceLocal: true });
      await applyChanges({ db, openProfileDb, device: state.device, changes: plan.apply.map((a) => ({ kind: a.kind, value: a.value })) });
      plan.apply.forEach((a) => {
        state.items[a.id] = { k: a.kind, h: a.x ? null : hashText(canonical(a.value)), t: a.t, x: a.x };
      });
      state.lastSync = now();
      await save();
      return plan.apply.length;
    },
    /** A login not confirmed: nothing kept. */
    async cancel() {
      engine.pendingFile = null;
      state = await kvGet(db, STATE_KEY, null);
    },
    /** The last error of a round, for the Settings page. */
    async noteError(message) {
      await load();
      if (!state) return;
      state.lastError = String(message || '');
      await save();
    },
    /** This TV leaves the sync (the page then resets the app). */
    async disconnect() {
      state = null;
      await kvDelete(db, STATE_KEY);
    },
    /**
     * At the start, before the app reads its data: the server's changes written here, this TV's sent. The server is waited for
     * `readTimeoutMs` at most (offline: the app starts with what it has).
     */
    atStart: ({ readTimeoutMs = 3000 } = {}) => serial(() => round({ pull: true, applyRemote: true, sendLocal: false, readTimeoutMs })),
    /** In the background: this TV's changes sent (the server read only to confirm what was sent). */
    push: () => serial(() => round({ pull: false, applyRemote: false })),
    /** "Sync now": both ways; resolves with { applied } (the page starts the app again when something was written). */
    now: () => serial(() => round({ pull: true, applyRemote: true })),
    /**
     * The latest value of one kind on the server (the Trakt token renewed by another TV), written here when newer; null when there is none.
     */
    fetchKind: (kind) =>
      serial(async () => {
        await load();
        if (!state) return null;
        const res = await transport.read(state.keys.account, '');
        if (res.status !== 'ok') return null;
        const id = await idOfAsync(kind);
        const it = res.file.items && res.file.items[id];
        if (!it || it.x) return null;
        const agreed = state.items[id];
        const { v } = await open(state.keys, it.c);
        if (!agreed || agreed.t < it.t) {
          await applyChanges({ db, openProfileDb, device: state.device, changes: [{ kind, value: v }] });
          state.items[id] = { k: kind, h: hashText(canonical(v)), t: it.t, x: false };
          await save();
        }
        return v;
      }),
    /** Counts per section: here, and agreed with the server (as of the last round). */
    async counts() {
      await load();
      if (!state) return null;
      const here = {};
      const agreed = {};
      const local = await collectLocal({ db, openProfileDb, device: state.device });
      local.forEach((v, kind) => {
        const s = sectionOf(kind);
        here[s] = (here[s] || 0) + 1;
      });
      let pending = 0;
      Object.keys(state.items).forEach((id) => {
        const it = state.items[id];
        if (!it.k || it.x) return;
        const s = sectionOf(it.k);
        agreed[s] = (agreed[s] || 0) + 1;
        if (it.p) pending += 1;
      });
      return { here, agreed, pending };
    },
    pendingFile: null,
  };
  return engine;
}
