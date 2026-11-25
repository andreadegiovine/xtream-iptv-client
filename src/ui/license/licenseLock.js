import { h } from '../dom.js';
import { t } from '../../i18n/index.js';
import { Action } from '../../core/input.js';
import { createButton } from '../atoms/button.js';
import { createQrSvg } from '../components/codePrompt.js';

const POLL_MS = 20000; // while on screen the service is asked again: the app unlocks by itself once the payment arrives

/**
 * The screen of a trial build whose trial has ended (or that could never be checked): over everything, with the QR code of the payment
 * page of this device, its id, "Check again" and "Exit". Every key goes to it while it is shown.
 */
export function createLicenseLock({ licensing, exit, onUnlock = () => undefined }) {
  const title = h('h1', { class: 'license-lock-title' });
  const text = h('p', { class: 'license-lock-text' });
  const qrBox = h('div', { class: 'license-lock-qr' });
  const urlEl = h('p', { class: 'license-lock-url' });
  const idEl = h('p', { class: 'license-lock-id' });
  const checkButton = createButton({ label: t('license.checkAgain'), icon: 'refresh', variant: 'primary' });
  const exitButton = createButton({ label: t('license.exit'), icon: 'back' });
  const buttons = [checkButton, exitButton];
  const el = h('div', { class: 'license-lock', style: 'display:none' }, h('div', { class: 'license-lock-box' }, qrBox, h('div', { class: 'license-lock-body' }, title, text, idEl, urlEl, h('div', { class: 'license-lock-actions' }, buttons))));
  let shown = false;
  let focused = 0;
  let timer = null;
  let busy = false;

  function paint() {
    buttons.forEach((b, i) => b.classList.toggle('focused', i === focused));
  }

  async function recheck() {
    if (busy) return;
    busy = true;
    checkButton.classList.add('busy');
    try {
      await licensing.check();
    } finally {
      busy = false;
      checkButton.classList.remove('busy');
    }
  }

  const run = (i) => (i === 0 ? recheck() : exit());
  buttons.forEach((b, i) =>
    b.addEventListener('click', (event) => {
      event.preventDefault();
      focused = i;
      paint();
      run(i);
    }),
  );

  async function show(status) {
    const offline = Boolean(status.offline);
    title.textContent = t(offline ? 'license.offlineTitle' : 'license.expiredTitle');
    text.textContent = t(offline ? 'license.offlineText' : 'license.expiredText');
    idEl.textContent = `${t('license.deviceId')}: ${status.key}`;
    const url = await licensing.payUrl();
    while (qrBox.firstChild) qrBox.removeChild(qrBox.firstChild);
    const qr = offline ? null : createQrSvg(url);
    if (qr) qrBox.appendChild(qr);
    qrBox.style.display = qr ? '' : 'none';
    urlEl.textContent = offline ? '' : url;
    if (!shown) {
      shown = true;
      focused = 0;
      el.style.display = '';
      clearInterval(timer);
      timer = setInterval(() => recheck().catch(() => undefined), POLL_MS);
    }
    paint();
  }

  function hide() {
    if (!shown) return;
    shown = false;
    el.style.display = 'none';
    clearInterval(timer);
    onUnlock();
  }

  return {
    el,
    show,
    hide,
    isShown: () => shown,
    /** Every key while shown: left / right between the buttons, OK presses, Back exits the app. */
    handle(action) {
      if (action === Action.LEFT || action === Action.UP) focused = 0;
      else if (action === Action.RIGHT || action === Action.DOWN) focused = 1;
      else if (action === Action.ENTER) run(focused);
      else if (action === Action.BACK) exit();
      paint();
      return true;
    },
  };
}
