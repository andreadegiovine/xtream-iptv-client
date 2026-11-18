import { h } from '../dom.js';
import { t, i18n } from '../../i18n/index.js';
import { icon } from '../icons.js';
import { createButton } from '../atoms/button.js';
import { FocusZone } from '../focus/FocusManager.js';
import { ListModel } from '../focus/models.js';
import { createCarouselPage } from './templates.js';
import { getEntry } from '../../services/catalogQuery.js';
import { titlesByName } from '../../services/peopleIndex.js';

const BIO_LINES_CHARS = 420; // a longer biography is cut, "Read more" shows it all
const ZONE = 'personHeader';

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
const DEPARTMENTS = { Acting: 'person.acting', Directing: 'person.directing', Writing: 'person.writing', Production: 'person.production' };
const departmentLabel = (department) => (DEPARTMENTS[department] ? t(DEPARTMENTS[department]) : department || '');

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
 * (TMDB; without TMDB only the name), below the carousels of the films and series of the catalog they are in, with their role under each
 * card (the Favorites template). `params`: { kind: 'person' | 'company', id (TMDB id or null), name }.
 */
export function createPersonPage(ctx, params = {}) {
  const kind = params.kind === 'company' ? 'company' : 'person';
  const picture = h('div', { class: kind === 'company' ? 'person-picture logo' : 'person-picture' }, icon(kind === 'company' ? 'provider' : 'user', 'person-placeholder'));
  const nameEl = h('h1', { class: 'person-name', text: params.name || '' });
  const roleEl = h('div', { class: 'person-role muted' });
  const factsEl = h('div', { class: 'person-facts' });
  const bioEl = h('p', { class: 'person-bio' });
  const moreBtn = createButton({ label: t('person.readMore'), className: 'person-more' });
  moreBtn.style.display = 'none';
  let fullBio = '';
  const buttons = () => (moreBtn.style.display === 'none' ? [] : [moreBtn]);
  const headerZone = new FocusZone({
    id: ZONE,
    nodes: buttons,
    model: new ListModel({ orientation: 'horizontal', getCount: () => buttons().length }),
    onFocus: (i) => buttons()[i] && buttons()[i].classList.add('focused'),
    onBlur: (i) => buttons()[i] && buttons()[i].classList.remove('focused'),
    onActivate: () => ctx.dialogs.confirm({ title: nameEl.textContent, content: h('p', { class: 'person-bio-full', text: fullBio }), confirmLabel: t('common.close'), cancelLabel: null }),
  });
  const header = h('div', { class: 'person-header' }, picture, h('div', { class: 'person-info' }, nameEl, roleEl, factsEl, bioEl, moreBtn));

  function fillHeader(info) {
    if (!info) {
      roleEl.textContent = params.role === 'director' ? t('person.director') : kind === 'company' ? t('detail.companies') : '';
      return;
    }
    nameEl.textContent = info.name || params.name || '';
    roleEl.textContent = kind === 'company' ? t('detail.companies') : departmentLabel(info.department);
    const image = kind === 'company' ? info.logo : info.photo;
    if (image) {
      while (picture.firstChild) picture.removeChild(picture.firstChild);
      picture.appendChild(h('img', { src: image, alt: '' }));
    }
    while (factsEl.firstChild) factsEl.removeChild(factsEl.firstChild);
    personFacts(info, i18n.getLocale()).forEach((line) => factsEl.appendChild(h('div', { text: line })));
    fullBio = (kind === 'company' ? info.description : info.biography) || '';
    const cut = fullBio.length > BIO_LINES_CHARS;
    bioEl.textContent = cut ? `${fullBio.slice(0, fullBio.lastIndexOf(' ', BIO_LINES_CHARS) > 0 ? fullBio.lastIndexOf(' ', BIO_LINES_CHARS) : BIO_LINES_CHARS)}…` : fullBio;
    moreBtn.style.display = cut ? '' : 'none';
  }

  return createCarouselPage(ctx, {
    className: 'person',
    loadingText: '',
    prefix: 'person',
    header,
    headerZone,
    onOpen: (entry) => ctx.openEntry(entry, { section: params.section || 'home' }),
    async load() {
      const current = await ctx.active.get();
      if (!current) return null;
      const tmdb = ctx.tmdb && ctx.tmdb.enabled && params.id ? ctx.tmdb : null;
      const info = tmdb ? await (kind === 'company' ? tmdb.company(params.id) : tmdb.person(params.id)).catch(() => null) : null;
      fillHeader(info);
      const entries = await personTitles({ info, name: params.name, kind, getEntryOf: (key) => getEntry(current.db, key).catch(() => null), byName: (role, name) => titlesByName(current.db, role, name).catch(() => []) });
      return { entries, status: entries.length ? '' : t('person.empty') };
    },
  });
}

