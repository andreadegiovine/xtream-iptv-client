import { h } from '../dom.js';
import { t, i18n } from '../../i18n/index.js';
import { createHeading } from '../atoms/heading.js';
import { createChip } from '../atoms/chip.js';
import { cssUrl } from '../cssUrl.js';
import { createIconButton, setIconButtonActive, setIconButtonLabel } from '../atoms/iconButton.js';
import { createPlaceholder } from '../atoms/placeholder.js';
import { createMetaSeparator, createMetaText, createMetaTmdb } from '../atoms/metaParts.js';
import { FocusZone } from '../focus/FocusManager.js';
import { createCarouselPage } from './templates.js';
import { getEntry } from '../../services/catalogQuery.js';
import { titlesByName } from '../../services/peopleIndex.js';

const ZONE = 'personHeader';
const TMDB = {}; // the TMDB logo among the parts of the info line

/** "1968-09-25" → "25 September 1968" in the language of the app ('' when not a date). */
export function longDate(text, locale = 'en-US') {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ''));
  if (!m) return '';
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Whole years between two "YYYY-MM-DD" dates (the second: today when empty). */
export function yearsBetween(from, to = '', today = new Date()) {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(from || ''));
  if (!a) return null;
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(to || ''));
  const [y, mo, d] = b ? [Number(b[1]), Number(b[2]), Number(b[3])] : [today.getFullYear(), today.getMonth() + 1, today.getDate()];
  let years = y - Number(a[1]);
  if (mo < Number(a[2]) || (mo === Number(a[2]) && d < Number(a[3]))) years -= 1;
  return years >= 0 ? years : null;
}

/**
 * The facts under the name: a person's birth (date, age, place) and death; a company's headquarters, country, parent company, website.
 * Only what is known.
 */
