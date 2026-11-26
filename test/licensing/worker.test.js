/**
 * @jest-environment node
 */
import worker, { check, createRepo, createPayPal, finishPayment } from '../../licensing/worker/src/index.js';

const KEY = 'ABCD-EFGH-JKMN';
const env = { GITHUB_REPO: 'me/licences', GITHUB_TOKEN: 't', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PRICE: '9.99', CURRENCY: 'EUR', TRIAL_DAYS: '30', PAYPAL_SANDBOX: 'true' };

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

/** A fake PayPal REST API: the token, the orders created, their captures. */
function fakePayPal({ captureStatus = 'COMPLETED', value = '9.99', currency = 'EUR', customId = KEY, already = false } = {}) {
  const orders = [];
  const fetchImpl = jest.fn(async (url, options = {}) => {
    const path = String(url).replace('https://api-m.sandbox.paypal.com', '');
    if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'A1', expires_in: 3600 }));
    if (path === '/v2/checkout/orders' && options.method === 'POST') {
      orders.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: 'ORDER1', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }] }), { status: 200 });
    }
    const order = { id: 'ORDER1', status: 'COMPLETED', purchase_units: [{ custom_id: customId, payments: { captures: [{ id: 'CAP1', status: captureStatus, custom_id: customId, amount: { value, currency_code: currency } }] } }] };
    if (/\/capture$/.test(path)) return already ? new Response(JSON.stringify({ details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }), { status: 422 }) : new Response(JSON.stringify(order), { status: 201 });
    return new Response(JSON.stringify(order));
  });
  return { orders, fetchImpl, paypal: createPayPal(env, fetchImpl) };
}

test('pay: an order of the price with the key as custom_id, back to /return; the token asked once', async () => {
  const pp = fakePayPal();
  const href = await pp.paypal.createOrder(KEY, 'https://lic.example');
  expect(href).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER1');
  const unit = pp.orders[0].purchase_units[0];
  expect(unit).toMatchObject({ custom_id: KEY, amount: { currency_code: 'EUR', value: '9.99' } });
  expect(pp.orders[0].payment_source.paypal.experience_context.return_url).toBe('https://lic.example/return');
  await pp.paypal.createOrder(KEY, 'https://lic.example');
  expect(pp.fetchImpl.mock.calls.filter(([u]) => /oauth2/.test(u))).toHaveLength(1);
  expect(pp.fetchImpl.mock.calls[0][1].headers.authorization).toBe(`Basic ${btoa('id:secret')}`);
});

describe('return from PayPal', () => {
  test('a completed capture of the price activates the device, once', async () => {
    const gh = fakeGitHub();
    const pp = fakePayPal();
    expect(await finishPayment('ORDER1', env, gh.repo, pp.paypal)).toEqual({ outcome: 'activated', key: KEY });
    expect(JSON.parse(gh.files.get(`licenses/${KEY}.json`))).toMatchObject({ txn: 'CAP1', order: 'ORDER1', amount: '9.99', currency: 'EUR' });
    expect((await finishPayment('ORDER1', env, gh.repo, fakePayPal({ already: true }).paypal)).outcome).toBe('already active'); // reloaded page
  });

  test('pending, a lower amount, another currency, no device key: nothing written', async () => {
    const gh = fakeGitHub();
    expect((await finishPayment('ORDER1', env, gh.repo, fakePayPal({ captureStatus: 'PENDING' }).paypal)).outcome).toMatch(/^pending/);
    expect((await finishPayment('ORDER1', env, gh.repo, fakePayPal({ value: '1.00' }).paypal)).outcome).toMatch(/^wrong amount/);
    expect((await finishPayment('ORDER1', env, gh.repo, fakePayPal({ currency: 'USD' }).paypal)).outcome).toMatch(/^wrong amount/);
    expect((await finishPayment('ORDER1', env, gh.repo, fakePayPal({ customId: 'other-project' }).paypal)).outcome).toMatch(/^no device key/);
    expect(gh.files.size).toBe(0);
  });
});

test('the worker: CORS for the app, a bad key refused', async () => {
  const options = await worker.fetch(new Request('https://lic.example/check', { method: 'OPTIONS' }), env);
  expect(options.status).toBe(204);
  expect(options.headers.get('access-control-allow-origin')).toBe('*');
  const bad = await worker.fetch(new Request('https://lic.example/check', { method: 'POST', body: JSON.stringify({ key: 'x' }) }), env);
  expect(bad.status).toBe(400);
});
