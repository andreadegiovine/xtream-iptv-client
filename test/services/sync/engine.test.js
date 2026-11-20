import crypto from 'crypto';
import { openAppDb } from '../../../src/db/appDb.js';
import { kvGet, kvSet } from '../../../src/db/kv.js';
import { dbPut, dbGet } from '../../../src/core/idb.js';
import { createSyncEngine, planRound, batches } from '../../../src/services/sync/engine.js';

jest.mock('../../../src/services/sync/account.js', () => {
  const actual = jest.requireActual('../../../src/services/sync/account.js');
  return { ...actual, ITERATIONS: 10 };
});

beforeAll(() => {
  const util = require('util');
  if (!global.TextEncoder) global.TextEncoder = util.TextEncoder;
  if (!global.TextDecoder) global.TextDecoder = util.TextDecoder;
});

/** A server as the repository's workflow: the newer item wins; the account made by `create`; ETag = revision. */
function fakeServer() {
  const files = {};
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  return {
    files,
    sent: [],
    async read(account, etag) {
      const file = files[account];
      if (!file) return { status: 'none' };
      if (etag && etag === String(file.rev)) return { status: 'same' };
      return { status: 'ok', file: JSON.parse(JSON.stringify(file)), etag: String(file.rev) };
    },
    async send(payload) {
      this.sent.push(payload);
      let file = files[payload.account];
      if (!file) {
        if (!payload.create) return;
        file = files[payload.account] = { v: 1, rev: 0, auth: sha(payload.auth), check: payload.create.check, items: {} };
      }
      if (sha(payload.auth) !== file.auth) return;
      payload.items.forEach((it) => {
        const old = file.items[it.i];
        if (old && (old.t > it.t || (old.t === it.t && old.d >= it.d))) return;
        file.items[it.i] = { t: it.t, d: it.d, x: it.x, c: it.c };
      });
      file.rev += 1;
    },
  };
}

let clock = 1000000;
const now = () => clock;

async function tv(name, server) {
  const db = await openAppDb(`${name}-app`);
  const openProfileDb = (pid) => openAppDb(`${name}-profile-${pid}`);
  const engine = createSyncEngine({ db, openProfileDb, transport: server, now });
  return { db, engine, openProfileDb };
}

const favorite = (entryKey, addedAt) => ({ providerId: '', entryKey, type: 'movie', addedAt });

test('a TV uploads, another takes everything except the PINs and the settings of the device; changes go both ways', async () => {
  const server = fakeServer();
  const a = await tv('a1', server);
  await dbPut(a.db, 'providers', { id: 'p1', name: 'Prov', baseUrl: 'http://x', username: 'u', password: 'pw', createdAt: 1, slot: 1 });
  await kvSet(a.db, 'settings', { language: 'it-IT', textSize: 125, cleanTitles: false });
  await kvSet(a.db, 'apiKeys', { tmdbKey: 'k1' });
  await kvSet(a.db, 'parental', { salt: '1', hash: 'secret' });
  await kvSet(a.db, 'favorites', [favorite('movie:t1', 1), favorite('movie:t2', 2)]);
  await dbPut(a.db, 'watch', { key: 'movie:t1', position: 50, duration: 100, updatedAt: 5 });
  await kvSet(a.db, 'profiles', [{ id: 'main', name: 'Me', admin: true, pin: { salt: 's', hash: 'h' } }, { id: 'kid', name: 'Kid', kids: true, pin: null }]);
  const kidDb = await a.openProfileDb('kid');
  await kvSet(kidDb, 'favorites', [favorite('series:t9', 3)]);
  kidDb.close();

  expect((await a.engine.login('Andrea', 'password-long-enough', { create: true })).status).toBe('created');
  await a.engine.push();
  expect(Object.keys(server.files).length).toBe(1);

  const b = await tv('b1', server);
  await kvSet(b.db, 'settings', { language: 'en-US', textSize: 75 });
  expect((await b.engine.login('andrea ', 'wrong-password-123', {})).status).toBe('wrong');
  const login = await b.engine.login('ANDREA', 'password-long-enough', {});
  expect(login.status).toBe('remote');
  await b.engine.replace();
  expect((await dbGet(b.db, 'providers', 'p1')).password).toBe('pw');
  expect(await kvGet(b.db, 'settings')).toEqual({ language: 'it-IT', cleanTitles: false, textSize: 75 });
  expect(await kvGet(b.db, 'apiKeys')).toEqual({ tmdbKey: 'k1' });
  expect(await kvGet(b.db, 'parental', null)).toBeNull();
  expect((await kvGet(b.db, 'favorites')).map((f) => f.entryKey)).toEqual(['movie:t1', 'movie:t2']);
  expect((await kvGet(b.db, 'profiles')).map((p) => [p.id, p.pin])).toEqual([['main', null], ['kid', null]]);
  const bKid = await b.openProfileDb('kid');
  expect((await kvGet(bKid, 'favorites')).map((f) => f.entryKey)).toEqual(['series:t9']);
  bKid.close();

  // Each TV changes something different: both changes end up on both.
  clock += 10000;
  await kvSet(a.db, 'favorites', [favorite('movie:t1', 1), favorite('movie:t2', 2), favorite('movie:t3', 4)]);
  await dbPut(b.db, 'watch', { key: 'movie:t1', position: 90, duration: 100, updatedAt: 6 });
  await a.engine.push();
  await b.engine.push();
  clock += 10000;
  await a.engine.atStart();
  await b.engine.atStart();
  expect((await kvGet(b.db, 'favorites')).map((f) => f.entryKey)).toEqual(['movie:t1', 'movie:t2', 'movie:t3']);
  expect((await dbGet(a.db, 'watch', 'movie:t1')).position).toBe(90);

  // A removal goes too.
  clock += 10000;
  await kvSet(b.db, 'favorites', [favorite('movie:t2', 2), favorite('movie:t3', 4)]);
  await b.engine.push();
  clock += 10000;
  await a.engine.atStart();
  expect((await kvGet(a.db, 'favorites')).map((f) => f.entryKey)).toEqual(['movie:t2', 'movie:t3']);
  // Nothing new: nothing sent again.
  const before = server.sent.length;
  await a.engine.push();
  await b.engine.push();
  expect(server.sent.length).toBe(before);
});

