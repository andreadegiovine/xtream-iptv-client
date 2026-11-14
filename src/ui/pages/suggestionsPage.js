import { h } from '../dom.js';
import { focusOnBar } from '../rowFocus.js';
import { createHint } from '../atoms/hint.js';
import { t } from '../../i18n/index.js';
import { createTypedRows } from '../components/typedRows.js';
import { log } from '../../core/logger.js';
import { TOPBAR_ZONE } from '../components/topbar.js';

/** Suggested titles available in the provider catalog (TMDB recommendations from the watch history). */
export function createSuggestionsPage(ctx) {
  const status = createHint({ text: t('suggestions.loading'), className: 'search-status' });
  // Up from the first row: the top bar; Down from the bar: back to that row, on the card it was left from.
  const rows = createTypedRows(ctx, { prefix: 'suggestions', upZone: TOPBAR_ZONE, onOpen: (entry) => ctx.openEntry(entry, { section: 'suggestions' }) });
  let destroyed = false;
  let restored = null; // the card to land on again (a title opened from here, then Back)
  let onBar = false;

  async function load() {
    const result = await ctx.suggestions.build({ limit: 500 });
    if (destroyed) return;
    rows.set(result.entries);
    if (!result.entries.length) status.textContent = t('common.empty');
    else status.textContent = result.source === 'history' ? t('suggestions.fromHistory') : t('suggestions.trending');
    if (onBar) onBar = false;
    else if (restored) rows.focusSaved(restored);
    else rows.focusFirst();
    restored = null;
  }

  return {
    el: h('section', { class: 'page suggestions' }, status, rows.el),
    mount() {
      load().catch((err) => {
        log.warn('Suggestions failed', err && err.message);
        status.textContent = t('error.NETWORK');
      });
    },
    destroy() {
      destroyed = true;
      rows.destroy();
    },
    enterFromBar: () => rows.focusTop(),
    saveState: () => ({ focus: rows.savedFocus(), onBar: focusOnBar(ctx.focus) }),
    restoreState(state) {
      restored = (state && state.focus) || null;
      onBar = Boolean(state && state.onBar); // left from the bar (the search): it keeps the focus
    },
  };
}
