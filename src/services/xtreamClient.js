import { fetchJson } from '../core/http.js';
import { wrapApiUrl } from '../core/env.js';
import { AppError, ErrorCode } from '../core/errors.js';
import { MediaType } from './mediaType.js';

export { MediaType };

const CATEGORY_ACTIONS = {
  [MediaType.MOVIE]: 'get_vod_categories',
  [MediaType.SERIES]: 'get_series_categories',
  [MediaType.LIVE]: 'get_live_categories',
};
const STREAM_ACTIONS = {
  [MediaType.MOVIE]: 'get_vod_streams',
  [MediaType.SERIES]: 'get_series',
  [MediaType.LIVE]: 'get_live_streams',
};
const STREAM_PATH = {
  [MediaType.MOVIE]: 'movie',
  [MediaType.SERIES]: 'series',
  [MediaType.LIVE]: 'live',
};

/** "host:8080/player_api.php?x" -> "http://host:8080". Keeps a sub-path if the panel lives under one. */
export function normalizeBaseUrl(input) {
  let value = String(input ?? '').trim();
  if (!value) throw new AppError(ErrorCode.INVALID_INPUT, 'URL is empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Invalid URL', { cause });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Only http and https are supported');
  }
  const path = url.pathname.replace(/\/(?:player_api|get|panel_api|xmltv)\.php$/i, '').replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Live format: HLS when allowed (or unknown), otherwise TS, otherwise whatever the account allows. */
export function pickLiveFormat(allowed) {
  const list = Array.isArray(allowed) ? allowed.map((f) => String(f).toLowerCase()) : [];
  if (list.length === 0 || list.includes('m3u8')) return 'm3u8';
  if (list.includes('ts')) return 'ts';
  return list[0];
}

/** An instant as the timeshift addresses want it, "YYYY-MM-DD:HH-MM", in a time zone (an IANA name; UTC when empty or unknown). */
export function timeshiftStart(ms, timeZone = '') {
  const date = new Date(ms);
  let parts = null;
  if (timeZone) {
    try {
      const out = {};
      new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(date)
        .forEach((p) => {
          out[p.type] = p.value;
        });
      parts = out;
    } catch {
      parts = null; // a zone this device does not know
    }
  }
  if (!parts) {
    const two = (n) => String(n).padStart(2, '0');
    parts = { year: String(date.getUTCFullYear()), month: two(date.getUTCMonth() + 1), day: two(date.getUTCDate()), hour: two(date.getUTCHours()), minute: two(date.getUTCMinutes()) };
  }
  return `${parts.year}-${parts.month}-${parts.day}:${parts.hour === '24' ? '00' : parts.hour}-${parts.minute}`;
}

/** The catch-up addresses of a stream (see XtreamClient.catchupUrls). */
export function catchupAddresses({ baseUrl, username, password, timezone = '', id, start, stop }) {
  const minutes = Math.max(1, Math.ceil((stop - start) / 60000));
  const when = timeshiftStart(start, timezone);
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  const path = `${baseUrl}/timeshift/${user}/${pass}/${minutes}/${when}/${id}`;
  return [`${path}.ts`, `${baseUrl}/streaming/timeshift.php?username=${user}&password=${pass}&stream=${id}&start=${when}&duration=${minutes}`, `${path}.m3u8`];
}

export function decodeBase64Utf8(value) {
  const text = String(value ?? '');
  try {
    return decodeURIComponent(escape(atob(text)));
  } catch {
    try {
      return atob(text);
    } catch {
      return text;
    }
  }
}

export function parseAuthResponse(data, now = Date.now()) {
  const user = data && data.user_info;
  if (!user || Number(user.auth) !== 1) throw new AppError(ErrorCode.AUTH_FAILED, 'Authentication failed');
  const status = String(user.status ?? '').toLowerCase();
  if (status === 'banned' || status === 'disabled') {
    throw new AppError(ErrorCode.ACCOUNT_DISABLED, 'Account disabled');
  }
  const expSeconds = Number(user.exp_date);
  const expiresAt = Number.isFinite(expSeconds) && expSeconds > 0 ? expSeconds * 1000 : null;
  if (status === 'expired' || (expiresAt !== null && expiresAt < now)) {
    throw new AppError(ErrorCode.ACCOUNT_EXPIRED, 'Account expired', { details: { expiresAt } });
  }
  const server = data.server_info || {};
  return {
    user: {
      username: String(user.username ?? ''),
      status: user.status ?? '',
      expiresAt,
      maxConnections: Number(user.max_connections) || null,
      activeConnections: Number(user.active_cons) || 0,
      allowedFormats: Array.isArray(user.allowed_output_formats) ? user.allowed_output_formats : [],
    },
    server: {
      url: server.url ?? '',
      port: server.port ?? '',
      httpsPort: server.https_port ?? '',
      protocol: server.server_protocol ?? '',
      timezone: server.timezone ?? '',
      timeNow: server.time_now ?? '',
    },
  };
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && data.user_info) throw new AppError(ErrorCode.AUTH_FAILED, 'Authentication failed');
  return [];
}

