/*
 * Licence service of the "_trial" builds (docs/LICENSING.md): a Cloudflare worker over a private GitHub repository and PayPal's Orders
 * API (an app of its own: the PayPal account and its other projects are not touched).
 *
 *   POST /check {key}   the state of a device: { active: true } once paid; otherwise its trial's end { active: false, endsAt, now },
 *                       the trial starting (written to the repository) the first time the key is seen.
 *   GET  /pay?key=      creates a PayPal order for this device (one-time payment; the key travels as the order's custom_id) and sends
 *                       the phone to PayPal.
 *   GET  /return        PayPal sends the phone back here (?token=<order>): the worker captures the payment itself, checks it and writes
 *                       the device as paid. No notification from PayPal is needed.
 *   GET  /thanks        the page of a cancelled payment.
 *   GET  /health        the settings in use (never a secret), whether the GitHub repository and PayPal can be reached: for the setup.
 *
 * The repository holds one file per device: trials/<KEY>.json (when its trial started) and licenses/<KEY>.json (its payment). The key is
 * a hash of the device's id: no id, no name, no email is stored. The GitHub token and the PayPal secret live only here.
 *
 * Settings (wrangler.toml / the dashboard): GITHUB_REPO "owner/name", GITHUB_TOKEN (secret), PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
 * (secret), PRICE ("11.50"), CURRENCY ("EUR"), ITEM_NAME, TRIAL_DAYS ("30"), PAYPAL_SANDBOX ("true" while testing).
 */
export const KEY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const DAY_MS = 24 * 3600 * 1000;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
const text = (body, status = 200, type = 'text/plain; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type, ...CORS } });
const html = (body, status = 200) => text(body, status, 'text/html; charset=utf-8');

function toBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}
function fromBase64(value) {
  const binary = atob(String(value).replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The files of the repository through GitHub's contents API: read (null when missing), create (false when it exists), delete. */
export function createRepo(env, fetchImpl = fetch) {
  const base = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/`;
  const headers = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'xtream-iptv-licensing', 'x-github-api-version': '2022-11-28' };
  async function read(path) {
    const res = await fetchImpl(base + path, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} reading ${path}`);
    const body = await res.json();
    return { sha: body.sha, value: JSON.parse(fromBase64(body.content)) };
  }
  async function create(path, value, message) {
    const res = await fetchImpl(base + path, { method: 'PUT', headers, body: JSON.stringify({ message, content: toBase64(`${JSON.stringify(value, null, 2)}\n`) }) });
    if (res.status === 422) return false; // already there (two requests at once): the first one wins
    if (!res.ok) throw new Error(`GitHub ${res.status} writing ${path}`);
    return true;
  }
  async function remove(path, sha, message) {
    const res = await fetchImpl(base + path, { method: 'DELETE', headers, body: JSON.stringify({ message, sha }) });
    if (!res.ok && res.status !== 404) throw new Error(`GitHub ${res.status} deleting ${path}`);
  }
  /** The repository itself (GET /health): its name and whether the token may write to it. */
  async function info() {
    const res = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}`, { headers });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();
    return { ok: true, private: Boolean(body.private), push: Boolean(body.permissions && body.permissions.push), branch: body.default_branch };
  }
  return { read, create, remove, info };
}

/** /check: paid, or the trial's end (started now the first time). */
export async function check(key, env, repo, now = Date.now()) {
  if (await repo.read(`licenses/${key}.json`)) return { active: true };
  const days = Number(env.TRIAL_DAYS || 30);
  let trial = await repo.read(`trials/${key}.json`);
  if (!trial) {
    const created = await repo.create(`trials/${key}.json`, { key, startedAt: new Date(now).toISOString() }, `Trial ${key}`);
    trial = created ? { value: { startedAt: new Date(now).toISOString() } } : await repo.read(`trials/${key}.json`);
  }
  const started = Date.parse(trial.value.startedAt);
  return { active: false, endsAt: started + days * DAY_MS, now };
}

/** PayPal's REST API with the app's credentials: an access token (kept until it expires), create an order, capture it, read it. */
export function createPayPal(env, fetchImpl = fetch, now = () => Date.now()) {
  const base = env.PAYPAL_SANDBOX === 'true' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  let cached = null; // { token, until }
  async function token() {
    if (cached && cached.until > now()) return cached.token;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal ${res.status} on the access token`);
    const body = await res.json();
    cached = { token: body.access_token, until: now() + Math.max(0, (Number(body.expires_in) || 0) - 60) * 1000 };
    return cached.token;
  }
  async function call(method, path, body) {
    const res = await fetchImpl(base + path, { method, headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const answer = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body: answer };
  }
  return {
    token,
    /** A one-time payment of PRICE for `key`; resolves with the address of PayPal's page. */
    async createOrder(key, origin) {
      const res = await call('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: key, custom_id: key, description: env.ITEM_NAME || 'Xtream IPTV - lifetime activation', amount: { currency_code: env.CURRENCY || 'EUR', value: String(env.PRICE) } }],
        payment_source: { paypal: { experience_context: { brand_name: 'Xtream IPTV', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: `${origin}/return`, cancel_url: `${origin}/thanks?cancelled=1` } } },
      });
      if (!res.ok) throw new Error(`PayPal ${res.status} creating the order`);
      const link = (res.body.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
      if (!link) throw new Error('PayPal gave no payment page');
      return link.href;
    },
    /** Captures an approved order (an order captured already is read instead): the order as PayPal describes it. */
    async capture(orderId) {
      const res = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});
      if (res.ok) return res.body;
      const issue = ((res.body && res.body.details) || []).map((d) => d.issue).join(',');
      if (res.status === 422 && /ORDER_ALREADY_CAPTURED/.test(issue)) {
        const again = await call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
        if (again.ok) return again.body;
      }
      throw new Error(`PayPal ${res.status} capturing ${orderId}${issue ? ` (${issue})` : ''}`);
    },
  };
}

