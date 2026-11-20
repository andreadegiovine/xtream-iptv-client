import { h } from '../dom.js';
import { t, i18n } from '../../i18n/index.js';
import { createListRow } from '../atoms/listRow.js';
import { createField } from '../atoms/field.js';
import { createHint } from '../atoms/hint.js';
import { createPanel } from '../atoms/panel.js';
import { createTableRow, createRowButtons } from '../atoms/tableRow.js';
import { createButton } from '../atoms/button.js';
import { icon } from '../icons.js';
import { formatDateTime, formatNumber } from '../../core/format.js';
import { log } from '../../core/logger.js';
import { resetApp } from '../../services/resetApp.js';
import { MIN_PASSWORD, loginAndTake } from '../../services/sync/index.js';

const SECTIONS = ['providers', 'profiles', 'settings', 'trakt', 'watch', 'favorites', 'collections', 'pins', 'other'];

/**
 * Settings › "Sync": the account's fields and "Log in" the first time; then one table: the account (with the icon buttons "Remove" — this
 * TV leaves the sync and the app is reset — and "Sync now" at its right, as in the other tables), the password (hidden, with "Show
 * password" at its right), the last sync, the state, and the counts of each kind of data on this TV and in sync with the account.
 * Returns { id, icon, label, blocks, rows } as the other sub-pages.
 */