export class XtreamClient {
  constructor({ baseUrl, username, password, fetchJson: fetcher = fetchJson, wrapUrl = wrapApiUrl }) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
    this.fetcher = fetcher;
    this.wrapUrl = wrapUrl;
    this.allowedFormats = [];
  }

  apiUrl(action, params = {}) {
    const query = new URLSearchParams({ username: this.username, password: this.password });
    if (action) query.set('action', action);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== null && value !== undefined) query.set(key, String(value));
    });
    return `${this.baseUrl}/player_api.php?${query.toString()}`;
  }

  request(action, params, options) {
    return this.fetcher(this.wrapUrl(this.apiUrl(action, params)), options);
  }

  async authenticate() {
    const auth = parseAuthResponse(await this.request(null, {}, { timeoutMs: 15000 }));
    this.allowedFormats = auth.user.allowedFormats;
    this.timezone = auth.server.timezone || '';
    this.authenticated = true;
    return auth;
  }

  /**
   * The addresses of a past programme of a live channel (catch-up), the most common first: panels differ, the player tries the next one
   * when one fails. The start is written in the provider's time zone (its `server_info.timezone`; UTC when it gives none or one this
   * device does not know).
   *   /timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<id>.ts      (most panels serve the archive as MPEG-TS only)
   *   /streaming/timeshift.php?username=&password=&stream=&start=&duration=
   *   /timeshift/…/<id>.m3u8                                            (the panels that offer it as HLS)
   */
  async catchupUrls(id, start, stop) {
    if (!this.authenticated) await this.authenticate();
    return catchupAddresses({ baseUrl: this.baseUrl, username: this.username, password: this.password, timezone: this.timezone, id, start, stop });
  }

  /** The first of catchupUrls. */
  async catchupUrl(id, start, stop) {
    return (await this.catchupUrls(id, start, stop))[0];
  }

  async getCategories(type, { signal } = {}) {
    return asArray(await this.request(CATEGORY_ACTIONS[type], {}, { timeoutMs: 30000, signal }));
  }

  async getStreams(type, { categoryId, signal } = {}) {
    // Full catalogs can be tens of MB on a slow link: generous timeout, no retry storm.
    const data = await this.request(STREAM_ACTIONS[type], { category_id: categoryId }, { timeoutMs: 120000, signal });
    return asArray(data);
  }

  getVodInfo(vodId) {
    return this.request('get_vod_info', { vod_id: vodId }, { timeoutMs: 15000 });
  }

  getSeriesInfo(seriesId) {
    return this.request('get_series_info', { series_id: seriesId }, { timeoutMs: 15000 });
  }

  /** Returns [{ id, title, description, start, stop }] with epoch milliseconds. */
  async getShortEpg(streamId, limit = 10) {
    const data = await this.request('get_short_epg', { stream_id: streamId, limit }, { timeoutMs: 15000 });
    const listings = data && Array.isArray(data.epg_listings) ? data.epg_listings : [];
    return listings
      .map((l) => ({
        id: String(l.id ?? ''),
        title: decodeBase64Utf8(l.title),
        description: decodeBase64Utf8(l.description),
        start: Number(l.start_timestamp) * 1000,
        stop: Number(l.stop_timestamp) * 1000,
      }))
      .filter((l) => Number.isFinite(l.start) && Number.isFinite(l.stop));
  }

  streamUrl(type, id, ext) {
    const extension = ext || (type === MediaType.LIVE ? pickLiveFormat(this.allowedFormats) : 'mp4');
    const user = encodeURIComponent(this.username);
    const pass = encodeURIComponent(this.password);
    return `${this.baseUrl}/${STREAM_PATH[type]}/${user}/${pass}/${id}.${extension}`;
  }
}