test('changes of the server seen in the background are written at the next start (not lost)', async () => {
  const server = fakeServer();
  const a = await tv('a2', server);
  const b = await tv('b2', server);
  await kvSet(a.db, 'apiKeys', { tmdbKey: 'one' });
  await a.engine.login('x', 'password-long-enough', { create: true });
  await a.engine.push();
  await b.engine.login('x', 'password-long-enough');
  await b.engine.replace();
  clock += 10000;
  await kvSet(a.db, 'apiKeys', { tmdbKey: 'two' });
  await a.engine.push();
  // B sends something of its own and reads the server (its own item pending): A's change is not written now...
  clock += 10000;
  await kvSet(b.db, 'adultMarks', { p1: { 'movie:t1': true } });
  await b.engine.push();
  clock += 5 * 60 * 1000;
  await b.engine.push();
  expect(await kvGet(b.db, 'apiKeys')).toEqual({ tmdbKey: 'one' });
  // ...but at the next start.
  await b.engine.atStart();
  expect(await kvGet(b.db, 'apiKeys')).toEqual({ tmdbKey: 'two' });
});

test('the Trakt token renewed by another TV is fetched', async () => {
  const server = fakeServer();
  const a = await tv('a3', server);
  const b = await tv('b3', server);
  await kvSet(a.db, 'trakt.token', { accessToken: 'old', refreshToken: 'r1', expiresAt: 1 });
  await a.engine.login('t', 'password-long-enough', { create: true });
  await a.engine.push();
  await b.engine.login('t', 'password-long-enough');
  await b.engine.replace();
  clock += 10000;
  await kvSet(a.db, 'trakt.token', { accessToken: 'new', refreshToken: 'r2', expiresAt: 2 });
  await a.engine.push();
  expect(await b.engine.fetchKind('main|kv:trakt.token')).toEqual({ accessToken: 'new', refreshToken: 'r2', expiresAt: 2 });
  expect((await kvGet(b.db, 'trakt.token')).accessToken).toBe('new');
});

test('plan: changed on both sides, this TV wins; a removal here becomes one there', () => {
  const local = new Map([['k1', { h: 'new', value: 1 }]]);
  const items = { id1: { k: 'k1', h: 'old', t: 1 }, id2: { k: 'k2', h: 'x', t: 1 } };
  const remote = new Map([['id1', { kind: 'k1', value: 2, x: false, t: 5 }]]);
  const plan = planRound({ local, items, remote, remoteTimes: null, idOf: (k) => (k === 'k1' ? 'id1' : 'id2'), now: 10, applyRemote: true });
  expect(plan.apply).toEqual([]);
  expect(plan.send).toEqual([
    { id: 'id1', kind: 'k1', value: 1, x: false },
    { id: 'id2', kind: 'k2', value: null, x: true },
  ]);
});

test('large sends are split in events', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ i: String(i), c: 'x'.repeat(20000) }));
  const groups = batches(items);
  expect(groups.length).toBe(5);
  expect(groups.every((g) => JSON.stringify(g).length < 60000)).toBe(true);
});
