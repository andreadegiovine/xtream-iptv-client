import { h } from '../dom.js';
import { t } from '../../i18n/index.js';
import { focusRowAt, savedRowFocus } from '../rowFocus.js';
import { createCarousel } from './carousel.js';

const ORDER = ['collection', 'movie', 'series', 'live', 'programme', 'person', 'company'];
const LABEL = { collection: 'nav.collections', movie: 'nav.movies', series: 'nav.series', live: 'nav.live', programme: 'search.programmes', person: 'favorites.people', company: 'favorites.companies' };
// Cards that are not titles: no watch state, no TMDB metadata of a title.
const NOT_TITLES = ['collection', 'programme', 'person', 'company'];

/**
 * A favourite category or genre shown as a card: `{ type, key, name, filterKind: 'category' | 'genre', filterId }`.
 * The card carries an icon instead of a poster and the kind ("Category", "Genre") as its subtitle.
 */
export const isFilterEntry = (entry) => Boolean(entry && entry.filterKind);
const isGenreFilter = (entry) => entry.filterKind === 'genre' || entry.filterKind === 'epgGenre';
export const filterCardMeta = (entry) => ({ placeholder: isGenreFilter(entry) ? 'genres' : 'categories', subtitle: t(isGenreFilter(entry) ? 'favorites.genre' : 'favorites.category') });

/** Splits entries by type (collections first), keeping the order and at most `limit` per type. */
export function groupByType(entries, limit = 500) {
  const first = (entry) => (entry.isNetwork ? 0 : 1); // networks come ahead of the channels and groups
  return ORDER.map((type) => ({ type, entries: entries.filter((entry) => entry.type === type).sort((a, b) => first(a) - first(b)).slice(0, limit) })).filter((group) => group.entries.length);
}

/**
 * One carousel per media type (movies, series, channels), stacked vertically with linked focus zones.
 * Used by Favorites, Suggestions and the search results. `linkFromField`: Down from the search field reaches the first row (the
 * results); Up never leaves the rows (Back goes to the field, or to the top bar). A `collection` entry carries `collectionId` and a `subtitle` (its item count).
 */
export function createTypedRows(ctx, { prefix, onOpen, limit = 500, hideFavorite = false, linkFromField = false, upZone = null }) { // upZone: where Up from the first row goes (the top bar); onOpen(entry): titles and favourite filters (see isFilterEntry)
  const el = h('div', { class: 'typed-rows' });
  let carousels = [];

  function clear() {
    carousels.forEach((c) => ctx.focus.unregister(c.zone.id));
    carousels = [];
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  return {
    el,
    set(entries) {
      clear();
      carousels = groupByType(entries, limit).map((group, index) => {
        const carousel = createCarousel({
          id: `${prefix}-${group.type}`,
          title: t(LABEL[group.type]),
          items: group.entries.map((entry) => {
            if (entry.type === 'collection') return { entry, type: 'movie', meta: { placeholder: 'folder', subtitle: entry.subtitle } }; // cards of a collection look like titles
            if (entry.type === 'programme') return { entry, type: 'live', meta: { subtitle: entry.subtitle } }; // a guide programme: the channel's picture, its hours
            if (entry.type === 'person' || entry.type === 'company') return { entry, type: 'cast', meta: { placeholder: entry.type === 'company' ? 'provider' : 'user', subtitle: entry.subtitle || '' } }; // a favourite person / company: as the cast cards, its roles or counts under it
            if (isFilterEntry(entry)) return { entry, type: group.type, meta: filterCardMeta(entry) };
            return entry.roleText ? { entry, type: group.type, meta: { subtitle: entry.roleText } } : { entry, type: group.type }; // the person page: the role(s) under the card
          }),
          onOpen: (item) => onOpen(item.entry),
          revealTop: index === 0,
          // Cards made while scrolling get the same badges and metadata as the first ones.
          onAdded: (list, made) => {
            if (ctx.enrich && NOT_TITLES.indexOf(group.type) < 0) ctx.enrich(list.map((item) => item.entry), made, group.type, true, { hideFavorite });
          },
        });
        carousel.type = group.type;
        return carousel;
      });
      carousels.forEach((carousel, i) => {
        el.appendChild(carousel.el);
        ctx.focus.register(carousel.zone);
        if (i > 0) ctx.focus.link(carousel.zone.id, 'up', carousels[i - 1].zone.id);
        else if (upZone) ctx.focus.link(carousel.zone.id, 'up', upZone);
        if (i < carousels.length - 1) ctx.focus.link(carousel.zone.id, 'down', carousels[i + 1].zone.id);
        if (ctx.enrich && NOT_TITLES.indexOf(carousel.type) < 0) ctx.enrich(carousel.items.map((item) => item.entry), carousel.cards, carousel.type, i > 0, { hideFavorite });
      });
      if (linkFromField && ctx.linkSearchDown && carousels.length) ctx.linkSearchDown(carousels[0].zone.id);
    },
    count: () => carousels.length,
    /** The focus zone of the first row (null without rows). */
    firstZoneId: () => (carousels.length ? carousels[0].zone.id : null),
    focusFirst: () => carousels.length > 0 && ctx.focus.focus(carousels[0].zone.id, 0),
    /** The first row, on the card it was left from (Down from the top bar). */
    focusTop: () => carousels.length > 0 && ctx.focus.focus(carousels[0].zone.id),
    /** The card the focus is on (to land on it again when the page comes back), or null. */
    savedFocus: () => savedRowFocus(ctx.focus, carousels.map((c) => c.zone.id)),
    /** Focuses a saved card (its row reads its cards up to it), or the first card when its row is gone. */
    focusSaved(saved) {
      const row = saved && carousels.find((c) => c.zone.id === saved.id);
      if (row) focusRowAt(ctx.focus, row, saved.index);
      else if (carousels.length) ctx.focus.focus(carousels[0].zone.id, 0);
    },
    destroy: clear,
  };
}
