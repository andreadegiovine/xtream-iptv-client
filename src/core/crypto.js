/**
 * The cryptography of the device sync (services/sync): SHA-256, HMAC-SHA-256, PBKDF2-SHA-256 and AES-256-GCM. The browser's own
 * (crypto.subtle) when the page has it, otherwise the same algorithms in plain JavaScript (a TV page loaded from file:// may not have it).
 * Both give the same bytes (tested against Node). Everything is async; inputs and outputs are Uint8Array.
 */

const subtle = () => {
  try {
    return typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.importKey === 'function' ? crypto.subtle : null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ encodings */

export const utf8 = (text) => new TextEncoder().encode(String(text));
export const fromUtf8 = (bytes) => new TextDecoder().decode(bytes);
export const toHex = (bytes) => Array.prototype.map.call(bytes, (b) => `0${b.toString(16)}`.slice(-2)).join('');
export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export function fromBase64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  parts.forEach((p) => {
    out.set(p, at);
    at += p.length;
  });
  return out;
}
export function randomBytes(n) {
  const out = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(out);
  else for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/* ------------------------------------------------------------------ SHA-256 / HMAC / PBKDF2 in JavaScript */

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Int32Array(64);

/** One 64-byte block into the state `h` (Int32Array(8)). */
function compress(h, view, offset) {
  for (let i = 0; i < 16; i += 1) W[i] = view.getInt32(offset + i * 4);
  for (let i = 16; i < 64; i += 1) {
    const a = W[i - 15];
    const b = W[i - 2];
    W[i] = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + W[i - 7] + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) + W[i - 16];
  }
  let [a, b, c, d, e, f, g, k] = h;
  for (let i = 0; i < 64; i += 1) {
    const t1 = (k + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    k = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
  h[5] += f;
  h[6] += g;
  h[7] += k;
}

const INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

function stateBytes(h) {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) view.setInt32(i * 4, h[i]);
  return out;
}

/** SHA-256 of bytes, in JavaScript. */
export function sha256Sync(bytes) {
  const length = bytes.length;
  const total = ((length + 9 + 63) >> 6) << 6;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(total - 4, (length * 8) >>> 0);
  view.setUint32(total - 8, Math.floor((length * 8) / 0x100000000));
  const h = new Int32Array(INIT);
  for (let offset = 0; offset < total; offset += 64) compress(h, view, offset);
  return stateBytes(h);
}

/** HMAC-SHA-256 in JavaScript. */
export function hmacSync(key, data) {
  let k = key.length > 64 ? sha256Sync(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64);
  const outer = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  k = null;
  return sha256Sync(concat(outer, sha256Sync(concat(inner, data))));
}

/**
 * PBKDF2-SHA-256 in JavaScript. The pads of the key are hashed once (the states after the first block are reused), so each iteration
 * costs two blocks.
 */
export function pbkdf2Sync(password, salt, iterations, length) {
  const block = new Uint8Array(64);
  block.set(password.length > 64 ? sha256Sync(password) : password);
  const pad = (byte) => {
    const p = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) p[i] = block[i] ^ byte;
    const h = new Int32Array(INIT);
    compress(h, new DataView(p.buffer), 0);
    return h;
  };
  const innerState = pad(0x36);
  const outerState = pad(0x5c);
  // A 32-byte message after the pad block: one more block, with the padding for 64 + 32 bytes.
  const msg = new Uint8Array(64);
  const msgView = new DataView(msg.buffer);
  msg[32] = 0x80;
  msgView.setUint32(60, (64 + 32) * 8);
  const finish = (state, digest) => {
    msg.set(digest);
    const h = new Int32Array(state);
    compress(h, msgView, 0);
    return stateBytes(h);
  };
  const out = new Uint8Array(length);
  for (let blockIndex = 1, at = 0; at < length; blockIndex += 1) {
    const first = new Uint8Array(salt.length + 4);
    first.set(salt);
    new DataView(first.buffer).setUint32(salt.length, blockIndex);
    let u = hmacSync(password, first);
    const t = u.slice();
    for (let i = 1; i < iterations; i += 1) {
      u = finish(outerState, finish(innerState, u));
      for (let j = 0; j < 32; j += 1) t[j] ^= u[j];
    }
    out.set(t.subarray(0, Math.min(32, length - at)), at);
    at += 32;
  }
  return out;
}

/* ------------------------------------------------------------------ AES-256-GCM in JavaScript */

const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256);
const T1 = new Uint32Array(256);
const T2 = new Uint32Array(256);
const T3 = new Uint32Array(256);
(function tables() {
  // The S-box from the inverse in GF(2^8) (log / exp tables of the generator 3) and the affine map; T* hold MixColumns of each output.
  const exp = new Uint8Array(256);
  const lg = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = x;
    lg[x] = i;
    x ^= ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
  }
  const rotl = (v, n) => ((v << n) | (v >>> (8 - n))) & 0xff;
  for (let i = 0; i < 256; i += 1) {
    const inv = i ? exp[(255 - lg[i]) % 255] : 0;
    SBOX[i] = inv ^ rotl(inv, 1) ^ rotl(inv, 2) ^ rotl(inv, 3) ^ rotl(inv, 4) ^ 0x63;
  }
  for (let i = 0; i < 256; i += 1) {
    const s = SBOX[i];
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x1b : 0)) & 0xff;
    const s3 = s2 ^ s;
    T0[i] = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T1[i] = ((s3 << 24) | (s2 << 16) | (s << 8) | s) >>> 0;
    T2[i] = ((s << 24) | (s3 << 16) | (s2 << 8) | s) >>> 0;
    T3[i] = ((s << 24) | (s << 16) | (s3 << 8) | s2) >>> 0;
  }
})();

