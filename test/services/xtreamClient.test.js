import {
  XtreamClient,
  normalizeBaseUrl,
  pickLiveFormat,
  parseAuthResponse,
  decodeBase64Utf8,
  timeshiftStart,
  catchupAddresses,
} from '../../src/services/xtreamClient.js';
import { ErrorCode } from '../../src/core/errors.js';

const authData = (overrides = {}) => ({
  user_info: { auth: 1, status: 'Active', exp_date: '4102444800', max_connections: '2', active_cons: '0', allowed_output_formats: ['m3u8', 'ts'], ...overrides },
  server_info: { url: 'h', port: '80', timezone: 'Europe/Rome' },
});

describe('normalizeBaseUrl', () => {
  test.each([
    ['host:8080', 'http://host:8080'],
    ['http://host:8080/', 'http://host:8080'],
    ['https://host/player_api.php?x=1', 'https://host'],
    ['http://host/panel/get.php', 'http://host/panel'],
    ['  HTTP://Host:80  ', 'http://host'],
  ])('%s -> %s', (input, expected) => expect(normalizeBaseUrl(input)).toBe(expected));

  test('rejects empty and non-http input', () => {
    expect(() => normalizeBaseUrl('')).toThrow();
    expect(() => normalizeBaseUrl('ftp://host')).toThrow();
  });
});

describe('XtreamClient', () => {
  const make = (fetcher = jest.fn()) =>
    new XtreamClient({ baseUrl: 'http://h:80', username: 'bob', password: 'p@ss', fetchJson: fetcher, wrapUrl: (u) => u });

  test('builds API urls with encoded credentials', () => {
    expect(make().apiUrl('get_vod_streams', { category_id: 3 })).toBe(
      'http://h:80/player_api.php?username=bob&password=p%40ss&action=get_vod_streams&category_id=3',
    );
  });

  test('builds stream urls and picks the live format from the account', async () => {
    const client = make(jest.fn().mockResolvedValue(authData({ allowed_output_formats: ['ts'] })));
    await client.authenticate();
    expect(client.streamUrl('live', 5)).toBe('http://h:80/live/bob/p%40ss/5.ts');
    expect(client.streamUrl('movie', 9, 'mkv')).toBe('http://h:80/movie/bob/p%40ss/9.mkv');
    expect(client.streamUrl('series', 11, 'mp4')).toBe('http://h:80/series/bob/p%40ss/11.mp4');
  });

  test('authenticate returns user and server info', async () => {
    const auth = await make(jest.fn().mockResolvedValue(authData())).authenticate();
    expect(auth.user).toMatchObject({ maxConnections: 2, activeConnections: 0 });
    expect(auth.server.timezone).toBe('Europe/Rome');
  });

  test('list endpoints reject auth failures disguised as data', async () => {
    const client = make(jest.fn().mockResolvedValue({ user_info: { auth: 0 } }));
    await expect(client.getStreams('movie')).rejects.toMatchObject({ code: ErrorCode.AUTH_FAILED });
  });

  test('short EPG is decoded and converted to milliseconds', async () => {
    const title = btoa('News');
    const client = make(
      jest.fn().mockResolvedValue({ epg_listings: [{ id: '1', title, description: btoa('Desc'), start_timestamp: '100', stop_timestamp: '200' }, { id: '2', title }] }),
    );
    expect(await client.getShortEpg(5)).toEqual([{ id: '1', title: 'News', description: 'Desc', start: 100000, stop: 200000 }]);
  });
});

describe('parseAuthResponse', () => {
  test('failure modes', () => {
    expect(() => parseAuthResponse({})).toThrow(expect.objectContaining({ code: ErrorCode.AUTH_FAILED }));
    expect(() => parseAuthResponse(authData({ auth: 0 }))).toThrow(expect.objectContaining({ code: ErrorCode.AUTH_FAILED }));
    expect(() => parseAuthResponse(authData({ status: 'Expired' }))).toThrow(expect.objectContaining({ code: ErrorCode.ACCOUNT_EXPIRED }));
    expect(() => parseAuthResponse(authData({ status: 'Banned' }))).toThrow(expect.objectContaining({ code: ErrorCode.ACCOUNT_DISABLED }));
    expect(() => parseAuthResponse(authData({ exp_date: '1000' }), 2_000_000)).toThrow(expect.objectContaining({ code: ErrorCode.ACCOUNT_EXPIRED }));
  });

  test('unlimited accounts (no exp_date) are accepted', () => {
    expect(parseAuthResponse(authData({ exp_date: null })).user.expiresAt).toBeNull();
  });
});

