/*
 * The device sync token as the build stores it (src/services/sync/config.js decodes it): every character XOR 0x5a, as hex, reversed.
 * Not a protection (the token can only start the sync workflow and read its repository): it keeps the token's own pattern out of the
 * builds published on the public gh-pages branch, at the owner's choice (docs/SYNC_REPO.md).
 */
function encodeSyncToken(token) {
  return String(token || '')
    .split('')
    .map((ch) => `0${(ch.charCodeAt(0) ^ 0x5a).toString(16)}`.slice(-2))
    .join('')
    .split('')
    .reverse()
    .join('');
}

module.exports = { encodeSyncToken };
