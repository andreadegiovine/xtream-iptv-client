import { h } from '../dom.js';
import { t } from '../../i18n/index.js';
import { createHint } from '../atoms/hint.js';
import { createPanel } from '../atoms/panel.js';
import { createTableRow } from '../atoms/tableRow.js';
import { createListRow } from '../atoms/listRow.js';
import { createQrSvg } from '../components/codePrompt.js';
import { countdownParts } from '../../services/licensing.js';

/** "12 days and 4 hours left" (under a day: hours and minutes), "Ended", or "Not checked yet". */
export function countdownText(status) {
  if (!status || status.state === 'pending') return t('license.pending');
  if (status.state === 'expired') return t('license.expired');
  const { days, hours, minutes } = countdownParts(status.left || 0);
  return days > 0 ? t('license.leftDays', { days, hours }) : t('license.leftHours', { hours, minutes });
}

/**
 * Settings › "Activation" (trial builds, while the device is not activated): the trial's countdown, the id of the device, the QR code of
 * its payment page and "Check activation". Returns { id, icon, label, blocks, rows, ready } as the other sub-pages.
 */
export function createActivationSubpage(ctx) {
  const licensing = ctx.licensing;
  const panelHost = h('div');
  const qrBox = h('div', { class: 'activation-qr' });
  const urlEl = h('p', { class: 'activation-url' });
  const checkRow = {
    el: createListRow({ label: t('license.check') }).el,
    refresh: async () => undefined,
    activate: async () => {
      ctx.notices.info(t('license.checking'), { key: 'license' });
      const status = await licensing.check();
      if (status.state === 'active') {
        ctx.notices.success(t('license.activated'), { key: 'license' });
        ctx.router.reload(); // the page goes from Settings
        return;
      }
      ctx.notices.info(t('license.notYet'), { key: 'license' });
      await render(status);
    },
  };

  async function render(status) {
    const st = status || (await licensing.refresh());
    while (panelHost.firstChild) panelHost.removeChild(panelHost.firstChild);
    const rows = [createTableRow({ name: t('license.deviceId'), statusText: st.key }).el, createTableRow({ name: t('license.trial'), statusText: countdownText(st) }).el];
    panelHost.appendChild(createPanel({ title: t('license.title'), rows }).el);
    const url = await licensing.payUrl();
    while (qrBox.firstChild) qrBox.removeChild(qrBox.firstChild);
    const qr = createQrSvg(url);
    if (qr) qrBox.appendChild(qr);
    urlEl.textContent = url;
  }

  return {
    id: 'activation',
    icon: 'lock',
    label: t('license.title'),
    blocks: [createHint({ text: t('license.hint'), className: 'activation-hint' }), panelHost, h('div', { class: 'activation-pay' }, qrBox, h('div', { class: 'activation-pay-text' }, h('p', { text: t('license.scan') }), urlEl)), h('div', { class: 'list' }, checkRow.el)],
    rows: [checkRow],
    ready: render().catch(() => undefined),
  };
}
