import { Action } from '../../core/input.js';
import { Dir } from './models.js';

const DIRECTIONS = {
  [Action.UP]: Dir.UP,
  [Action.DOWN]: Dir.DOWN,
  [Action.LEFT]: Dir.LEFT,
  [Action.RIGHT]: Dir.RIGHT,
};

/**
 * A focusable region (topbar, grid, form...). It remembers its own index.
 * For the pointer (mouse, touch, Magic Remote): `nodes()` gives the element of each index (the one under the pointer becomes the focus),
 * or `locate(target)` finds the index of an element itself (null when it is not one of the zone's).
 */
export class FocusZone {
  constructor({ id, model, onFocus, onBlur, onActivate, onLongActivate = null, nodes = null, locate = null }) {
    this.id = id;
    this.nodes = nodes;
    this.locate = locate;
    this.onLongActivate = onLongActivate; // OK held down (null: a long press is a normal one)
    this.model = model;
    this.onFocus = onFocus || (() => {});
    this.onBlur = onBlur || (() => {});
    this.onActivate = onActivate || (() => {});
    this.index = 0;
  }

  get count() {
    return this.model.getCount();
  }

  canFocus() {
    return this.count > 0;
  }

  clamp(index) {
    return Math.max(0, Math.min(index, this.count - 1));
  }
}

/**
 * Scrolling with Up / Down where the focus cannot follow (content without anything to focus: a long table, a text, a form taller than
 * the screen). The box that scrolls is the page or the dialog of the focused element (`.page`, `.dialog`), only when it is taller than
 * its view; lists that scroll by themselves (carousels, the guide, drop-downs) are not concerned.
 */
const SCROLL_STEP = 0.4; // of the height of the view
function scrollerOf(node) {
  const box = node && node.closest ? node.closest('.dialog, .page') : null;
  if (!box || box.scrollHeight <= box.clientHeight + 2) return null;
  return box;
}
const viewOf = (box) => box.getBoundingClientRect();
function visibleIn(node, view) {
  const r = node.getBoundingClientRect();
  return r.bottom > view.top + 1 && r.top < view.bottom - 1 && (r.width > 0 || r.height > 0);
}
/** Below (Down) or above (Up) the view, not visible at all. */
function beyond(node, view, down) {
  const r = node.getBoundingClientRect();
  return down ? r.top >= view.bottom - 1 : r.bottom <= view.top + 1;
}
/** Scrolls the box by a step; false when it is already at that end. */
function scrollStep(box, down) {
  const before = box.scrollTop;
  box.scrollTop = before + (down ? 1 : -1) * Math.max(80, Math.round(box.clientHeight * SCROLL_STEP));
  return box.scrollTop !== before;
}

/** Moves focus inside a zone, and between zones through explicit links (zone A --down--> zone B). */
/**
 * Runs the action of an entry of a zone once at a time: while what it started has not ended (the promise it returns: a dialog closed, a
 * request answered) the same entry does nothing — a quick second press used to open the same dialog twice. The entry shows `busy`.
 */
export function runOnce(zone, action) {
  const index = zone.index;
  if (!zone.busy) zone.busy = new Set();
  if (zone.busy.has(index)) return undefined;
  const result = action(index);
  if (!result || typeof result.then !== 'function') return result;
  zone.busy.add(index);
  const node = zone.nodes ? (zone.nodes() || [])[index] : null;
  if (node && node.classList) node.classList.add('busy');
  const done = () => {
    zone.busy.delete(index);
    if (node && node.classList) node.classList.remove('busy');
  };
  result.then(done, done);
  return result;
}

export class FocusManager {
  constructor() {
    this.zones = new Map();
    this.links = new Map();
    this.activeId = null;
  }

  register(zone) {
    this.zones.set(zone.id, zone);
    return () => this.unregister(zone.id);
  }

  unregister(id) {
    if (this.activeId === id) this.activeId = null;
    this.zones.delete(id);
    this.links.delete(id);
    // Drop links pointing at the removed zone, so a stale target is never followed.
    this.links.forEach((byDir) => {
      Object.keys(byDir).forEach((dir) => {
        if (byDir[dir] === id) delete byDir[dir];
      });
    });
  }

  link(fromId, dir, toId) {
    if (!this.links.has(fromId)) this.links.set(fromId, {});
    this.links.get(fromId)[dir] = toId;
  }

  get active() {
    return this.activeId ? this.zones.get(this.activeId) : null;
  }

  focus(id, index) {
    const zone = this.zones.get(id);
    if (!zone || !zone.canFocus()) return false;
    const current = this.active;
    if (current) current.onBlur(current.index);
    zone.index = zone.clamp(index === undefined ? zone.index : index);
    this.activeId = id;
    zone.onFocus(zone.index);
    return true;
  }

