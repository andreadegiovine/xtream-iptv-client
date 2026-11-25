/**
 * @jest-environment node
 */
import worker, { check, handleIpn, payPalUrl, createRepo } from '../../licensing/worker/src/index.js';

const KEY = 'ABCD-EFGH-JKMN';
const env = { GITHUB_REPO: 'me/licences', GITHUB_TOKEN: 't', PAYPAL_EMAIL: 'Pay@Example.com', PRICE: '9.99', CURRENCY: 'EUR', TRIAL_DAYS: '30', PAYPAL_SANDBOX: 'true' };

/** A fake repository: the files in a Map, with the contents API's answers. */
function fakeGitHub() {
  const files = new Map();
  const b64 = (s) => Buffer.from(s).toString('base64');
  const fetchImpl = jest.fn(async (url, options = {}) => {
    const path = decodeURIComponent(String(url).split('/contents/')[1]);
    const method = options.method || 'GET';
    if (method === 'GET') return files.has(path) ? new Response(JSON.stringify({ sha: 'sha1', content: b64(files.get(path)) })) : new Response('', { status: 404 });
    if (method === 'PUT') {
      if (files.has(path)) return new Response('', { status: 422 });
      files.set(path, Buffer.from(JSON.parse(options.body).content, 'base64').toString());
      return new Response('{}', { status: 201 });
    }
    files.delete(path);
    return new Response('{}');
  });
  return { files, repo: createRepo(env, fetchImpl), fetchImpl };
}

test('check: the first request starts the trial, the next ones read it; a paid key is active', async () => {
  const gh = fakeGitHub();
  const t0 = Date.UTC(2026, 10, 1);
  const first = await check(KEY, env, gh.repo, t0);
  expect(first).toEqual({ active: false, endsAt: t0 + 30 * 86400000, now: t0 });
  expect(JSON.parse(gh.files.get(`trials/${KEY}.json`)).startedAt).toBe(new Date(t0).toISOString());
  const later = await check(KEY, env, gh.repo, t0 + 86400000);
  expect(later.endsAt).toBe(first.endsAt); // reinstalling the app does not start it again
  gh.files.set(`licenses/${KEY}.json`, JSON.stringify({ key: KEY }));
  expect(await check(KEY, env, gh.repo)).toEqual({ active: true });
});

test('pay: PayPal with the key as custom and the notification address', () => {
  const url = new URL(payPalUrl(KEY, env, 'https://lic.example'));
  expect(url.origin).toBe('https://www.sandbox.paypal.com');
  expect(url.searchParams.get('custom')).toBe(KEY);
  expect(url.searchParams.get('amount')).toBe('9.99');
  expect(url.searchParams.get('notify_url')).toBe('https://lic.example/ipn');
});

describe('IPN', () => {
  const ipn = (fields) => new URLSearchParams({ receiver_email: 'pay@example.com', custom: KEY, payment_status: 'Completed', mc_gross: '9.99', mc_currency: 'EUR', txn_id: 'TX1', ...fields }).toString();
  const payPal = (verdict) => jest.fn(async () => new Response(verdict));

  test('a verified payment of the right amount activates the device, once', async () => {
    const gh = fakeGitHub();
    const verify = payPal('VERIFIED');
    expect(await handleIpn(ipn({}), env, gh.repo, verify)).toBe('activated');
    expect(verify.mock.calls[0][0]).toBe('https://ipnpb.sandbox.paypal.com/cgi-bin/webscr');
    expect(verify.mock.calls[0][1].body.startsWith('cmd=_notify-validate&')).toBe(true);
    expect(JSON.parse(gh.files.get(`licenses/${KEY}.json`)).txn).toBe('TX1');
    expect(await handleIpn(ipn({}), env, gh.repo, verify)).toBe('already active');
  });

  test('not verified, another receiver, a lower amount or another currency: nothing written', async () => {
    const gh = fakeGitHub();
    expect(await handleIpn(ipn({}), env, gh.repo, payPal('INVALID'))).toBe('not verified');
    expect(await handleIpn(ipn({ receiver_email: 'x@y.z' }), env, gh.repo, payPal('VERIFIED'))).toBe('another receiver');
    expect(await handleIpn(ipn({ mc_gross: '1.00' }), env, gh.repo, payPal('VERIFIED'))).toBe('wrong amount');
    expect(await handleIpn(ipn({ mc_currency: 'USD' }), env, gh.repo, payPal('VERIFIED'))).toBe('wrong amount');
    expect(await handleIpn(ipn({ custom: 'nope' }), env, gh.repo, payPal('VERIFIED'))).toBe('no device key');
    expect(gh.files.size).toBe(0);
  });

  test('a refund of that payment removes the activation', async () => {
    const gh = fakeGitHub();
    await handleIpn(ipn({}), env, gh.repo, payPal('VERIFIED'));
    expect(await handleIpn(ipn({ payment_status: 'Refunded', parent_txn_id: 'OTHER' }), env, gh.repo, payPal('VERIFIED'))).toBe('nothing to remove');
    expect(await handleIpn(ipn({ payment_status: 'Refunded', parent_txn_id: 'TX1' }), env, gh.repo, payPal('VERIFIED'))).toBe('removed');
    expect(gh.files.has(`licenses/${KEY}.json`)).toBe(false);
  });
});

test('the worker: CORS for the app, a bad key refused', async () => {
  const options = await worker.fetch(new Request('https://lic.example/check', { method: 'OPTIONS' }), env);
  expect(options.status).toBe(204);
  expect(options.headers.get('access-control-allow-origin')).toBe('*');
  const bad = await worker.fetch(new Request('https://lic.example/check', { method: 'POST', body: JSON.stringify({ key: 'x' }) }), env);
  expect(bad.status).toBe(400);
});