describe('helpers', () => {
  test('pickLiveFormat', () => {
    expect(pickLiveFormat(['ts', 'm3u8'])).toBe('m3u8');
    expect(pickLiveFormat(['ts'])).toBe('ts');
    expect(pickLiveFormat([])).toBe('m3u8');
    expect(pickLiveFormat(['rtmp'])).toBe('rtmp');
  });

  test('decodeBase64Utf8 handles accents and bad input', () => {
    expect(decodeBase64Utf8('Q2l0dMOg')).toBe('Città');
    expect(decodeBase64Utf8('not base64 !!')).toBe('not base64 !!');
  });
});

describe('catch-up', () => {
  test('timeshiftStart writes the start in the server time zone (UTC without one)', () => {
    const at = Date.UTC(2026, 10, 2, 20, 5);
    expect(timeshiftStart(at, 'Europe/Rome')).toBe('2026-11-02:21-05');
    expect(timeshiftStart(at, '')).toBe('2026-11-02:20-05');
    expect(timeshiftStart(at, 'Not/AZone')).toBe('2026-11-02:20-05');
  });
});

test('catch-up addresses: .ts and timeshift.php in the server zone, .ts in UTC and in the device zone, then .m3u8', () => {
  const start = Date.UTC(2026, 10, 2, 20, 5);
  const list = catchupAddresses({ baseUrl: 'http://h:80', username: 'u s', password: 'p', timezone: 'Europe/Rome', id: 42, start, stop: start + 61 * 60000, deviceZone: 'America/New_York' });
  expect(list).toEqual([
    'http://h:80/timeshift/u%20s/p/61/2026-11-02:21-05/42.ts',
    'http://h:80/streaming/timeshift.php?username=u%20s&password=p&stream=42&start=2026-11-02:21-05&duration=61',
    'http://h:80/timeshift/u%20s/p/61/2026-11-02:20-05/42.ts',
    'http://h:80/timeshift/u%20s/p/61/2026-11-02:15-05/42.ts',
    'http://h:80/timeshift/u%20s/p/61/2026-11-02:21-05/42.m3u8',
  ]);
  // The same zone everywhere: no address twice.
  expect(catchupAddresses({ baseUrl: 'http://h', username: 'u', password: 'p', timezone: '', id: 1, start, stop: start + 60000, deviceZone: 'UTC' })).toHaveLength(3);
});

test('catch-up probe: what the provider answers, for the log', async () => {
  const { probeAddress, probeText } = await import('../../src/services/catchupProbe.js');
  const res = { status: 404, url: 'http://other.example:8080/x', redirected: true, headers: { get: () => 'text/html' }, body: { cancel: jest.fn() } };
  const answer = await probeAddress('http://h/x', { fetchImpl: async () => res });
  expect(probeText(answer)).toBe('HTTP 404 · text/html · host other.example:8080 (redirected)');
  expect(res.body.cancel).toHaveBeenCalled();
  expect(probeText(await probeAddress('http://h/x', { fetchImpl: async () => { throw new Error('Failed to fetch'); } }))).toBe('no answer (Failed to fetch)');
});

test("catch-up: the provider's own guide gives the start its archive uses, and whether it keeps the programme", async () => {
  const start = Date.UTC(2026, 10, 27, 5, 25); // 06:25 in Amsterdam
  const fetcher = jest.fn(async (url) => {
    if (/get_simple_data_table/.test(url)) {
      return { epg_listings: [
        { start: '2026-11-27 04:00:00', start_timestamp: String(start / 1000 - 5100), title: btoa('Before'), has_archive: 1 },
        { start: '2026-11-27 07:25:00', start_timestamp: String(start / 1000 + 60), title: btoa('News'), has_archive: 0 },
      ] };
    }
    return authData();
  });
  const client = new XtreamClient({ baseUrl: 'http://h', username: 'u', password: 'p', fetchJson: fetcher, wrapUrl: (u) => u });
  const list = await client.catchupUrls(128, start, start + 30 * 60000);
  expect(client.lastArchiveInfo).toEqual({ when: '2026-11-27:07-25', hasArchive: false, title: 'News' });
  expect(list[0]).toBe('http://h/timeshift/u/p/30/2026-11-27:07-25/128.ts'); // the server's own writing first
  expect(list[1]).toMatch(/timeshift\.php\?.*start=2026-11-27:07-25/);
  expect(list[2]).toBe('http://h/timeshift/u/p/30/2026-11-27:06-25/128.ts'); // then the declared zone (Europe/Rome in authData)
  expect(new Set(list).size).toBe(list.length);
});
