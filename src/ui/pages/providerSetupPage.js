import { h } from '../dom.js';
import { createHeading } from '../atoms/heading.js';
import { createHint } from '../atoms/hint.js';
import { t } from '../../i18n/index.js';
import { XtreamClient, normalizeBaseUrl } from '../../services/xtreamClient.js';
import { M3uClient } from '../../services/m3uClient.js';
import { ProviderType, providerType } from '../../services/providerTypes.js';
import { AppError, ErrorCode, toAppError } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { createForm, framedPage } from '../components/formPage.js';
import { createHomeSkeleton } from './homePage.js';
import { loginAndTake, MIN_PASSWORD } from '../../services/sync/index.js';

const ZONE_ID = 'providerSetup';

/** An http(s) address typed by hand ("host/list.m3u" → "http://host/list.m3u"); '' stays ''. */
export function normalizeAddress(input, { required = true } = {}) {
  let value = String(input || '').trim();
  if (!value) {
    if (required) throw new AppError(ErrorCode.INVALID_INPUT, 'Address is empty');
    return '';
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Invalid address', { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError(ErrorCode.INVALID_INPUT, 'Only http and https are supported');
  return url.href;
}

/**
 * Adding (or editing) a provider in two steps: first its kind (Xtream Codes API, or an M3U playlist with an XMLTV guide), then its data.
 * Editing opens on the data of the provider's kind. Used by the first start page and by the dialog of the provider list.
 * `zoneId`: the focus zone of its form; `onCancel()`; `onSaved({ added })` once the provider is checked and saved. Returns
 * { title, body, start(), destroy(), step() }.
 */
export function createProviderSetup(ctx, { editId = null, firstRun = false, completing = false, zoneId, onCancel = null, onSaved }) {
  // `completing`: a provider from a sync account, without its connection data (never synced): only its data to type, no way back.
  const title = createHeading({ level: 1, text: t(completing ? 'sync.providerLoginTitle' : editId ? 'setup.editTitle' : firstRun ? 'setup.welcome' : 'setup.title') }); // the first start welcomes
  const body = h('div', { class: 'setup-step' });
  let form = null;
  let kind = null; // chosen provider type (null: the choice is on screen)
  let editing = null;
  let busy = false;
  let destroyed = false;

  // The confirming button: the first primary one (Cancel, when there is one, sits on its left).
  const confirmIndex = () => Math.max(0, form.actionButtons.findIndex((b) => b.classList.contains('primary')));

  function show(next) {
    if (form) ctx.focus.unregister(zoneId);
    while (body.firstChild) body.removeChild(body.firstChild);
    form = next;
    body.appendChild(form.el);
    ctx.focus.register(form.zone);
    ctx.focus.focus(zoneId, form.fields.length ? 0 : confirmIndex());
  }

  /** Step 1: the kind of provider. */
  function chooseKind() {
    kind = null;
    const actions = [];
    if (onCancel && !firstRun) actions.push({ label: t('setup.cancel'), run: () => onCancel() });
    actions.push({ label: t('setup.type.xtream'), primary: true, run: () => fillIn(ProviderType.XTREAM) }, { label: t('setup.type.m3u'), primary: true, run: () => fillIn(ProviderType.M3U) });
    // First start, in a build with the device sync: everything from an account another TV already set up.
    if (firstRun && ctx.deviceSync) actions.push({ label: t('sync.fromAccount'), primary: true, run: () => fromAccount() });
    const next = createForm({ id: zoneId, focus: ctx.focus, fields: [], actions });
    next.el.insertBefore(createHint({ text: t(firstRun ? 'setup.type.welcomeHint' : 'setup.type.hint'), className: 'setup-hint' }), next.el.firstChild);
    next.el.classList.add('setup-types');
    show(next);
  }

  /** Step 2: the data of the chosen kind. */
  function fillIn(type) {
    kind = type;
    const m3u = type === ProviderType.M3U;
    // Cancel (or Back to the choice) on the left, Confirm on the right.
    const back = editId ? { label: t('setup.cancel'), run: () => onCancel && onCancel() } : { label: t('setup.back'), run: () => chooseKind() };
    const actions = (completing ? [] : [back]).concat([{ label: t('setup.verify'), primary: true, run: () => save() }]);
    const fields = m3u
      ? [{ label: t('setup.name') }, { label: t('setup.playlistUrl'), inputmode: 'url' }, { label: t('setup.epgUrl'), placeholder: t('setup.epgUrlHint'), inputmode: 'url' }]
      : [{ label: t('setup.name') }, { label: t('setup.url') }, { label: t('setup.username') }, { label: t('setup.password'), type: 'password' }];
    show(createForm({ id: zoneId, focus: ctx.focus, fields, actions }));
    if (editing) {
      const values = m3u ? [editing.name, editing.playlistUrl, editing.epgUrl] : [editing.name, editing.baseUrl, editing.username, editing.password];
      form.fields.forEach((field, i) => field.setValue(values[i] || ''));
    }
    if (completing && editing) {
      form.el.insertBefore(createHint({ text: t('sync.providerLoginHint', { name: editing.name }), className: 'setup-hint' }), form.el.firstChild);
      ctx.focus.focus(zoneId, 1); // the first empty field (the name came with the account)
    }
  }

  /** The first start from a sync account: its username and password; the account must exist (another TV made it). */
  function fromAccount() {
    kind = 'account';
    const actions = [{ label: t('setup.back'), run: () => chooseKind() }, { label: t('sync.login'), primary: true, run: () => loginToAccount() }];
    show(createForm({ id: zoneId, focus: ctx.focus, fields: [{ label: t('sync.username') }, { label: t('sync.password'), type: 'password' }], actions }));
    form.el.insertBefore(createHint({ text: t('sync.fromAccountHint'), className: 'setup-hint' }), form.el.firstChild);
  }

  async function loginToAccount() {
    if (busy) return;
    const username = form.fields[0].getValue().trim();
    const password = form.fields[1].getValue();
    if (!username || password.length < MIN_PASSWORD) {
      form.status.textContent = !username ? t('sync.usernameMissing') : t('sync.passwordShort', { min: MIN_PASSWORD });
      return;
    }
    busy = true;
    const button = form.actionButtons[confirmIndex()];
    button.textContent = t('sync.loggingIn');
    form.status.textContent = '';
    let outcome = '';
    try {
      outcome = await loginAndTake(ctx, ctx.deviceSync, { username, password, create: false, confirmReplace: async () => true });
    } catch (err) {
      log.warn('Sync: login failed', err && err.message);
      outcome = 'offline';
    } finally {
      busy = false;
      if (form && !destroyed) form.actionButtons[confirmIndex()].textContent = t('sync.login');
    }
    if (destroyed) return;
    if (outcome === 'replaced') {
      // Everything of the account is here: the app starts again with it (and asks for the parental PIN, never synced).
      form.status.textContent = t('sync.replaced');
      setTimeout(() => window.location.reload(), 800);
      return;
    }
    if (outcome === 'empty') {
      // Logged in, but the account holds nothing yet: a provider is added as usual, and sent to the account.
      ctx.notices.info(t('sync.emptyAccount'), { key: 'sync' });
      chooseKind();
      return;
    }
    form.status.textContent = t({ none: 'sync.noAccount', wrong: 'sync.wrongPassword', offline: 'sync.offline' }[outcome] || 'sync.offline');
  }

  /** What a provider of the chosen kind is saved with, once its server or playlist answered. */
  async function verified() {
    const value = (i) => form.fields[i].getValue().trim();
    if (kind === ProviderType.M3U) {
      const name = value(0);
      const playlistUrl = normalizeAddress(value(1));
      const typedGuide = normalizeAddress(value(2), { required: false });
      if (!name) throw new AppError(ErrorCode.INVALID_INPUT);
      const auth = await new M3uClient({ playlistUrl, epgUrl: typedGuide }).authenticate();
      // No guide typed: the one the playlist names (url-tvg), if any.
      return { type: ProviderType.M3U, name, playlistUrl, epgUrl: typedGuide || auth.playlist.epgUrl || '', baseUrl: playlistUrl, username: '', password: '' };
    }
    const values = { name: value(0), url: value(1), username: value(2), password: value(3) };
    if (!values.name || !values.username || !values.password) throw new AppError(ErrorCode.INVALID_INPUT);
    const baseUrl = normalizeBaseUrl(values.url);
    const auth = await new XtreamClient({ baseUrl, username: values.username, password: values.password }).authenticate();
    return { name: values.name, baseUrl, username: values.username, password: values.password, expiresAt: auth.user.expiresAt || null };
  }

  async function save() {
    if (busy) return;
    busy = true;
    const button = form.actionButtons[confirmIndex()];
    button.textContent = t('setup.verifying');
    form.status.textContent = '';
    try {
      const data = await verified();
      if (editing) {
        const changed = ['baseUrl', 'username', 'password', 'playlistUrl', 'epgUrl'].some((key) => (editing[key] || '') !== (data[key] || ''));
        await ctx.providers.update(editing.id, data);
        // Different server, account or playlist: its catalog may differ, so refresh the active provider.
        if (changed && !completing && (await ctx.providers.getActiveId()) === editing.id) ctx.catalog.start({ force: true });
        ctx.notices.success(t('notice.saved'), { key: 'provider' });
      } else {
        const provider = await ctx.providers.add(data);
        // The first one becomes the active one; another joins the active ones (one catalog of all of them, catalogUnion.js).
        if (ctx.providers.setActive && (await ctx.providers.getActive())) await ctx.providers.setActive(provider.id, true);
        else await ctx.providers.setActiveId(provider.id);
        if (ctx.active && ctx.active.release) ctx.active.release();
        await ctx.refreshAdult();
        ctx.catalog.start({ force: true });
        ctx.notices.success(t('notice.added'), { key: 'provider' });
      }
      if (!destroyed) onSaved({ added: !editing });
    } catch (err) {
      const appError = toAppError(err);
      log.warn('Provider verification failed', appError.code, appError.message);
      if (form) form.status.textContent = t(appError.i18nKey);
    } finally {
      busy = false;
      if (form && !destroyed) form.actionButtons[confirmIndex()].textContent = t('setup.verify');
    }
  }

  return {
    title,
    body,
    start() {
      if (!editId) {
        chooseKind();
        return;
      }
      ctx.providers.get(editId).then((provider) => {
        if (!provider || destroyed) return;
        editing = provider;
        fillIn(providerType(provider));
      });
    },
    destroy() {
      destroyed = true;
      ctx.focus.unregister(zoneId);
    },
    /** Tests: the step on screen ('type' or the provider kind). */
    step: () => kind || 'type',
  };
}

/**
 * The provider form as a page: at the first start (no provider yet), the form at the left in a square box over the Home skeleton, under
 * the bar (logo + placeholders); otherwise in the framed page (a link to the route).
 */
export function createProviderSetupPage(ctx, params = {}) {
  // `complete`: the providers of a sync account still without their connection data, one after the other; then the app starts again.
  const complete = Array.isArray(params.complete) ? params.complete : [];
  const setup = createProviderSetup(ctx, {
    editId: complete[0] || params.providerId || null,
    firstRun: Boolean(params.firstRun),
    completing: complete.length > 0,
    zoneId: ZONE_ID,
    onCancel: () => ctx.router.back(),
    onSaved: () => {
      if (complete.length > 1) ctx.router.reset('providerSetup', { firstRun: true, complete: complete.slice(1) });
      else if (complete.length) window.location.reload(); // every provider has its data: the usual start (catalog, guide...)
      else if (params.firstRun) ctx.router.reset('home', { section: 'home', focusTopbar: true }); // as at every start: Home of the bar
      else ctx.router.reset('providers', { section: 'provider' });
    },
  });
  const el = params.firstRun
    ? h('section', { class: 'page setup first-run' }, h('div', { class: 'setup-backdrop home-skeleton', 'aria-hidden': 'true' }, createHomeSkeleton()), h('div', { class: 'setup-box' }, setup.title, setup.body))
    : framedPage(setup.title, setup.body);
  return {
    el,
    mount: () => setup.start(),
    destroy: () => setup.destroy(),
    step: () => setup.step(),
  };
}

/** Adding (no `providerId`) or editing a provider in a dialog over the provider list. Resolves with true once saved, false when cancelled. */
export function openProviderDialog(ctx, { providerId = null } = {}) {
  return ctx.dialogs.panel({
    className: 'provider-dialog',
    cancelValue: false,
    mount({ body, zoneId, close }) {
      const setup = createProviderSetup(ctx, { editId: providerId, zoneId, onCancel: () => close(false), onSaved: () => close(true) });
      body.appendChild(setup.title);
      body.appendChild(setup.body);
      setup.start();
      return () => setup.destroy();
    },
  });
}