/**
 * /return: the order is captured; a completed capture of PRICE in CURRENCY for a device key writes its licence (once). Resolves with
 * { outcome, key } (outcome: 'activated', 'already active', 'pending', or why nothing was written).
 */
export async function finishPayment(orderId, env, repo, paypal, now = Date.now()) {
  const order = await paypal.capture(orderId);
  const unit = (order.purchase_units || [])[0] || {};
  const capture = ((unit.payments && unit.payments.captures) || [])[0] || {};
  const key = String(capture.custom_id || unit.custom_id || '').toUpperCase();
  if (!KEY_PATTERN.test(key)) return { outcome: `no device key (custom_id "${capture.custom_id || unit.custom_id || ''}")`, key: null };
  if (capture.status === 'PENDING') return { outcome: `pending (${(capture.status_details && capture.status_details.reason) || 'no reason'})`, key };
  if (capture.status !== 'COMPLETED') return { outcome: `not completed (${capture.status || order.status})`, key };
  const amount = capture.amount || {};
  if (amount.currency_code !== (env.CURRENCY || 'EUR') || !(Number(amount.value) >= Number(env.PRICE))) {
    return { outcome: `wrong amount (${amount.value} ${amount.currency_code}, expected ${env.PRICE} ${env.CURRENCY || 'EUR'})`, key };
  }
  const created = await repo.create(`licenses/${key}.json`, { key, txn: capture.id, order: order.id || orderId, amount: amount.value, currency: amount.currency_code, paidAt: new Date(now).toISOString() }, `Licence ${key}`);
  return { outcome: created ? 'activated' : 'already active', key };
}

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#141414;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:24px}p{color:#bbb}</style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const repo = createRepo(env);
    try {
      if (url.pathname === '/check' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const key = String((body && body.key) || '').toUpperCase();
        if (!KEY_PATTERN.test(key)) return json({ error: 'bad key' }, 400);
        return json(await check(key, env, repo));
      }
      if (url.pathname === '/pay' && request.method === 'GET') {
        const key = String(url.searchParams.get('key') || '').toUpperCase();
        if (!KEY_PATTERN.test(key)) return text('Bad device key', 400);
        if (await repo.read(`licenses/${key}.json`)) return html(page('Già attivato / Already activated', 'Questo dispositivo è già attivo. / This device is already activated.'));
        return Response.redirect(await createPayPal(env).createOrder(key, url.origin), 302);
      }
      if (url.pathname === '/return' && request.method === 'GET') {
        const orderId = String(url.searchParams.get('token') || '');
        if (!/^[A-Z0-9]{5,40}$/.test(orderId)) return text('Bad order', 400);
        const { outcome } = await finishPayment(orderId, env, repo, createPayPal(env));
        console.log(`Payment ${orderId}:`, outcome);
        if (outcome === 'activated' || outcome === 'already active') return html(page('Grazie! / Thank you!', 'Il dispositivo è attivato: la TV si sblocca da sola in pochi istanti. / The device is activated: the TV unlocks by itself in a few moments.'));
        if (/^pending/.test(outcome)) return html(page('Pagamento in verifica / Payment under review', 'PayPal sta ancora verificando il pagamento: riapri il codice QR più tardi. / PayPal is still reviewing the payment: open the QR code again later.'));
        return html(page('Pagamento non completato / Payment not completed', 'Nessuna attivazione: riprova dal codice QR. / Nothing was activated: try again from the QR code.'), 400);
      }
      if (url.pathname === '/health') {
        const github = await repo.info().catch((err) => ({ ok: false, error: err && err.message }));
        const paypal = await createPayPal(env)
          .token()
          .then(() => ({ ok: true }))
          .catch((err) => ({ ok: false, error: err && err.message }));
        return json({ repo: env.GITHUB_REPO || null, token: Boolean(env.GITHUB_TOKEN), github, paypal: { ...paypal, clientId: Boolean(env.PAYPAL_CLIENT_ID), secret: Boolean(env.PAYPAL_CLIENT_SECRET) }, price: env.PRICE || null, currency: env.CURRENCY || 'EUR', trialDays: Number(env.TRIAL_DAYS || 30), sandbox: env.PAYPAL_SANDBOX === 'true' });
      }
      if (url.pathname === '/thanks') return html(page('Pagamento annullato / Payment cancelled', 'Nessun addebito. / Nothing was charged.'));
      return text('Not found', 404);
    } catch (err) {
      console.error(`Error on ${url.pathname}:`, err && err.message);
      return text('Temporary error', 500);
    }
  },
};
