import { h, cx } from '../dom.js';
import { icon } from '../icons.js';

/** A profile's avatar (`.avatar`): its icon on its own gradient (src/styles/atoms/_avatar.scss). */
export function createAvatar(id, { className = '' } = {}) {
  return h('span', { class: cx('avatar', `avatar-${id}`, className), 'aria-hidden': 'true' }, icon(`avatar-${id}`));
}
