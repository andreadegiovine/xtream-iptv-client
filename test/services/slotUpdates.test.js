import crypto from 'crypto';
import { installToSlot, buildManifest, takeFailedUpdate, skippedVersion, skipVersion } from '../../src/services/slotUpdates.js';

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const BASE = 'https://pages.test/bundles/3.2.0/webos/';

function fakeSlots(running = 'a') {
  const files = { a: {}, b: {} };
  return {
    files,
    free: () => (running === 'a' ? 'b' : 'a'),
    meta: async (slot) => (files[slot]['slot.json'] ? JSON.parse(files[slot]['slot.json']) : null),
    write: async (slot, path, data) => {
      files[slot][path] = typeof data === 'string' ? data : Buffer.from(data).toString();
    },
    remove: async (slot) => {
      files[slot] = {};
    },
    sha256Hex: () => {
      throw new Error('not used: crypto.subtle is there');
    },
  };
}

function fakeFetch(bodies, { all } = {}) {
  return async (url) => {
    if (url === `${BASE}files.json`) {
      return { ok: true, json: async () => ({ files: ['js/main.js'], all: all || Object.keys(bodies).map((path) => ({ path, sha256: sha(bodies[path]) })) }) };
    }
    const path = url.slice(BASE.length);
    if (!(path in bodies)) return { ok: false, status: 404 };
    return { ok: true, arrayBuffer: async () => new Uint8Array(Buffer.from(bodies[path])).buffer };
  };
}

beforeAll(() => {
  if (!global.crypto || !global.crypto.subtle) {
    Object.defineProperty(global, 'crypto', { value: crypto.webcrypto, configurable: true });
  }
});

test('downloads every file into the free slot, checked, then slot.json on trial', async () => {
  const slots = fakeSlots('a');
  const bodies = { 'js/main.js': 'main', 'css/main.css': 'css', 'fonts/inter.woff2': 'font' };
  const progress = [];
  const slot = await installToSlot({ version: '3.2.0', base: BASE }, { slots, fetchImpl: fakeFetch(bodies), onProgress: (d, t) => progress.push(`${d}/${t}`) });
  expect(slot).toBe('b');
  expect(slots.files.b['js/main.js']).toBe('main');
  expect(JSON.parse(slots.files.b['slot.json'])).toMatchObject({ version: '3.2.0', state: 'trial', files: ['js/main.js', 'css/main.css', 'fonts/inter.woff2'] });
  expect(progress).toEqual(['1/3', '2/3', '3/3']);
});

test('a file that does not match its SHA-256 empties the slot', async () => {
  const slots = fakeSlots('a');
  const bodies = { 'js/main.js': 'main', 'css/main.css': 'css' };
  const all = [
    { path: 'js/main.js', sha256: sha('main') },
    { path: 'css/main.css', sha256: sha('something else') },
  ];
  await expect(installToSlot({ version: '3.2.0', base: BASE }, { slots, fetchImpl: fakeFetch(bodies, { all }) })).rejects.toThrow('css/main.css: SHA-256 does not match');
  expect(slots.files.b).toEqual({});
});

test('a file that does not download empties the slot', async () => {
  const slots = fakeSlots('b');
  const all = [
    { path: 'js/main.js', sha256: sha('main') },
    { path: 'js/page.js', sha256: sha('page') },
  ];
  await expect(installToSlot({ version: '3.2.0', base: BASE }, { slots, fetchImpl: fakeFetch({ 'js/main.js': 'main' }, { all }) })).rejects.toThrow('js/page.js: HTTP 404');
  expect(slots.files.a).toEqual({});
});

test('the same update already waiting for its start is not downloaded again', async () => {
  const slots = fakeSlots('a');
  slots.files.b['slot.json'] = JSON.stringify({ version: '3.2.0', state: 'trial', files: [] });
  const fetchImpl = jest.fn();
  expect(await installToSlot({ version: '3.2.0', base: BASE }, { slots, fetchImpl })).toBe('b');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a build without the SHA-256 of its files is refused', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ files: ['js/main.js'] }) });
  expect(await buildManifest(BASE, fetchImpl)).toBeNull();
  await expect(installToSlot({ version: '3.2.0', base: BASE }, { slots: fakeSlots(), fetchImpl })).rejects.toThrow('does not list the SHA-256');
});

test('names outside the build are refused', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ all: [{ path: '../x.js', sha256: sha('x') }, { path: 'js/main.js', sha256: sha('m') }] }) });
  await expect(buildManifest(BASE, fetchImpl)).rejects.toThrow('invalid list');
});

test('the failed update is told once; the skipped version is kept', () => {
  window.localStorage.setItem('xi.updateFailed', JSON.stringify({ version: '3.2.0', reason: 'x' }));
  expect(takeFailedUpdate()).toMatchObject({ version: '3.2.0' });
  expect(takeFailedUpdate()).toBeNull();
  skipVersion('3.2.0');
  expect(skippedVersion()).toBe('3.2.0');
});