  /**
   * The zone and index of the element under the pointer (`target` or one of its ancestors), or null. The zones registered last (a dialog)
   * come first; among several, the smallest element that holds the target wins (a card rather than the row around it).
   */
  locate(target) {
    if (!target || target.nodeType !== 1) return null;
    let best = null;
    const zones = Array.from(this.zones.values()).reverse();
    for (const zone of zones) {
      if (!zone.canFocus()) continue;
      if (zone.locate) {
        const index = zone.locate(target);
        if (index !== null && index !== undefined && index >= 0) return { id: zone.id, index };
        continue;
      }
      if (!zone.nodes) continue;
      const list = zone.nodes() || [];
      for (let i = 0; i < list.length; i += 1) {
        const node = list[i];
        if (node && node.contains && node.contains(target) && (!best || best.node.contains(node))) best = { id: zone.id, index: i, node };
      }
      if (best) break; // a later (upper) zone holds it: the zones under it are not looked at
    }
    return best ? { id: best.id, index: best.index } : null;
  }

  /** OK on an index of a zone (a click): the focus goes there first. `long`: a long press (right click, long touch). */
  activate(id, index, { long = false } = {}) {
    if (!this.focus(id, index)) return false;
    const zone = this.zones.get(id);
    if (long) {
      if (!zone.onLongActivate) return false;
      runOnce(zone, zone.onLongActivate);
    } else runOnce(zone, zone.onActivate);
    return true;
  }

  /** Returns true when the action was consumed. */
  handle(action) {
    const zone = this.active;
    if (!zone) return false;
    if (action === Action.ENTER) {
      runOnce(zone, zone.onActivate);
      return true;
    }
    if (action === Action.LONG_ENTER) {
      runOnce(zone, zone.onLongActivate || zone.onActivate);
      return true;
    }
    const dir = DIRECTIONS[action];
    if (!dir) return false;
    if (!zone.canFocus()) return true;

    const vertical = dir === Dir.UP || dir === Dir.DOWN;
    const down = dir === Dir.DOWN;
    const nodeAt = (i) => (zone.nodes ? (zone.nodes() || [])[i] : null);
    const here = vertical ? nodeAt(zone.clamp(zone.index)) : null;
    const box = here ? scrollerOf(here) : null;
    // The focused element was scrolled out of view: the arrow scrolls on, and the focus goes to an element of the zone as soon as one
    // shows (the first below for Down, the last above for Up); at the end of the content nothing happens.
    if (box && !visibleIn(here, viewOf(box))) {
      scrollStep(box, down);
      this.focusShown(zone, box, down);
      return true;
    }

    const result = zone.model.navigate(dir, zone.clamp(zone.index));
    if (result.type === 'move') {
      // The next element is far below (or above), past content that takes no focus: a step of scroll first; the focus moves once it
      // shows (at once, when a step is enough).
      const target = box ? nodeAt(zone.clamp(result.index)) : null;
      if (target && beyond(target, viewOf(box), down) && scrollStep(box, down) && !visibleIn(target, viewOf(box))) return true;
      zone.onBlur(zone.index);
      zone.index = zone.clamp(result.index);
      zone.onFocus(zone.index);
      return true;
    }

    // Follow links, skipping empty zones, with a guard against cycles.
    let fromId = zone.id;
    for (let hops = 0; hops < this.zones.size; hops += 1) {
      const targetId = (this.links.get(fromId) || {})[dir];
      if (!targetId) break;
      if (this.focus(targetId)) return true;
      fromId = targetId;
    }
    // Nothing more to focus that way, but the page or the dialog goes on (a table, a text under the last button): it scrolls.
    if (box) scrollStep(box, down);
    return true;
  }

  /** After a step of scroll: the focus to an element of `zone` now on screen (the first below for Down, the last above for Up), if any. */
  focusShown(zone, box, down) {
    const list = (zone.nodes && zone.nodes()) || [];
    const view = viewOf(box);
    const here = zone.clamp(zone.index);
    if (list[here] && visibleIn(list[here], view)) return;
    let pick = -1;
    for (let i = 0; i < list.length; i += 1) {
      if (!list[i] || !visibleIn(list[i], view)) continue;
      if (down) {
        if (i > here || pick < 0) pick = i;
        if (i > here) break;
      } else if (i < here) pick = i;
      else if (pick < 0) pick = i;
    }
    if (pick < 0 || pick === here) return;
    zone.onBlur(zone.index);
    zone.index = zone.clamp(pick);
    zone.onFocus(zone.index);
  }
}
