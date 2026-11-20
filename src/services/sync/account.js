import { utf8, fromUtf8, toHex, fromHex, toBase64, fromBase64, concat, randomBytes, sha256, hmac, pbkdf2, aesGcmEncrypt, aesGcmDecrypt } from '../../core/crypto.js';
import { compressText, decompressText } from '../../core/lzw.js';
import { canonical } from './items.js';

/**
 * The keys of a sync account, from its username and password (only on the TV: the server never sees either).
 * - account: SHA-256 of the username (the name of its file on the server);
 * - a master key from PBKDF2-SHA-256 (ITERATIONS, salted with the account), then three keys out of it (HMAC with a label):
 *   `enc` encrypts the items (AES-256-GCM), `mac` names them (an item's id says nothing of what it is), `auth` signs the writes (the
 *   server keeps only its SHA-256).
 */
export const ITERATIONS = 100000;
export const MIN_PASSWORD = 12;
const CHECK = 'xi-sync-check';

export const normalizeUsername = (name) => String(name || '').trim().toLowerCase();

export async function deriveAccount(username, password) {
  const name = normalizeUsername(username);
  const account = toHex(await sha256(utf8(`xi-sync:${name}`)));
  const master = await pbkdf2(utf8(String(password)), utf8(`xi-sync:${account}`), ITERATIONS, 32);
  const sub = async (label) => toHex(await hmac(master, utf8(label)));
  return { account, enc: await sub('enc'), mac: await sub('mac'), auth: await sub('auth') };
}

/** The id of a kind on the server: HMAC with the account's `mac` key (32 hex characters). */
export async function itemId(keys, kind) {
  return toHex(await hmac(fromHex(keys.mac), utf8(kind))).slice(0, 32);
}

/** A value sealed for the server: base64 of IV + AES-GCM. The text is compressed first when that makes it shorter. */
export async function seal(keys, value) {
  const text = canonical(value);
  const packed = text.length > 120 ? compressText(text) : '';
  const plain = packed && packed.length < text.length ? `L${packed}` : `J${text}`;
  const iv = randomBytes(12);
  return toBase64(concat(iv, await aesGcmEncrypt(fromHex(keys.enc), iv, utf8(plain))));
}

/** Opens a sealed value; throws when it was not sealed with these keys. */
export async function open(keys, sealed) {
  const bytes = fromBase64(sealed);
  const plain = fromUtf8(await aesGcmDecrypt(fromHex(keys.enc), bytes.subarray(0, 12), bytes.subarray(12)));
  return JSON.parse(plain[0] === 'L' ? decompressText(plain.slice(1)) : plain.slice(1));
}

/** The proof stored with the account: only the right password opens it. */
export const sealCheck = (keys) => seal(keys, CHECK);
export async function checkOpens(keys, sealed) {
  try {
    return (await open(keys, sealed)) === CHECK;
  } catch {
    return false;
  }
}
