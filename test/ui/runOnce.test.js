import { FocusManager, FocusZone } from '../../src/ui/focus/FocusManager.js';
import { ListModel } from '../../src/ui/focus/models.js';
import { Action } from '../../src/core/input.js';

test('an action runs once at a time: a quick second OK (or click) does nothing until the first has ended', async () => {
  const focus = new FocusManager();
  let release = null;
  const calls = [];
  const nodes = [document.createElement('button'), document.createElement('button')];
  focus.register(new FocusZone({
    id: 'z',
    nodes: () => nodes,
    model: new ListModel({ orientation: 'horizontal', getCount: () => 2 }),
    onActivate: (i) => {
      calls.push(i);
      return i === 0 ? new Promise((resolve) => { release = resolve; }) : undefined; // 0 opens a dialog, 1 is immediate
    },
  }));
  focus.focus('z', 0);
  focus.handle(Action.ENTER);
  focus.handle(Action.ENTER);
  focus.activate('z', 0);
  expect(calls).toEqual([0]);
  expect(nodes[0].classList.contains('busy')).toBe(true);
  focus.activate('z', 1); // another entry is not held
  focus.activate('z', 1);
  expect(calls).toEqual([0, 1, 1]);
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(nodes[0].classList.contains('busy')).toBe(false);
  focus.activate('z', 0);
  expect(calls).toEqual([0, 1, 1, 0]);
});