/** The round keys of a 32-byte key (AES-256: 15 round keys of 4 words). */
function expandKey(key) {
  const words = new Uint32Array(60);
  for (let i = 0; i < 8; i += 1) words[i] = ((key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3]) >>> 0;
  let rcon = 1;
  for (let i = 8; i < 60; i += 1) {
    let t = words[i - 1];
    if (i % 8 === 0) {
      t = ((SBOX[(t >>> 16) & 0xff] << 24) | (SBOX[(t >>> 8) & 0xff] << 16) | (SBOX[t & 0xff] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
      rcon = ((rcon << 1) ^ ((rcon >> 7) * 0x11b)) & 0xff;
    } else if (i % 8 === 4) {
      t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) | (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff];
    }
    words[i] = (words[i - 8] ^ t) >>> 0;
  }
  return words;
}

/** One 16-byte block through AES (in: 4 words, out: 4 words). */
function encryptBlock(rk, s0, s1, s2, s3) {
  let a = s0 ^ rk[0];
  let b = s1 ^ rk[1];
  let c = s2 ^ rk[2];
  let d = s3 ^ rk[3];
  let k = 4;
  for (let round = 1; round < 14; round += 1) {
    const a2 = T0[a >>> 24] ^ T1[(b >>> 16) & 0xff] ^ T2[(c >>> 8) & 0xff] ^ T3[d & 0xff] ^ rk[k];
    const b2 = T0[b >>> 24] ^ T1[(c >>> 16) & 0xff] ^ T2[(d >>> 8) & 0xff] ^ T3[a & 0xff] ^ rk[k + 1];
    const c2 = T0[c >>> 24] ^ T1[(d >>> 16) & 0xff] ^ T2[(a >>> 8) & 0xff] ^ T3[b & 0xff] ^ rk[k + 2];
    const d2 = T0[d >>> 24] ^ T1[(a >>> 16) & 0xff] ^ T2[(b >>> 8) & 0xff] ^ T3[c & 0xff] ^ rk[k + 3];
    a = a2;
    b = b2;
    c = c2;
    d = d2;
    k += 4;
  }
  const last = (w, x, y, z, r) => ((SBOX[w >>> 24] << 24) | (SBOX[(x >>> 16) & 0xff] << 16) | (SBOX[(y >>> 8) & 0xff] << 8) | SBOX[z & 0xff]) ^ r;
  return [last(a, b, c, d, rk[k]) >>> 0, last(b, c, d, a, rk[k + 1]) >>> 0, last(c, d, a, b, rk[k + 2]) >>> 0, last(d, a, b, c, rk[k + 3]) >>> 0];
}

/** Multiplication in GF(2^128) of GCM (4 big-endian words each). */
function gmul(x, y) {
  let z0 = 0;
  let z1 = 0;
  let z2 = 0;
  let z3 = 0;
  let v0 = y[0];
  let v1 = y[1];
  let v2 = y[2];
  let v3 = y[3];
  for (let i = 0; i < 128; i += 1) {
    if ((x[i >> 5] >>> (31 - (i & 31))) & 1) {
      z0 ^= v0;
      z1 ^= v1;
      z2 ^= v2;
      z3 ^= v3;
    }
    const lsb = v3 & 1;
    v3 = (v3 >>> 1) | ((v2 & 1) << 31);
    v2 = (v2 >>> 1) | ((v1 & 1) << 31);
    v1 = (v1 >>> 1) | ((v0 & 1) << 31);
    v0 >>>= 1;
    if (lsb) v0 ^= 0xe1000000;
  }
  return [z0 >>> 0, z1 >>> 0, z2 >>> 0, z3 >>> 0];
}

const wordsOf = (bytes, at) => {
  const w = [0, 0, 0, 0];
  for (let i = 0; i < 16; i += 1) w[i >> 2] |= (at + i < bytes.length ? bytes[at + i] : 0) << (24 - 8 * (i & 3));
  return w.map((x) => x >>> 0);
};

function ghash(h, aad, data) {
  let y = [0, 0, 0, 0];
  const feed = (bytes) => {
    for (let at = 0; at < bytes.length; at += 16) {
      const w = wordsOf(bytes, at);
      y = gmul([y[0] ^ w[0], y[1] ^ w[1], y[2] ^ w[2], y[3] ^ w[3]], h);
    }
  };
  feed(aad);
  feed(data);
  const bits = [Math.floor((aad.length * 8) / 0x100000000), (aad.length * 8) >>> 0, Math.floor((data.length * 8) / 0x100000000), (data.length * 8) >>> 0];
  return gmul([y[0] ^ bits[0], y[1] ^ bits[1], y[2] ^ bits[2], y[3] ^ bits[3]], h);
}

/** CTR of GCM from counter block J0 + 1 (96-bit IV), in place on a copy. */
function gctr(rk, iv, input) {
  const out = new Uint8Array(input.length);
  const ivw = wordsOf(iv, 0);
  let counter = 2;
  for (let at = 0; at < input.length; at += 16) {
    const ks = encryptBlock(rk, ivw[0], ivw[1], ivw[2], counter >>> 0);
    counter += 1;
    for (let i = 0; i < 16 && at + i < input.length; i += 1) out[at + i] = input[at + i] ^ ((ks[i >> 2] >>> (24 - 8 * (i & 3))) & 0xff);
  }
  return out;
}

function tagOf(rk, iv, cipher) {
  const h = encryptBlock(rk, 0, 0, 0, 0);
  const s = ghash(h, new Uint8Array(0), cipher);
  const ivw = wordsOf(iv, 0);
  const j0 = encryptBlock(rk, ivw[0], ivw[1], ivw[2], 1);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) tag[i] = ((s[i >> 2] ^ j0[i >> 2]) >>> (24 - 8 * (i & 3))) & 0xff;
  return tag;
}

