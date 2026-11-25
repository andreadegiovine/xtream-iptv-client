/**
 * @jest-environment node
 */
import { createLicensing, deviceKeyOf, statusOf, countdownParts, KEY_PATTERN, OFFLINE_GRACE_MS } from '../../src/services/licensing.js';

const DAY = 24 * 3600 * 1000;
const memoryStore = (initial = null) => {
  let value = initial;
  return { get: async () => value, set: async (v) => { value = v; }, peek: () => value };
};
const answer = (body, ok = true) => jest.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }));

test('the key of a device: stable, readable, never the id itself', async () => {
  const a = await deviceKeyOf('T-DUID-123');
  expect(a).toMatch(KEY_PATTERN);
  expect(await deviceKeyOf('T-DUID-123')).toBe(a);
  expect(await deviceKeyOf('T-DUID-124')).not.toBe(a);
  expect(a).not.toContain('DUID');
});

test('first start: the service starts the trial; its end is kept with the server clock', async () => {
  let clock = 1000 * DAY;
  const store = memoryStore();
  const fetchImpl = answer({ active: false, endsAt: clock + 30 * DAY + 5000, now: clock + 5000 });
  const lic = createLicensing({ store, deviceId: async () => 'tv-1', url: 'https://lic.example', fetchImpl, now: () => clock });
  const status = await lic.check();
  expect(fetchImpl).toHaveBeenCalledWith('https://lic.example/check', expect.objectContaining({ method: 'POST', body: JSON.stringify({ key: await deviceKeyOf('tv-1') }) }));
  expect(status.state).toBe('trial');
  expect(status.left).toBe(30 * DAY);
  // Offline later: the saved end, on the TV clock corrected by the server's.
  clock += 31 * DAY;
  const offline = createLicensing({ store, deviceId: async () => 'tv-1', url: 'https://lic.example', fetchImpl: jest.fn(async () => { throw new Error('offline'); }), now: () => clock });
  expect((await offline.check()).state).toBe('expired');
});

test('activated once: saved, the service is never asked again', async () => {
  const store = memoryStore();
  const fetchImpl = answer({ active: true });
  const lic = createLicensing({ store, deviceId: async () => 'tv-2', url: 'https://lic.example', fetchImpl });
  expect((await lic.check()).state).toBe('active');
  expect((await lic.check()).state).toBe('active');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(store.peek().active).toBe(true);
});

test('never checked: a few days of grace, then a check is needed (not a payment)', async () => {
  let clock = 5000 * DAY;
  const store = memoryStore();
  const fetchImpl = jest.fn(async () => { throw new Error('offline'); });
  const lic = createLicensing({ store, deviceId: async () => 'tv-3', url: 'https://lic.example', fetchImpl, now: () => clock });
  expect((await lic.check()).state).toBe('pending');
  clock += OFFLINE_GRACE_MS + 1;
  const status = await lic.check();
  expect(status).toMatchObject({ state: 'expired', offline: true });
});

test('a browser without a system id: a random id kept in its storage', async () => {
  const kept = {};
  const storage = { getItem: (k) => kept[k] || null, setItem: (k, v) => { kept[k] = v; } };
  const a = await createLicensing({ store: memoryStore(), fallbackStorage: storage }).key();
  const b = await createLicensing({ store: memoryStore(), fallbackStorage: storage }).key();
  expect(a).toBe(b);
});

test('status and countdown', () => {
  expect(statusOf(null, 'K', 0).state).toBe('pending');
  expect(statusOf({ key: 'OTHER', active: true }, 'K', 0).state).toBe('pending'); // saved for another device
  expect(statusOf({ key: 'K', endsAt: 100, skew: 0 }, 'K', 50)).toMatchObject({ state: 'trial', left: 50 });
  expect(countdownParts(2 * DAY + 3 * 3600 * 1000 + 5 * 60000)).toEqual({ days: 2, hours: 3, minutes: 5 });
});
