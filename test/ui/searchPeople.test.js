import { openProviderDb } from '../../src/db/providerDb.js';
import { dbPutMany } from '../../src/core/idb.js';
import { FocusManager } from '../../src/ui/focus/FocusManager.js';
import { createSearchPage } from '../../src/ui/pages/searchPage.js';

Element.prototype.scrollIntoView = () => undefined;
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

test('search: only the people and companies with films or series in the catalog', async () => {
  const db = await openProviderDb(`search-people-${Math.random()}`);
  await dbPutMany(db, 'entries', [{ key: 'movie:t10', type: 'movie', name: 'Bad Boys', added: 1 }]);
  const tmdb = {
    enabled: true,
    searchPeople: async (kind) =>
      kind === 'person'
        ? [{ kind: 'person', id: 1, name: 'Will Smith', photo: '', department: 'Acting' }, { kind: 'person', id: 2, name: 'Will Nobody', photo: '', department: 'Acting' }]
        : [{ kind: 'company', id: 5, name: 'Willow Films', photo: '', department: 'US' }, { kind: 'company', id: 6, name: 'Will Studio', photo: '', department: 'IT' }],
    person: async (id) => ({ kind: 'person', id, credits: id === 1 ? [{ type: 'movie', tmdbId: 10, role: 'Mike' }] : [{ type: 'movie', tmdbId: 99, role: 'X' }] }),
    company: async (id) => ({ kind: 'company', id, credits: id === 5 ? [{ type: 'movie', tmdbId: 10 }] : [] }),
  };
  const ctx = {
    focus: new FocusManager(),
    active: { get: async () => ({ provider: { id: 'p' }, db }) },
    search: { search: async () => [] },
    tmdb,
    settings: { get: async () => ({}) },
    router: { push: jest.fn() },
  };
  const page = createSearchPage(ctx, { query: 'will' });
  document.body.appendChild(page.el);
  page.mount();
  await wait(200);
  const names = Array.from(page.el.querySelectorAll('.typed-rows .card-title')).map((n) => n.textContent).filter(Boolean);
  expect(names).toEqual(['Will Smith', 'Willow Films']);
  page.destroy();
});
