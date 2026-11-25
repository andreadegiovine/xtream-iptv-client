/*
 * Licence service of the "_trial" builds (docs/LICENSING.md): a Cloudflare worker over a private GitHub repository.
 *
 *   POST /check {key}   the state of a device: { active: true } once paid; otherwise its trial's end { active: false, endsAt, now },
 *                       the trial starting (written to the repository) the first time the key is seen.
 *   GET  /pay?key=      sends the phone to PayPal for this device (one-time payment; the key travels as `custom`).
 *   POST /ipn           PayPal's Instant Payment Notification: checked with PayPal, then the device is written as paid (a refund
 *                       removes it).
 *   GET  /thanks        the page PayPal comes back to.
 *
 * The repository holds one file per device: trials/<KEY>.json (when its trial started) and licenses/<KEY>.json (its payment). The key is
 * a hash of the device's id: no id, no name, no email is stored. The GitHub token lives only here (a secret of the worker).
 *
 * Settings (wrangler.toml / secrets): GITHUB_REPO "owner/name", GITHUB_TOKEN (secret), PAYPAL_EMAIL, PRICE ("9.99"), CURRENCY ("EUR"),
 * ITEM_NAME, TRIAL_DAYS ("30"), PAYPAL_SANDBOX ("true" while testing).
 */
export const KEY_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const DAY_MS = 24 * 3600 * 1000;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
const text = (body, status = 200, type = 'text/plain; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type, ...CORS } });

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
  return { read, create, remove };
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

/** The PayPal page of a one-time payment for `key` (back to /thanks, notification to /ipn). */
export function payPalUrl(key, env, origin) {
  const host = env.PAYPAL_SANDBOX === 'true' ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com';
  const params = new URLSearchParams({
    cmd: '_xclick',
    business: env.PAYPAL_EMAIL,
    item_name: env.ITEM_NAME || 'Xtream IPTV - lifetime activation',
    item_number: key,
    custom: key,
    amount: String(env.PRICE),
    currency_code: env.CURRENCY || 'EUR',
    no_shipping: '1',
    charset: 'utf-8',
    notify_url: `${origin}/ipn`,
    return: `${origin}/thanks?key=${key}`,
    cancel_return: `${origin}/thanks?cancelled=1`,
  });
  return `${host}/cgi-bin/webscr?${params.toString()}`;
}

/**
 * /ipn: PayPal's notification, sent back to PayPal to be confirmed ("VERIFIED"); then a completed payment of the right amount to this
 * account writes the device as paid, a refund or reversal removes it. Resolves with what was done (for the log and the tests).
 */
export async function handleIpn(raw, env, repo, fetchImpl = fetch, now = Date.now()) {
  const verifyHost = env.PAYPAL_SANDBOX === 'true' ? 'https://ipnpb.sandbox.paypal.com' : 'https://ipnpb.paypal.com';
  const res = await fetchImpl(`${verifyHost}/cgi-bin/webscr`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'xtream-iptv-licensing' }, body: `cmd=_notify-validate&${raw}` });
  const answer = (await res.text()).trim();
  if (answer !== 'VERIFIED') return 'not verified';
  const p = new URLSearchParams(raw);
  const key = String(p.get('custom') || '').toUpperCase();
  const receiver = String(p.get('receiver_email') || p.get('business') || '').toLowerCase();
  if (!KEY_PATTERN.test(key)) return 'no device key';
  if (receiver !== String(env.PAYPAL_EMAIL || '').toLowerCase()) return 'another receiver';
  const status = p.get('payment_status');
  if (status === 'Completed') {
    if (p.get('mc_currency') !== (env.CURRENCY || 'EUR') || !(Number(p.get('mc_gross')) >= Number(env.PRICE))) return 'wrong amount';
    const created = await repo.create(`licenses/${key}.json`, { key, txn: p.get('txn_id'), amount: p.get('mc_gross'), currency: p.get('mc_currency'), paidAt: new Date(now).toISOString() }, `Licence ${key}`);
    return created ? 'activated' : 'already active';
  }
  if (status === 'Refunded' || status === 'Reversed') {
    const licence = await repo.read(`licenses/${key}.json`);
    if (licence && licence.value.txn === p.get('parent_txn_id')) {
      await repo.remove(`licenses/${key}.json`, licence.sha, `Refund ${key}`);
      return 'removed';
    }
    return 'nothing to remove';
  }
  return `ignored ${status}`;
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
        if (await repo.read(`licenses/${key}.json`)) return Response.redirect(`${url.origin}/thanks?key=${key}`, 302);
        return Response.redirect(payPalUrl(key, env, url.origin), 302);
      }
      if (url.pathname === '/ipn' && request.method === 'POST') {
        const outcome = await handleIpn(await request.text(), env, repo);
        console.log('IPN', outcome);
        return text('OK');
      }
      if (url.pathname === '/thanks') {
        if (url.searchParams.get('cancelled')) return text(page('Pagamento annullato / Payment cancelled', 'Nessun addebito. / Nothing was charged.'), 200, 'text/html; charset=utf-8');
        return text(page('Grazie! / Thank you!', 'La TV si sblocca da sola in pochi istanti. / The TV unlocks by itself in a few moments.'), 200, 'text/html; charset=utf-8');
      }
      return text('Not found', 404);
    } catch (err) {
      console.log('Error', err && err.message);
      return text('Temporary error', 500); // PayPal sends the notification again later
    }
  },
};
