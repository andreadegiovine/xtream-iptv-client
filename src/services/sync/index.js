import { log } from '../../core/logger.js';
import { openAppDb } from '../../db/appDb.js';
import { MAIN_ID, profileDbName } from '../profiles.js';
import { syncAvailable } from './config.js';
import { createGithubTransport } from './transport.js';
import { createSyncEngine } from './engine.js';

export { syncAvailable } from './config.js';
export { MIN_PASSWORD } from './account.js';

/** Anything of this TV that a login would replace: a provider, at least. */
export async function hasLocalData(ctx) {
  return (await ctx.providers.list()).length > 0;
}

/**
 * Logs in to a sync account and takes its data when it has some (asking first when this TV has its own: `confirmReplace`). Resolves
 * with 'wrong', 'none', 'cancelled', 'created', 'empty' (nothing to take: this TV's data is sent) or 'replaced' (the app must start
 * again). Used by the Settings page and by the first start ("Account", `create` false: the account must exist).
 */
export async function loginAndTake(ctx, sync, { username, password, create, confirmReplace }) {
  const result = await sync.engine.login(username, password, { create });
  if (result.status === 'wrong' || result.status === 'none') return result.status;
  if (result.status === 'created' || result.status === 'empty') {
    sync.engine.push().catch((err) => log.warn('Sync: first send failed', err && err.message));
    return result.status;
  }
  if ((await hasLocalData(ctx)) && !(await confirmReplace(result.count))) {
    await sync.engine.cancel();
    return 'cancelled';
  }
  await sync.engine.replace();
  return 'replaced';
}


const PUSH_EVERY_MS = 10 * 60 * 1000;
const FIRST_PUSH_MS = 60 * 1000;
const HIDDEN_GAP_MS = 60 * 1000;

/**
 * The device sync of the app (engine.js): null when the build has no sync (no token). `start()` runs the round of the start (before
 * the app reads its data); `background()` then sends this TV's changes a minute after the start, every 10 minutes and when the app goes
 * to the background (at most once a minute). Errors never stop the app: logged, and shown on the Settings page.
 */
export function createDeviceSync({ db, transport = null }) {
  if (!syncAvailable() && !transport) return null;
  const engine = createSyncEngine({ db, openProfileDb: (pid) => openAppDb(profileDbName(pid)), transport: transport || createGithubTransport() });
  let timer = null;
  let lastHidden = 0;
  const safe = (label, work) =>
    work().catch((err) => {
      log.warn(`Sync: ${label} failed`, err && err.message);
      engine.noteError((err && err.message) || String(err)).catch(() => undefined);
      return null;
    });
  return {
    engine,
    /** The round of the start: resolves with the number of changes written here (0 offline or without an account). */
    async start() {
      if (!(await engine.connected())) return 0;
      const result = await safe('start', () => engine.atStart());
      if (result && (result.applied || result.sent)) log.info(`Sync: ${result.applied} changes taken, ${result.sent} sent`);
      return result ? result.applied : 0;
    },
    background() {
      if (timer) return;
      const push = () =>
        engine.connected().then((on) => {
          if (!on) return null;
          return safe('send', () => engine.push()).then((r) => {
            if (r && r.sent) log.info(`Sync: ${r.sent} changes sent`);
          });
        });
      setTimeout(push, FIRST_PUSH_MS);
      timer = setInterval(push, PUSH_EVERY_MS);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState !== 'hidden' || Date.now() - lastHidden < HIDDEN_GAP_MS) return;
          lastHidden = Date.now();
          push();
        });
      }
    },
    /** The Trakt token of a profile, shared by the TVs of the account (traktService `setRemote`). */
    traktRemote(profileId) {
      const kind = `${profileId || MAIN_ID}|kv:trakt.token`;
      return {
        fetch: () => engine.fetchKind(kind),
        renewed: () => {
          safe('send the Trakt token', () => engine.push());
        },
      };
    },
  };
}