export function personFacts(info, locale = 'en-US') {
  if (!info) return [];
  if (info.kind === 'company') {
    return [
      info.headquarters ? t('person.headquarters', { place: info.headquarters }) : '',
      info.country ? t('person.country', { country: info.country }) : '',
      info.parent ? t('person.parent', { name: info.parent }) : '',
      info.homepage ? info.homepage.replace(/^https?:\/\//, '').replace(/\/$/, '') : '',
    ].filter(Boolean);
  }
  const out = [];
  if (info.birthday) {
    const age = info.deathday ? null : yearsBetween(info.birthday);
    const born = t('person.born', { date: longDate(info.birthday, locale) }) + (age !== null ? ` (${t('person.age', { years: age })})` : '') + (info.placeOfBirth ? ` · ${info.placeOfBirth}` : '');
    out.push(born);
  } else if (info.placeOfBirth) out.push(info.placeOfBirth);
  if (info.deathday) {
    const age = yearsBetween(info.birthday, info.deathday);
    out.push(t('person.died', { date: longDate(info.deathday, locale) }) + (age !== null ? ` (${t('person.age', { years: age })})` : ''));
  }
  return out;
}

/** "Acting" → the label of the department ("Recitazione"); unknown ones as TMDB writes them. */
const DEPARTMENTS = { Acting: 'person.acting', Directing: 'person.directing', Writing: 'person.writing', Production: 'person.production', Sound: 'person.sound', Camera: 'person.camera', Editing: 'person.editing', Creator: 'person.creator' };
const departmentLabel = (department) => (DEPARTMENTS[department] ? t(DEPARTMENTS[department]) : department || '');

/**
 * The roles of a person for the info line: what TMDB says they are known for first, then the other departments of their credits, the
 * most frequent first (at most four); without TMDB the roles the provider gives them ("Cast", "Director").
 */
export function personRoles(info, entries = []) {
  if (info && info.credits) {
    const counts = new Map();
    info.credits.forEach((c) => c.department && counts.set(c.department, (counts.get(c.department) || 0) + 1));
    const order = Array.from(counts.keys()).sort((a, b) => counts.get(b) - counts.get(a));
    if (info.department) order.sort((a, b) => (a === info.department ? -1 : b === info.department ? 1 : 0));
    else if (!order.length) return [];
    return (order.length ? order : [info.department]).slice(0, 4).map(departmentLabel);
  }
  const out = [];
  entries.forEach((e) => String(e.roleText || '').split(', ').forEach((role) => role && out.indexOf(role) < 0 && out.push(role)));
  return out.slice(0, 4);
}

/**
 * The titles of the catalog a person (or company) is in, newest first as the provider lists them, each with its role(s) ("Mike Lowrey",
 * "Director"): the TMDB credits (`info.credits`, by TMDB id) and, for a person, the titles whose provider details name them (by name).
 * `getEntryOf(key)`: a catalog entry or null (a kids profile does not see what it must not).
 */
export async function personTitles({ info, name, kind, getEntryOf, byName = async () => [] }) {
  const roles = new Map(); // entry key → [role]
  const add = (key, role) => {
    if (!roles.has(key)) roles.set(key, []);
    const list = roles.get(key);
    if (role && list.indexOf(role) < 0) list.push(role);
  };
  ((info && info.credits) || []).forEach((c) => add(`${c.type}:t${c.tmdbId}`, c.role));
  if (kind === 'person' && name) {
    (await byName('cast', name)).forEach((row) => add(row.key, roles.has(row.key) ? '' : t('person.cast'))); // the character is known only to TMDB
    (await byName('director', name)).forEach((row) => add(row.key, t('person.director')));
  }
  const found = [];
  for (const [key, list] of roles) {
    const entry = await getEntryOf(key);
    if (entry && (entry.type === 'movie' || entry.type === 'series')) found.push({ ...entry, roleText: list.join(', ') });
  }
  return found.sort((a, b) => (b.added || 0) - (a.added || 0));
}

/**
 * A person or a production company (the "person" template): at the top the picture, the name, what they do, the facts and the biography
 * (TMDB; without TMDB only the name) laid out as the top of a title page, below the carousels of the films and series of the catalog they are in, with their role under each
 * card (the Favorites template). `params`: { kind: 'person' | 'company', id (TMDB id or null), name }.
 */
export function createPersonPage(ctx, params = {}) {
  const kind = params.kind === 'company' ? 'company' : 'person';
  // The top of the page is the title page's (same classes and style): the picture on the left (sticky), on the right the name, what they
  // do, the facts and the biography in the box of the plot, cut to a few lines with "Show more" / "Show less".
  const poster = h('div', { class: kind === 'company' ? 'detail-poster square company-logo' : 'detail-poster' }, createPlaceholder({ icon: kind === 'company' ? 'provider' : 'user' }));
  const nameEl = createHeading({ level: 1, className: 'detail-title', text: params.name || '' });
  const metaEl = h('p', { class: 'detail-meta' });
  const factsEl = h('div', { class: 'person-facts' });
  const bioEl = h('p', { class: 'detail-plot person-bio clamped' });
  const moreChip = createChip({ text: t('person.showMore'), link: true });
  const moreRow = h('div', { class: 'detail-categories person-more' }, moreChip);
  moreRow.style.display = 'none';
  // The heart, right under the info line as on a title page: the person (or company) in the favourites (the Favorites page lists them).
  const heart = createIconButton({ icon: 'heart', label: t('detail.favorite') });
  const actionsEl = h('div', { class: 'detail-actions' }, heart);
  let favorite = false;
  let favoriteTarget = { kind, id: params.id || null, name: params.name || '', photo: '' };
  function paintHeart() {
    setIconButtonActive(heart, favorite);
    setIconButtonLabel(heart, favorite ? t('detail.unfavorite') : t('detail.favorite'));
  }
  async function toggleFavorite() {
    try {
      favorite = await ctx.favorites.togglePerson(favoriteTarget);
      paintHeart();
      ctx.notices.success(t(favorite ? 'notice.added' : 'notice.removed'), { key: 'favorite' });
    } catch {
      ctx.notices.error(t('error.UNKNOWN'), { key: 'favorite' });
    }
  }
  const buttons = () => [heart].concat(moreRow.style.display === 'none' ? [] : [moreChip]);
  // A long biography opened: Down / Up on "Show less" scroll it a few lines at a time; past its end Down goes on to the carousels.
  const SCROLL_STEP = 120;
  const bioOpen = () => !bioEl.classList.contains('clamped');
  const headerModel = {
    getCount: () => buttons().length,
    navigate(dir, i) {
      const onMore = buttons()[i] === moreChip;
      if (dir === 'down') {
        if (onMore && bioOpen() && bioEl.scrollTop + bioEl.clientHeight < bioEl.scrollHeight - 2) {
          bioEl.scrollTop += SCROLL_STEP;
          return { type: 'move', index: i };
        }
        return i + 1 < buttons().length ? { type: 'move', index: i + 1 } : { type: 'exit', dir };
      }
      if (dir === 'up') {
        if (onMore && bioOpen() && bioEl.scrollTop > 0) {
          bioEl.scrollTop = Math.max(0, bioEl.scrollTop - SCROLL_STEP);
          return { type: 'move', index: i };
        }
        return i > 0 ? { type: 'move', index: i - 1 } : { type: 'exit', dir };
      }
      return { type: 'exit', dir };
    },
  };
  const headerZone = new FocusZone({
    id: ZONE,
    nodes: buttons,
    model: headerModel,
    onFocus: (i) => buttons()[i] && buttons()[i].classList.add('focused'),
    onBlur: (i) => buttons()[i] && buttons()[i].classList.remove('focused'),
    onActivate: (i) => {
      if (buttons()[i] === heart) {
        toggleFavorite();
        return;
      }
      const open = bioEl.classList.toggle('clamped') === false;
      if (!open) bioEl.scrollTop = 0;
      moreChip.textContent = t(open ? 'person.showLess' : 'person.showMore');
    },
  });
  // Behind the page, as on a title page: the picture of one of their titles of the catalog, chosen at random.
  const backdropEl = h('div', { class: 'detail-backdrop' });
  let destroyed = false;
  function showBackdrop(url) {
    if (!url) return;
    const probe = new Image();
    probe.onload = () => {
      if (destroyed) return;
      backdropEl.style.backgroundImage = cssUrl(url);
      backdropEl.classList.add('visible');
    };
    probe.src = url;
  }
  /** A random title's backdrop: TMDB's (with the credits), otherwise the provider's details of a title (one request, cached). */
  async function pickBackdrop(info, entries) {
    const shown = new Set(entries.map((e) => e.key));
    const fromTmdb = ((info && info.credits) || []).filter((c) => c.backdrop && shown.has(`${c.type}:t${c.tmdbId}`));
    if (fromTmdb.length) {
      showBackdrop(fromTmdb[Math.floor(Math.random() * fromTmdb.length)].backdrop);
      return;
    }
    if (!entries.length || !ctx.details) return;
    const entry = entries[Math.floor(Math.random() * entries.length)];
    const details = await (entry.type === 'series' ? ctx.details.series(entry.defaultId) : ctx.details.vod(entry.defaultId)).catch(() => null);
    if (details && details.backdrop) showBackdrop(details.backdrop);
  }
  const header = h('div', { class: 'person-top' }, backdropEl, poster, h('div', { class: 'detail-body' }, nameEl, metaEl, actionsEl, factsEl, bioEl, moreRow));

  /** The info line: the TMDB logo first when TMDB gave the page, then its parts. */
  function setMeta(parts, fromTmdb = false) {
    while (metaEl.firstChild) metaEl.removeChild(metaEl.firstChild);
    (fromTmdb ? [TMDB] : []).concat(parts.filter(Boolean)).forEach((part, i) => {
      if (i > 0) metaEl.appendChild(createMetaSeparator());
      metaEl.appendChild(part === TMDB ? createMetaTmdb() : createMetaText(part));
    });
  }

  function fillHeader(info) {
    if (!info) {
      setMeta([params.role === 'director' ? t('person.director') : kind === 'company' ? t('detail.companies') : '']);
      return;
    }
    nameEl.textContent = info.name || params.name || '';
    setMeta([kind === 'company' ? t('detail.companies') : departmentLabel(info.department)], true);
    const image = kind === 'company' ? info.logo : info.photo;
    favoriteTarget = { kind, id: info.id || params.id || null, name: info.name || params.name || '', photo: image || '' };
    if (image) {
      // Shown once loaded (the placeholder stays until then, and when the picture cannot be loaded).
      const img = h('img', { alt: '', referrerpolicy: 'no-referrer' });
      img.addEventListener('load', () => {
        while (poster.firstChild) poster.removeChild(poster.firstChild);
        poster.appendChild(img);
      });
      img.src = image;
    }
    while (factsEl.firstChild) factsEl.removeChild(factsEl.firstChild);
    personFacts(info, i18n.getLocale()).forEach((line) => factsEl.appendChild(h('div', { text: line })));
    bioEl.textContent = (kind === 'company' ? info.description : info.biography) || '';
    // "Show more" only when the text goes past the lines shown.
    setTimeout(() => {
      moreRow.style.display = bioEl.scrollHeight > bioEl.clientHeight + 2 ? '' : 'none';
      if (ctx.focus.activeId !== ZONE) headerZone.index = buttons().length - 1; // Up from the carousels: the nearest, "Show more"
    }, 0);
  }

  const page = createCarouselPage(ctx, {
    className: 'person',
    loadingText: '',
    prefix: 'person',
    header,
    headerZone,
    onOpen: (entry) => ctx.openEntry(entry, { section: params.section || 'home' }),
    async load() {
      const current = await ctx.active.get();
      if (!current) return null;
      favorite = await ctx.favorites.hasPerson(favoriteTarget).catch(() => false);
      paintHeart();
      const tmdb = ctx.tmdb && ctx.tmdb.enabled && params.id ? ctx.tmdb : null;
      const info = tmdb ? await (kind === 'company' ? tmdb.company(params.id) : tmdb.person(params.id)).catch(() => null) : null;
      fillHeader(info);
      const entries = await personTitles({ info, name: params.name, kind, getEntryOf: (key) => getEntry(current.db, key).catch(() => null), byName: (role, name) => titlesByName(current.db, role, name).catch(() => []) });
      pickBackdrop(info, entries).catch(() => undefined);
      // The info line: a person's roles; a company's number of films and series of the catalog.
      const count = (type) => entries.filter((e) => e.type === type).length;
      const parts = kind === 'company' ? [t('person.movies', { count: count('movie') }), t('person.series', { count: count('series') })] : personRoles(info, entries);
      setMeta(parts, Boolean(info));
      // The line under its card in the favourites: the same roles (a company: its counts), kept up to date when it is one.
      favoriteTarget = { ...favoriteTarget, subtitle: parts.join(' · ') };
      if (favorite) ctx.favorites.refreshPerson(favoriteTarget).catch(() => undefined);
      return { entries, status: entries.length ? '' : t('person.empty') };
    },
  });
  const destroyPage = page.destroy;
  page.destroy = () => {
    destroyed = true;
    destroyPage();
  };
  return page;
}

