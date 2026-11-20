import { log } from '../core/logger.js';
import { t } from '../i18n/index.js';
import { APP_VERSION } from '../core/env.js';
import { checkForUpdate, installUpdate, runningVersions } from '../services/updates.js';
import { slotsApi, installToSlot } from '../services/slotUpdates.js';
import { buildLogLink } from '../services/logShare.js';
import { createQrSvg } from '../ui/components/codePrompt.js';

/**
 * The screen of a start that failed, whatever the reason: what went wrong, the log (and a QR code to read it on a phone), "Check for
 * updates" (a newer version, once confirmed, is downloaded and started: a fix published later solves a start that fails) and "Restart".
 * Plain elements with their own styles: nothing else of the app may be working. Up / Down scroll the log, Left / Right move between the
 * buttons, OK presses one.
 */
export function showStartupFailure(err, { doc = document, canUpdate = false } = {}) {
  const content = doc.getElementById('content') || doc.body;
  const topbar = doc.getElementById('topbar');
  if (topbar) topbar.textContent = '';
  content.textContent = '';
  const el = (tag, style, text) => {
    const node = doc.createElement(tag);
    if (style) node.setAttribute('style', style);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const versions = runningVersions();
  const version = versions.bundle || APP_VERSION;
  const detail = `${(err && err.name) || 'Error'}: ${(err && err.message) || err}${err && err.cause ? ` — ${err.cause.name || ''} ${err.cause.message || err.cause}` : ''}`;

  const screen = el('div', 'position:fixed;left:0;top:0;width:1920px;height:1080px;box-sizing:border-box;padding:64px 96px;background:#0c0c12;color:#f2f2f5;font-family:Inter,Arial,sans-serif;z-index:10000;overflow:hidden');
  screen.className = 'startup-failure';
  const title = el('div', 'font-size:44px;font-weight:700;margin-bottom:12px', t('startup.title'));
  const text = el('div', 'font-size:26px;color:#b8b8c4;margin-bottom:8px', t('startup.text'));
  const error = el('div', 'font-size:24px;color:#ff8a80;margin-bottom:8px;word-break:break-word', detail);
  const meta = el('div', 'font-size:20px;color:#8a8a99;margin-bottom:24px', `Xtream IPTV ${version} · ${t('startup.package', { version: versions.shell || APP_VERSION })}`);
  const row = el('div', 'display:flex;height:620px;margin-bottom:28px');
  const logBox = el('pre', 'flex:1 1 auto;margin:0 32px 0 0;padding:20px;background:#16161f;border-radius:12px;font-size:18px;line-height:1.45;color:#d6d6de;overflow:auto;white-space:pre-wrap;word-break:break-word');
  const lines = log.entries().map((e) => `${new Date(e.ts).toISOString().slice(11, 19)} ${e.level} ${e.message}`);
  logBox.textContent = lines.join('\n') || '—';
  const side = el('div', 'flex:0 0 360px;text-align:center;font-size:18px;color:#b8b8c4');
  try {
    const { url } = buildLogLink(log.entries(), { header: `Xtream IPTV ${version} · ${navigator.userAgent}` });
    const qr = createQrSvg(url, { correction: 'L' });
    if (qr) {
      const box = el('div', 'background:#fff;padding:12px;border-radius:12px;margin-bottom:12px');
      box.append(qr);
      const svg = box.querySelector('svg');
      if (svg) svg.setAttribute('style', 'width:100%;height:auto;display:block');
      side.append(box, el('div', '', t('startup.qr')));
    }
  } catch {
    /* no QR code */
  }
  row.append(logBox, side);
  const status = el('div', 'font-size:26px;min-height:36px;margin-bottom:20px;color:#f2f2f5', '');
  const buttons = el('div', 'display:flex');
  screen.append(title, text, error, meta, row, status, buttons);
  content.append(screen);

  const BUTTON = 'font:inherit;font-size:26px;font-weight:600;padding:16px 36px;margin-right:24px;border-radius:10px;border:3px solid transparent;cursor:pointer;';
  let focused = 0;
  let list = [];
  const paint = () =>
    list.forEach((b, i) => {
      b.setAttribute('style', `${BUTTON}${i === focused ? 'background:#f2f2f5;color:#0c0c12;border-color:#f2f2f5' : 'background:#262633;color:#f2f2f5'}`);
      if (i === focused && b.focus) b.focus();
    });
  let busy = false;
  const setButtons = (items) => {
    buttons.textContent = '';
    list = items.map(({ label, action }) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (busy) return;
        busy = true;
        Promise.resolve()
          .then(action)
          .catch((e) => log.warn('Startup screen action failed', e && e.message))
          .then(() => {
            busy = false;
          });
      });
      b.addEventListener('mouseenter', () => {
        focused = list.indexOf(b);
        paint();
      });
      buttons.append(b);
      return b;
    });
    focused = 0;
    paint();
  };

  const restart = () => window.location.reload();
  async function check() {
    status.textContent = t('update.checking');
    let update = null;
    try {
      update = await checkForUpdate({ platform: __UPDATE_CHANNEL__, running: version, shell: versions.shell || APP_VERSION, timeoutMs: 20000 });
    } catch (e) {
      log.warn('Update check failed', e && e.message);
      status.textContent = t('update.failed');
      return;
    }
    if (!update) {
      status.textContent = t('update.latest');
      return;
    }
    if (update.needsPackage) {
      status.textContent = t('update.needsPackage', { version: update.version });
      return;
    }
    status.textContent = t('startup.available', { version: update.version });
    setButtons([
      { label: t('startup.install'), action: () => install(update) },
      { label: t('startup.cancel'), action: () => setButtons(mainButtons()) },
    ]);
  }
  async function install(update) {
    status.textContent = t('startup.downloading', { done: 0, total: '…' });
    try {
      if (slotsApi()) await installToSlot(update, { onProgress: (done, total) => (status.textContent = t('startup.downloading', { done, total })) });
      else await installUpdate(update);
    } catch (e) {
      log.warn('Update failed', e && e.message);
      status.textContent = t('startup.installFailed', { error: (e && e.message) || '' });
      setButtons(mainButtons());
      return;
    }
    log.info(`Update ${update.version} downloaded from the failed start screen: starting it`);
    restart();
  }
  const mainButtons = () => [...(canUpdate ? [{ label: t('update.check'), action: check }] : []), { label: t('startup.restart'), action: restart }];
  setButtons(mainButtons());

  // The keys: only this screen answers (whatever of the app was already listening).
  const onKey = (event) => {
    const key = event.keyCode;
    if (key === 37 || key === 39) {
      focused = Math.max(0, Math.min(list.length - 1, focused + (key === 39 ? 1 : -1)));
      paint();
    } else if (key === 38 || key === 40) logBox.scrollTop += key === 40 ? 120 : -120;
    else if (key === 13) {
      if (list[focused]) list[focused].click();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  return { screen, check, close: () => window.removeEventListener('keydown', onKey, true) };
}
