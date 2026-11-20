/**
 * Where the device sync keeps the accounts: a GitHub repository of its own (see docs/SYNC_REPO.md for how to make a new one when this one
 * is blocked or removed). Change SYNC_REPO (and the SYNC_TOKEN secret of the release workflow) to move to another.
 */
export const SYNC_REPO = 'andreadegiovinebk/xtream-iptv-client-bk';
export const SYNC_BRANCH = 'main';
/** The token of that repository, put in by the build (secret SYNC_TOKEN); without it the app has no sync (its page is not shown). */
export const SYNC_TOKEN = typeof __SYNC_TOKEN__ !== 'undefined' ? __SYNC_TOKEN__ : '';
export const syncAvailable = () => Boolean(SYNC_TOKEN);
