import { h } from './dom.js';
import { createLogo } from './components/logo.js';
import { createTopbarItemSkeleton } from './atoms/topbarItem.js';
import { createHomeSkeleton } from './pages/homePage.js';

/**
 * What the start shows while the app gets ready, as the first start and "Who is watching?": the bar (logo and placeholders) and the
 * Home skeleton. Replaces the logo of the page's first paint as soon as the app's code runs; the bar goes when the real one is added,
 * the page when the first page replaces the content.
 */
export const createStartBar = () =>
  h('nav', { class: 'topbar start-bar' }, createLogo(), [0, 1, 2, 3, 4].map(() => createTopbarItemSkeleton()), h('span', { class: 'topbar-spacer' }), [0, 1, 2].map(() => createTopbarItemSkeleton({ icon: true })));

export const createStartBackdrop = () => h('div', { class: 'setup-backdrop home-skeleton', 'aria-hidden': 'true' }, createHomeSkeleton());

/** In place of the logo of the first paint (`.boot-splash` in #content), and the bar in #topbar. Once. */
export function showStartSkeleton(doc = document) {
  const splash = doc.querySelector('#content .boot-splash');
  if (!splash || splash.classList.contains('with-skeleton')) return;
  splash.classList.add('with-skeleton');
  splash.textContent = '';
  splash.appendChild(h('section', { class: 'page setup first-run' }, createStartBackdrop()));
  const host = doc.getElementById('topbar');
  if (host && !host.querySelector('.start-bar')) host.appendChild(createStartBar());
}

/** The real bar is there: the placeholder one goes. */
export function removeStartBar(doc = document) {
  const bar = doc.querySelector('#topbar .start-bar');
  if (bar) bar.remove();
}
