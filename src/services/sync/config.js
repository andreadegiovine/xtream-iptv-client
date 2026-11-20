/**
 * Where the device sync keeps the accounts: a GitHub repository of its own (see docs/SYNC_REPO.md for how to make a new one when this one
 * is blocked or removed). Change SYNC_REPO (and the SYNC_TOKEN secret of the release workflow) to move to another.
 */
export const SYNC_REPO = 'andreadegiovinebk/xtream-iptv-client-bk';
export const SYNC_BRANCH = 'main';
/** The build stores the token encoded (scripts/sync-token.js): reversed hex of every character XOR 0x5a. */
export function decodeSyncToken(encoded) {
  const hex = String(encoded || '').split('').reverse().join('');
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ 0x5a);
  return out;
}
/**
 * The token of that repository, put in by the build (secret SYNC_TOKEN). Part of the app's code, so the updates of the "_autoupdate"
 * packages bring a new one. Without it the app has no sync (its page is not shown).
 */
export const SYNC_TOKEN = decodeSyncToken(typeof __SYNC_TOKEN__ !== 'undefined' ? __SYNC_TOKEN__ : '');
export const syncAvailable = () => Boolean(SYNC_TOKEN);
