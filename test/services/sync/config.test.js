import { decodeSyncToken } from '../../../src/services/sync/config.js';

const { encodeSyncToken } = require('../../../scripts/sync-token.js');

test('the build stores the token encoded, the app reads it back', () => {
  const token = 'github_pat_11ABCDEF0123456789_abcdefghijklmnopqrstuvwxyz';
  const stored = encodeSyncToken(token);
  expect(stored).not.toContain('github_pat_');
  expect(/^[0-9a-f]+$/.test(stored)).toBe(true);
  expect(decodeSyncToken(stored)).toBe(token);
  expect(decodeSyncToken(encodeSyncToken(''))).toBe('');
});
