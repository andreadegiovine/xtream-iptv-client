import { profileFormModel } from '../../src/ui/components/profileForm.js';

test('profile form focus: the avatars in two lines of ten, the rows, then Cancel / Save', () => {
  let chosen = 13;
  const m = profileFormModel({ avatars: 20, rows: 4, back: () => chosen });
  const go = (dir, i) => m.navigate(dir, i);
  expect(m.getCount()).toBe(26);
  expect(go('right', 9)).toEqual({ type: 'exit', dir: 'right' }); // end of the first line
  expect(go('down', 3)).toEqual({ type: 'move', index: 13 });
  expect(go('down', 13)).toEqual({ type: 'move', index: 20 }); // second line → the name
  expect(go('up', 20)).toEqual({ type: 'move', index: 13 }); // back to the chosen avatar
  chosen = 2;
  expect(go('up', 20)).toEqual({ type: 'move', index: 2 });
  expect(go('down', 23)).toEqual({ type: 'move', index: 25 }); // last row → Save
  expect(go('left', 25)).toEqual({ type: 'move', index: 24 }); // Cancel
  expect(go('up', 24)).toEqual({ type: 'move', index: 23 });
  expect(go('right', 21)).toEqual({ type: 'exit', dir: 'right' });
});

test('profile form focus: rows that come and go (the limits of a kids profile) move Cancel / Save', () => {
  let rows = 4;
  const m = profileFormModel({ avatars: 20, rows: () => rows, back: () => 0 });
  expect(m.getCount()).toBe(26);
  rows = 8;
  expect(m.getCount()).toBe(30);
  expect(m.navigate('down', 27)).toEqual({ type: 'move', index: 29 }); // last row → Save
  expect(m.navigate('up', 28)).toEqual({ type: 'move', index: 27 });
});
