import { h } from '../dom.js';
import { icon as iconNode } from '../icons.js';

/** The dot between two parts of a meta line (year · rating · duration). */
export const createMetaSeparator = () => h('span', { class: 'meta-sep', text: '·' });

/** A rating with its star (`.meta-rating`). */
export const createMetaRating = (text) => h('span', { class: 'meta-rating' }, iconNode('star'), h('span', { text }));

const SVG_NS = 'http://www.w3.org/2000/svg';
/**
 * "TMDB" first in the meta line of a page enriched by TMDB (its metadata, cast, pictures): a white wordmark in a rounded frame, drawn
 * with the text of the app (no picture to load), as TMDB asks to credit it.
 */
export function createMetaTmdb() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 92 32');
  svg.setAttribute('class', 'meta-tmdb');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'TMDB');
  const frame = document.createElementNS(SVG_NS, 'rect');
  [['x', '1.5'], ['y', '1.5'], ['width', '89'], ['height', '29'], ['rx', '8'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '3']].forEach(([k, v]) => frame.setAttribute(k, v));
  const text = document.createElementNS(SVG_NS, 'text');
  [['x', '46'], ['y', '22.5'], ['text-anchor', 'middle'], ['fill', 'currentColor'], ['font-size', '19'], ['font-weight', '800'], ['letter-spacing', '1']].forEach(([k, v]) => text.setAttribute(k, v));
  text.textContent = 'TMDB';
  svg.append(frame, text);
  return svg;
}

/** A plain part of a meta line. */
export const createMetaText = (text) => h('span', { text });