export function createSyncSubpage(ctx) {
  const sync = ctx.deviceSync;
  const list = h('div', { class: 'list' });
  const fields = h('div', { class: 'fields' });
  const panelHost = h('div');
  const rows = [];
  let username = '';
  let password = '';
  let showPassword = false;

  const userField = createField({ label: t('sync.username'), onSubmit: (v) => { username = v.trim(); }, onCancel: () => userField.setValue(username) });
  const passField = createField({ label: t('sync.password'), type: 'password', onSubmit: (v) => { password = v; }, onCancel: () => passField.setValue(password) });
  const fieldRow = (field) => ({ el: field.el, root: field.root, refresh: async () => undefined, activate: async () => field.focus() });

  const confirmReplace = (count) =>
    ctx.dialogs.confirm({ title: t('sync.replaceTitle'), message: t('sync.replaceMessage', { count: formatNumber(count, i18n.getLocale()) }), confirmLabel: t('sync.replace'), cancelLabel: t('setup.cancel') });

  async function login() {
    username = userField.getValue().trim() || username;
    password = passField.getValue() || password;
    if (!username) return ctx.notices.error(t('sync.usernameMissing'), { key: 'sync' });
    if (password.length < MIN_PASSWORD) return ctx.notices.error(t('sync.passwordShort', { min: MIN_PASSWORD }), { key: 'sync' });
    ctx.notices.info(t('sync.loggingIn'), { key: 'sync' });
    let outcome = '';
    try {
      outcome = await loginAndTake(ctx, sync, { username, password, create: true, confirmReplace });
    } catch (err) {
      log.warn('Sync: login failed', err && err.message);
      return ctx.notices.error(t('sync.offline'), { key: 'sync' });
    }
    if (outcome === 'wrong') return ctx.notices.error(t('sync.wrongPassword'), { key: 'sync' });
    if (outcome === 'cancelled') return ctx.notices.info(t('sync.cancelled'), { key: 'sync' });
    if (outcome === 'replaced') {
      ctx.notices.success(t('sync.replaced'), { key: 'sync' });
      setTimeout(() => window.location.reload(), 800);
      return undefined;
    }
    ctx.notices.success(t(outcome === 'created' ? 'sync.created' : 'sync.connected'), { key: 'sync' });
    ctx.router.reload();
    return undefined;
  }

  async function syncNow() {
    ctx.notices.info(t('sync.syncing'), { key: 'sync' });
    try {
      const { applied } = await sync.engine.now();
      if (applied) {
        ctx.notices.success(t('sync.applied', { count: applied }), { key: 'sync' });
        setTimeout(() => window.location.reload(), 800); // the app starts again with what came
        return;
      }
      ctx.notices.success(t('sync.done'), { key: 'sync' });
    } catch (err) {
      log.warn('Sync now failed', err && err.message);
      await sync.engine.noteError((err && err.message) || String(err));
      ctx.notices.error(t('sync.offline'), { key: 'sync' });
    }
    await render();
  }

  async function remove() {
    const ok = await ctx.dialogs.confirm({ title: t('sync.removeTitle'), message: t('sync.removeMessage'), confirmLabel: t('sync.remove'), cancelLabel: t('setup.cancel') });
    if (!ok) return;
    await sync.engine.disconnect();
    await resetApp({ db: ctx.db, providers: ctx.providers, stopWork: () => { ctx.genres.stop(); ctx.catalog.cancel(); }, storages: [localStorage, sessionStorage] });
    window.location.reload();
  }

  // The buttons of the table (the same elements at every render: they are the focusable rows). Up / Down: "Sync now" and "Show
  // password"; Left from "Sync now": "Remove" (secondary 'left', as the other tables of Settings).
  const syncButton = createButton({ label: t('sync.now'), icon: 'refresh', variant: 'primary', iconOnly: true, className: 'panel-button' });
  const removeButton = createButton({ label: t('sync.remove'), icon: 'remove', variant: 'danger', iconOnly: true, className: 'panel-button' });
  const showButton = createButton({ label: t('sync.showPassword'), icon: 'seen', iconOnly: true, className: 'panel-button' });
  const syncRow = { el: syncButton, refresh: async () => undefined, activate: syncNow };
  const removeRow = { secondary: 'left', el: removeButton, refresh: async () => undefined, activate: remove };
  const showRow = { el: showButton, refresh: async () => undefined, activate: async () => togglePassword() };
  const loginRow = { el: createListRow({ label: t('sync.login') }).el, refresh: async () => undefined, activate: login };
  let passwordCell = null;
  let shownPassword = '';
  const hiddenText = '••••••••••••';
  function togglePassword() {
    showPassword = !showPassword;
    if (passwordCell) passwordCell.textContent = showPassword ? shownPassword : hiddenText;
    // The icon and the name of the button follow (the eye crossed out while the password is shown).
    const glyph = showButton.querySelector('svg');
    if (glyph) glyph.replaceWith(icon(showPassword ? 'hidden' : 'seen'));
    showButton.setAttribute('aria-label', t(showPassword ? 'sync.hidePassword' : 'sync.showPassword'));
  }

  async function render() {
    const info = await sync.engine.info();
    while (panelHost.firstChild) panelHost.removeChild(panelHost.firstChild);
    while (list.firstChild) list.removeChild(list.firstChild);
    while (fields.firstChild) fields.removeChild(fields.firstChild);
    if (!info) {
      fields.append(userField.root, passField.root);
      list.append(loginRow.el);
      rows.splice(0, rows.length, fieldRow(userField), fieldRow(passField), loginRow);
      return;
    }
    const line = (name, value, buttons = null) => createTableRow({ name, statusText: value, buttons });
    const counts = await sync.engine.counts().catch(() => null);
    const when = info.lastSync ? formatDateTime(info.lastSync, i18n.getLocale()) : t('sync.never');
    const state = info.locked ? t('sync.locked') : info.lastError ? t('sync.error', { error: info.lastError }) : counts && counts.pending ? t('sync.pending', { count: counts.pending }) : t('sync.ok');
    shownPassword = info.password;
    const passwordLine = line(t('sync.password'), showPassword ? info.password : hiddenText, createRowButtons(showButton));
    passwordCell = passwordLine.status;
    const tableRows = [line(t('sync.account'), info.username, createRowButtons(removeButton, syncButton)).el, passwordLine.el, line(t('sync.lastSync'), when).el, line(t('sync.state'), state).el].concat(
      SECTIONS.filter((s) => counts && ((counts.here[s] || 0) || (counts.agreed[s] || 0))).map(
        (s) => line(t(`sync.section.${s}`), t('sync.counts', { here: formatNumber(counts.here[s] || 0, i18n.getLocale()), synced: formatNumber(counts.agreed[s] || 0, i18n.getLocale()) })).el,
      ),
    );
    panelHost.append(createPanel({ title: t('sync.title'), rows: tableRows }).el);
    rows.splice(0, rows.length, syncRow, removeRow, showRow);
  }

  return {
    id: 'sync',
    icon: 'refresh',
    label: t('sync.title'),
    blocks: [createHint({ text: t('sync.hint'), className: 'sync-hint' }), panelHost, fields, list],
    rows,
    /** Fills the sub-page (the rows change once logged in): call before the rows are used. */
    ready: render().catch((err) => log.warn('Sync page failed', err && err.message)),
  };
}
