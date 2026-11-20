const crypto = require('crypto');
const loader = require('../../src/boot/loader.js');

const { pickStart, sha256Hex, newer, keys } = loader;

describe('pickStart', () => {
  test('nothing kept: the package', () => {
    expect(pickStart({ a: null, b: null }, '3.0.0', null)).toEqual({ run: null, trial: false, remove: [], failed: null });
  });

  test('the version that works, when no update waits', () => {
    expect(pickStart({ a: { version: '3.1.0', state: 'ok' }, b: null }, '3.0.0', null)).toMatchObject({ run: 'a', trial: false, remove: [] });
  });

  test('a downloaded update goes on trial before the version that works', () => {
    const metas = { a: { version: '3.1.0', state: 'ok' }, b: { version: '3.2.0', state: 'trial' } };
    expect(pickStart(metas, '3.0.0', null)).toMatchObject({ run: 'b', trial: true, remove: [] });
  });

  test('a trial that never confirmed is removed: back to the version that works', () => {
    const metas = { a: { version: '3.1.0', state: 'ok' }, b: { version: '3.2.0', state: 'trial' } };
    expect(pickStart(metas, '3.0.0', 'b@3.2.0')).toEqual({ run: 'a', trial: false, remove: ['b'], failed: { slot: 'b', version: '3.2.0' } });
  });

  test('slots not newer than the package are removed (a newer package was installed)', () => {
    const metas = { a: { version: '3.1.0', state: 'ok' }, b: { version: '3.0.0', state: 'trial' } };
    expect(pickStart(metas, '3.1.0', null)).toEqual({ run: null, trial: false, remove: ['a', 'b'], failed: null });
  });

  test('a trial not newer than the version that works is removed', () => {
    const metas = { a: { version: '3.2.0', state: 'ok' }, b: { version: '3.2.0', state: 'trial' } };
    expect(pickStart(metas, '3.0.0', null)).toMatchObject({ run: 'a', trial: false, remove: ['b'] });
  });

  test('a slot without a valid state is removed', () => {
    expect(pickStart({ a: { version: '3.2.0' }, b: null }, '3.0.0', null)).toMatchObject({ run: null, remove: ['a'] });
  });
});

test('newer compares versions part by part', () => {
  expect(newer('3.10.0', '3.9.9')).toBe(true);
  expect(newer('3.1', '3.1.0')).toBe(false);
});

test('the SHA-256 in plain JavaScript matches Node', () => {
  const samples = ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(1000)];
  samples.forEach((text) => {
    const bytes = new Uint8Array(Buffer.from(text));
    expect(sha256Hex(bytes)).toBe(crypto.createHash('sha256').update(text).digest('hex'));
  });
  const random = crypto.randomBytes(100000);
  expect(sha256Hex(new Uint8Array(random))).toBe(crypto.createHash('sha256').update(random).digest('hex'));
});

test('the keys the app reads are the loader’s', () => {
  expect(keys.FAILED_KEY).toBe('xi.updateFailed');
});

describe('the database store (webOS)', () => {
  beforeAll(() => {
    // jsdom has no TextEncoder / blob URLs of its own.
    const util = require('util');
    if (!global.TextEncoder) global.TextEncoder = util.TextEncoder;
    if (!global.TextDecoder) global.TextDecoder = util.TextDecoder;
    let n = 0;
    global.URL.createObjectURL = () => `blob:test/${(n += 1)}`;
  });

  test('writes, reads the state, gives blob addresses with the fonts of the slot, empties a slot', async () => {
    const store = loader.dbStore(indexedDB);
    expect(await store.meta('a')).toBeNull();
    await store.write('a', 'js/main.js', 'console.log(1)');
    await store.write('a', 'fonts/inter.woff2', new Uint8Array([1, 2, 3]).buffer);
    await store.write('a', 'css/main.css', 'body{}@font-face{src:url(../fonts/inter.woff2)}');
    await store.write('a', 'slot.json', JSON.stringify({ version: '3.2.0', state: 'trial', files: ['css/main.css', 'fonts/inter.woff2', 'js/main.js'] }));
    await store.write('b', 'slot.json', JSON.stringify({ version: '3.1.0', state: 'ok', files: [] }));
    const meta = await store.meta('a');
    expect(meta).toMatchObject({ version: '3.2.0', state: 'trial' });
    const map = await store.urls('a', meta);
    expect(Object.keys(map).sort()).toEqual(['css/main.css', 'fonts/inter.woff2', 'js/main.js']);
    await store.remove('a');
    expect(await store.meta('a')).toBeNull();
    expect(await store.meta('b')).toMatchObject({ version: '3.1.0' });
  });

  test('a missing file fails the addresses (the slot is not started)', async () => {
    const store = loader.dbStore(indexedDB);
    await store.write('a', 'slot.json', JSON.stringify({ version: '3.2.0', state: 'trial', files: ['js/main.js'] }));
    await expect(store.urls('a', await store.meta('a'))).rejects.toThrow('missing js/main.js');
  });
});