/** AES-256-GCM in JavaScript: cipher text with the 16-byte tag at the end (as Web Crypto gives it). */
export function aesGcmEncryptSync(key, iv, plain) {
  const rk = expandKey(key);
  const cipher = gctr(rk, iv, plain);
  return concat(cipher, tagOf(rk, iv, cipher));
}

/** AES-256-GCM in JavaScript; throws when the tag does not match (a wrong key, or changed data). */
export function aesGcmDecryptSync(key, iv, sealed) {
  if (sealed.length < 16) throw new Error('decrypt failed');
  const rk = expandKey(key);
  const cipher = sealed.subarray(0, sealed.length - 16);
  const tag = tagOf(rk, iv, cipher);
  let diff = 0;
  for (let i = 0; i < 16; i += 1) diff |= tag[i] ^ sealed[sealed.length - 16 + i];
  if (diff) throw new Error('decrypt failed');
  return gctr(rk, iv, cipher);
}

/* ------------------------------------------------------------------ the async API (Web Crypto when there) */

export async function sha256(bytes) {
  const s = subtle();
  if (s) {
    try {
      return new Uint8Array(await s.digest('SHA-256', bytes));
    } catch {
      /* the plain one */
    }
  }
  return sha256Sync(bytes);
}

export async function hmac(key, data) {
  const s = subtle();
  if (s) {
    try {
      const k = await s.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new Uint8Array(await s.sign('HMAC', k, data));
    } catch {
      /* the plain one */
    }
  }
  return hmacSync(key, data);
}

/** An HMAC-SHA-256 signer for one key: its key imported once (thousands of ids are signed with the same key). */
export async function hmacSigner(key) {
  const s = subtle();
  if (s) {
    try {
      const k = await s.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return async (data) => new Uint8Array(await s.sign('HMAC', k, data));
    } catch {
      /* the plain one */
    }
  }
  return async (data) => hmacSync(key, data);
}

export async function pbkdf2(password, salt, iterations, length) {
  const s = subtle();
  if (s) {
    try {
      const k = await s.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
      return new Uint8Array(await s.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, k, length * 8));
    } catch {
      /* the plain one */
    }
  }
  return pbkdf2Sync(password, salt, iterations, length);
}

export async function aesGcmEncrypt(key, iv, plain) {
  const s = subtle();
  if (s) {
    try {
      const k = await s.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
      return new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv }, k, plain));
    } catch {
      /* the plain one */
    }
  }
  return aesGcmEncryptSync(key, iv, plain);
}

export async function aesGcmDecrypt(key, iv, sealed) {
  const s = subtle();
  if (s) {
    let k = null;
    try {
      k = await s.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    } catch {
      k = null;
    }
    if (k) {
      try {
        return new Uint8Array(await s.decrypt({ name: 'AES-GCM', iv }, k, sealed));
      } catch {
        throw new Error('decrypt failed'); // a wrong key: Web Crypto said so, no need to ask the plain one
      }
    }
  }
  return aesGcmDecryptSync(key, iv, sealed);
}
