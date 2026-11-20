import nodeCrypto from 'crypto';
import { sha256Sync, hmacSync, pbkdf2Sync, aesGcmEncryptSync, aesGcmDecryptSync, aesGcmEncrypt, aesGcmDecrypt, pbkdf2, toHex, fromHex, toBase64, fromBase64, utf8 } from '../../src/core/crypto.js';

const buf = (u8) => Buffer.from(u8);
const bytes = (b) => new Uint8Array(b);

beforeAll(() => {
  const util = require('util');
  if (!global.TextEncoder) global.TextEncoder = util.TextEncoder;
  if (!global.TextDecoder) global.TextDecoder = util.TextDecoder;
});

test('SHA-256 and HMAC match Node', () => {
  ['', 'abc', 'x'.repeat(200)].forEach((text) => {
    expect(toHex(sha256Sync(utf8(text)))).toBe(nodeCrypto.createHash('sha256').update(text).digest('hex'));
    expect(toHex(hmacSync(utf8('key'), utf8(text)))).toBe(nodeCrypto.createHmac('sha256', 'key').update(text).digest('hex'));
  });
  const longKey = bytes(nodeCrypto.randomBytes(100));
  expect(toHex(hmacSync(longKey, utf8('m')))).toBe(nodeCrypto.createHmac('sha256', buf(longKey)).update('m').digest('hex'));
});

test('PBKDF2 matches Node (several blocks of output)', () => {
  const out = pbkdf2Sync(utf8('pässword'), utf8('salt'), 1000, 96);
  expect(toHex(out)).toBe(nodeCrypto.pbkdf2Sync('pässword', 'salt', 1000, 96, 'sha256').toString('hex'));
});

test('AES-256-GCM matches Node both ways, and refuses a wrong key or changed data', () => {
  const key = bytes(nodeCrypto.randomBytes(32));
  const iv = bytes(nodeCrypto.randomBytes(12));
  [0, 1, 15, 16, 17, 100, 1000].forEach((n) => {
    const plain = bytes(nodeCrypto.randomBytes(n));
    const sealed = aesGcmEncryptSync(key, iv, plain);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', buf(key), buf(iv));
    const expected = Buffer.concat([c.update(buf(plain)), c.final(), c.getAuthTag()]);
    expect(toHex(sealed)).toBe(expected.toString('hex'));
    expect(toHex(aesGcmDecryptSync(key, iv, sealed))).toBe(toHex(plain));
  });
  const sealed = aesGcmEncryptSync(key, iv, utf8('hello'));
  expect(() => aesGcmDecryptSync(bytes(nodeCrypto.randomBytes(32)), iv, sealed)).toThrow('decrypt failed');
  sealed[0] ^= 1;
  expect(() => aesGcmDecryptSync(key, iv, sealed)).toThrow('decrypt failed');
});

test('the async API gives the same bytes with or without Web Crypto', async () => {
  const key = bytes(nodeCrypto.randomBytes(32));
  const iv = bytes(nodeCrypto.randomBytes(12));
  const sealed = await aesGcmEncrypt(key, iv, utf8('ciao'));
  expect(toHex(sealed)).toBe(toHex(aesGcmEncryptSync(key, iv, utf8('ciao'))));
  expect(toHex(await aesGcmDecrypt(key, iv, sealed))).toBe(toHex(utf8('ciao')));
  await expect(aesGcmDecrypt(bytes(nodeCrypto.randomBytes(32)), iv, sealed)).rejects.toThrow('decrypt failed');
  expect(toHex(await pbkdf2(utf8('p'), utf8('s'), 10, 32))).toBe(nodeCrypto.pbkdf2Sync('p', 's', 10, 32, 'sha256').toString('hex'));
  expect(toHex(fromHex('0aff'))).toBe('0aff');
  expect(toHex(fromBase64(toBase64(bytes([1, 2, 255]))))).toBe('0102ff');
});
