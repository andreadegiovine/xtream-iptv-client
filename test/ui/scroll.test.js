import { computeScrollTop, ensureVisible } from '../../src/ui/scroll.js';

const base = { viewTop: 100, viewBottom: 900, scrollTop: 0, margin: 20 };

describe('computeScrollTop', () => {
  test('does nothing when the element is already visible', () => {
    expect(computeScrollTop({ ...base, elTop: 300, elBottom: 400 })).toBe(0);
  });

  test('scrolls down just enough to reveal an element below the view', () => {
    expect(computeScrollTop({ ...base, scrollTop: 50, elTop: 880, elBottom: 980 })).toBe(50 + 100);
  });

  test('scrolls up to reveal an element above the view', () => {
    expect(computeScrollTop({ ...base, scrollTop: 400, elTop: 60, elBottom: 160 })).toBe(400 - 60);
  });

  test('an element taller than the view is aligned to its top', () => {
    expect(computeScrollTop({ ...base, scrollTop: 0, elTop: 300, elBottom: 1500 })).toBe(300 - 20 - 100);
  });
});

describe('ensureVisible', () => {
  /** A page of `height` px whose element sits at `top`..`bottom` of its content (the rects follow scrollTop, as in a real page). */
  function makePage({ height = 800, top, bottom }, scrollTop = 0) {
    const page = document.createElement('section');
    page.className = 'page';
    const el = document.createElement('div');
    page.appendChild(el);
    page.scrollTop = scrollTop;
    page.getBoundingClientRect = () => ({ top: 0, bottom: height, height });
    el.getBoundingClientRect = () => ({ top: top - page.scrollTop, bottom: bottom - page.scrollTop, height: bottom - top });
    return { page, el };
  }

  test('an element below the first screen: the page moves just enough to show it whole', () => {
    const { page, el } = makePage({ top: 900, bottom: 1000 });
    ensureVisible(el, { margin: 0 });
    expect(page.scrollTop).toBe(200);
  });

  test('an element that fits on the first screen: the page goes back to its top (the heading shows)', () => {
    const { page, el } = makePage({ top: 500, bottom: 700 }, 300);
    ensureVisible(el, { margin: 32 });
    expect(page.scrollTop).toBe(0);
  });

  test('under a tall header (a person page) the row is kept whole, the top only as far as it can', () => {
    const { page, el } = makePage({ top: 700, bottom: 1100 }, 0);
    ensureVisible(el, { first: true, margin: 0 });
    expect(page.scrollTop).toBe(300); // as little as needed: the header shows as much as it can
    page.scrollTop = 600; // already whole on screen: left as it is
    ensureVisible(el, { margin: 0 });
    expect(page.scrollTop).toBe(600);
  });

  test('elements outside a page are ignored', () => {
    expect(() => ensureVisible(document.createElement('div'))).not.toThrow();
  });
});
