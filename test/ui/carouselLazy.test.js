import { createCarousel, VISIBLE_CARDS, AHEAD_CARDS } from '../../src/ui/components/carousel.js';

const item = (n) => ({ entry: { key: `movie:${n}`, name: `M${n}` }, type: 'movie' });
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a long row starts with the cards on screen plus five, the next ones come while the focus moves right', async () => {
  const asked = [];
  const more = jest.fn(async (offset, count) => {
    asked.push([offset, count]);
    return Array.from({ length: Math.max(0, Math.min(count, 40 - offset)) }, (_, i) => item(offset + i));
  });
  const added = [];
  const c = createCarousel({ id: 'row', title: 'Row', items: [item(0), item(1), item(2)], more, onAdded: (list, cards) => added.push([list.length, cards.length]) });
  await wait();
  expect(c.cards).toHaveLength(VISIBLE_CARDS + AHEAD_CARDS); // 3 given, the rest read at once
  expect(asked).toEqual([[3, VISIBLE_CARDS + AHEAD_CARDS - 3]]);
  expect(added).toEqual([[9, 9]]);
  c.zone.onFocus(3); // the focus moves right: five past the screen are always there
  await wait();
  expect(c.cards).toHaveLength(3 + VISIBLE_CARDS + AHEAD_CARDS);
  for (let i = 4; i < 40; i += 1) {
    c.zone.onFocus(i); // one card at a time, like the remote
    await wait();
  }
  expect(c.cards).toHaveLength(40); // the end of the row: no more requests
  const calls = more.mock.calls.length;
  c.zone.onFocus(39);
  await wait();
  expect(more.mock.calls.length).toBe(calls);
});

test('a row without `more` shows the cards it was given', () => {
  const c = createCarousel({ id: 'r', title: '', items: [item(1)] });
  expect(c.cards).toHaveLength(1);
});

test('near the last card read, placeholder cards follow while the next are read; at the end they go', async () => {
  let release = null;
  let served = 12;
  const more = jest.fn((offset, count) => {
    if (offset < 12) return Promise.resolve(Array.from({ length: count }, (_, i) => item(offset + i)));
    // Slow: the next page waits until released; then a short one (the end of the row).
    return new Promise((resolve) => {
      release = () => {
        served = offset + 3;
        resolve(Array.from({ length: 3 }, (_, i) => item(offset + i)));
      };
    });
  });
  const c = createCarousel({ id: 'slow', title: 'Row', items: [], more });
  await wait();
  expect(c.cards).toHaveLength(12);
  const skeletons = () => c.el.querySelectorAll('.skeleton-card').length;
  expect(skeletons()).toBe(0); // not before the focus gets close to the end
  c.zone.onFocus(10);
  await wait();
  expect(skeletons()).toBeGreaterThan(0); // reading: placeholders after the last real card
  expect(c.zone.model.getCount()).toBe(12); // the focus cannot go past the last real card meanwhile
  release();
  await wait();
  await wait();
  expect(c.cards).toHaveLength(served);
  expect(skeletons()).toBe(0); // the end of the row: no placeholders
  // The real cards stay in order, before where the placeholders were.
  const keys = Array.from(c.el.querySelectorAll('.card')).length;
  expect(keys).toBe(served);
});
