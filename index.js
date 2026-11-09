/**
 * dsh-opencode-go-quota — Host half.
 *
 * OpenCode Go is a fixed-budget subscription ($12 per rolling 5 hours, $30 per
 * week, $60 per month). Its Zen gateway exposes the consumed share of each
 * window at `GET <base>/usage` (Bearer auth), which returns only
 * status/percent/resetsAt — no dollars and no balance.
 *
 * This half polls that endpoint, caches one sample for `cacheMs`, and serves a
 * normalized snapshot to the browser over a same-origin route. The API key
 * never reaches the client: the browser only sees percentages, reset instants,
 * and the *kind* of credential that matched.
 *
 * Configuration (see cordis.patch.yml): apiKey, authPath, baseUrl, cacheMs,
 * timeoutMs, limits.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Same-origin route the client half reads. */
const ROUTE_PATH = '/api/opencode-go/usage';
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
const DEFAULT_CACHE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Ordered window names the subscription enforces. */
const WINDOW_NAMES = ['rolling', 'weekly', 'monthly'];
const DEFAULT_LIMITS = { rolling: 12, weekly: 30, monthly: 60 };

function asFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value) {
  if (value === null) return null;
  return Math.max(0, Math.min(100, value));
}

function expandHome(target) {
  if (typeof target !== 'string' || target === '') return '';
  if (target === '~') return homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) return join(homedir(), target.slice(2));
  return target;
}

/**
 * Normalize both the shipped `{ usage: { rolling, weekly, monthly } }` body and
 * the earlier proposed `{ windows: [{ name, usagePercent }] }` shape. Unknown
 * fields stay null instead of being invented.
 */
function normalizeUsage(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : {};
  const scoped = root.usage !== null && typeof root.usage === 'object' ? root.usage : root;
  const legacy = Array.isArray(scoped.windows) ? scoped.windows
    : Array.isArray(root.windows) ? root.windows
      : null;
  const windows = {};
  for (const name of WINDOW_NAMES) {
    let raw = scoped[name];
    if ((raw === undefined || raw === null) && legacy !== null) {
      raw = legacy.find((item) => String(item?.name ?? item?.window ?? '').toLowerCase() === name);
    }
    if (raw === null || typeof raw !== 'object') {
      windows[name] = null;
      continue;
    }
    const percent = clampPercent(asFiniteNumber(raw.percent ?? raw.usagePercent ?? raw.usedPercent ?? raw.used_percent));
    const resetsAt = typeof raw.resetsAt === 'string' ? raw.resetsAt
      : typeof raw.resetAt === 'string' ? raw.resetAt
        : typeof raw.reset_at === 'string' ? raw.reset_at
          : null;
    windows[name] = {
      status: typeof raw.status === 'string' ? raw.status : null,
      percent,
      remainingPercent: percent === null ? null : Math.round((100 - percent) * 100) / 100,
      resetsAt,
      used: asFiniteNumber(raw.used ?? raw.spent),
      limit: asFiniteNumber(raw.limit ?? raw.total),
      resetInSec: asFiniteNumber(raw.resetInSec ?? raw.reset_in_sec),
    };
  }
  return windows;
}

/** Pick the Go key out of OpenCode's auth file, whose entries are provider-keyed. */
function pickAuthEntry(parsed) {
  if (parsed === null || typeof parsed !== 'object') return '';
  const keys = Object.keys(parsed);
  const ranked = [
    keys.filter((key) => /^opencode[-_]?go$/i.test(key)),
    keys.filter((key) => /^opencode$/i.test(key)),
    keys.filter((key) => /opencode/i.test(key)),
  ];
  for (const bucket of ranked) {
    for (const key of bucket) {
      const value = parsed[key];
      const candidate = typeof value === 'string' ? value
        : value !== null && typeof value === 'object'
          ? value.key ?? value.apiKey ?? value.access ?? value.token ?? ''
          : '';
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    }
  }
  return '';
}

export const inject = ['webServer'];

export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {};
  const baseUrl = (typeof settings.baseUrl === 'string' && settings.baseUrl.trim() !== ''
    ? settings.baseUrl.trim()
    : DEFAULT_BASE_URL).replace(/\/+$/, '');
  const cacheMs = Number.isSafeInteger(settings.cacheMs) && settings.cacheMs >= 1000 ? settings.cacheMs : DEFAULT_CACHE_MS;
  const timeoutMs = Number.isSafeInteger(settings.timeoutMs) && settings.timeoutMs >= 1000 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS;
  const configuredKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';
  const limits = {
    rolling: asFiniteNumber(settings.limits?.rolling) ?? DEFAULT_LIMITS.rolling,
    weekly: asFiniteNumber(settings.limits?.weekly) ?? DEFAULT_LIMITS.weekly,
    monthly: asFiniteNumber(settings.limits?.monthly) ?? DEFAULT_LIMITS.monthly,
  };

  /** Last completed sample; kept across failures so the UI can show stale data. */
  let sample = null;
  /** In-flight sample so concurrent reads share one upstream request. */
  let inflight = null;
  let disposed = false;

  ctx.effect(() => () => {
    disposed = true;
    sample = null;
    inflight = null;
  }, 'dsh-opencode-go-quota: teardown');

  const log = (level, message, error) => {
    const logger = ctx.logger;
    const text = `opencode-go-quota: ${message}`;
    if (logger && typeof logger[level] === 'function') {
      if (error instanceof Error) logger[level](`${text}: %s`, error.message);
      else logger[level](text);
      return;
    }
    if (level === 'warn' || level === 'error') console.warn(text, error instanceof Error ? error.message : '');
  };

  /** Resolve the Go key through the Host's credential seam, when one is mounted. */
  async function resolveFromCredentials() {
    let service = null;
    try {
      service = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials;
    } catch {
      service = null;
    }
    if (!service || typeof service.resolve !== 'function') return null;
    for (const name of ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']) {
      try {
        const resolved = await service.resolve(name);
        if (resolved && typeof resolved.value === 'string' && resolved.value.trim() !== '') {
          // `source` names the credential layer (env/file/user-env); the reference
          // name is what the operator wrote in the configuration.
          return { key: resolved.value.trim(), source: name };
        }
      } catch (error) {
        log('warn', `credential ${name} could not be resolved`, error);
      }
    }
    return null;
  }

  /** Resolve the Go key: config, then the Host's credential store, then env, then auth.json. */
  async function resolveCredentials() {
    if (configuredKey !== '') return { key: configuredKey, source: 'config' };
    const fromStore = await resolveFromCredentials();
    if (fromStore !== null) return { key: fromStore.key, source: `credentials:${fromStore.source}` };
    for (const name of ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']) {
      const value = process.env[name];
      if (typeof value === 'string' && value.trim() !== '') return { key: value.trim(), source: `env:${name}` };
    }
    const candidates = [];
    if (typeof settings.authPath === 'string' && settings.authPath.trim() !== '') {
      candidates.push(expandHome(settings.authPath.trim()));
    } else {
      const fromEnv = process.env.OPENCODE_AUTH_PATH;
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(expandHome(fromEnv.trim()));
      candidates.push(join(homedir(), '.local', 'share', 'opencode', 'auth.json'));
      candidates.push(join(homedir(), '.config', 'opencode', 'auth.json'));
    }
    for (const file of candidates) {
      try {
        const text = await readFile(file, 'utf8');
        const key = pickAuthEntry(JSON.parse(text));
        if (key !== '') return { key, source: 'auth.json' };
      } catch {
        // Missing or unreadable file: keep looking, never surface the path body.
      }
    }
    return { key: '', source: null };
  }

  /** One upstream attempt; returns either usage windows or a typed failure. */
  async function fetchUsage(key) {
    const endpoint = `${baseUrl}/usage`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        const unauthorized = response.status === 401 || response.status === 403;
        return {
          ok: false,
          code: unauthorized ? 'unauthorized' : `http_${response.status}`,
          status: response.status,
          message: unauthorized
            ? 'OpenCode Go rejected the API key'
            : `OpenCode Go answered HTTP ${response.status}`,
        };
      }
      let body = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        return { ok: false, code: 'bad_payload', message: 'OpenCode Go returned a non-JSON body' };
      }
      const windows = normalizeUsage(body);
      if (WINDOW_NAMES.every((name) => windows[name] === null)) {
        return { ok: false, code: 'bad_payload', message: 'OpenCode Go returned no usage windows' };
      }
      return { ok: true, windows };
    } catch (error) {
      const aborted = error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
      return {
        ok: false,
        code: aborted ? 'timeout' : 'network',
        message: aborted ? 'OpenCode Go did not answer in time' : 'OpenCode Go is unreachable',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function buildSample() {
    const at = Date.now();
    const credential = await resolveCredentials();
    if (credential.key === '') {
      const failure = {
        at,
        ok: false,
        code: 'no_key',
        message: 'No OpenCode Go API key',
        windows: sample?.windows ?? null,
        keySource: null,
      };
      log('warn', 'no API key found (config, OPENCODE_GO_API_KEY, or ~/.local/share/opencode/auth.json)');
      return failure;
    }
    const result = await fetchUsage(credential.key);
    if (!result.ok) {
      log(result.code === 'unauthorized' ? 'warn' : 'warn', `${result.code}: ${result.message}`);
      return {
        at,
        ok: false,
        code: result.code,
        status: result.status ?? null,
        message: result.message,
        windows: sample?.windows ?? null,
        keySource: credential.source,
      };
    }
    return { at, ok: true, code: null, message: null, windows: result.windows, keySource: credential.source };
  }

  async function readSample(force) {
    if (!force && sample !== null && Date.now() - sample.at < cacheMs) return sample;
    if (inflight !== null) return inflight;
    inflight = buildSample()
      .then((next) => {
        if (!disposed) sample = next;
        return next;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /** Public snapshot: no key, no key material, only what the UI can render. */
  function toView(current) {
    const now = Date.now();
    return {
      ok: current.ok,
      plan: 'go',
      endpoint: `${baseUrl}/usage`,
      limits,
      windows: current.windows,
      fetchedAt: new Date(current.at).toISOString(),
      ageMs: Math.max(0, now - current.at),
      stale: !current.ok && current.windows !== null && WINDOW_NAMES.some((name) => current.windows?.[name] != null),
      keySource: current.keySource ?? null,
      error: current.ok ? null : { code: current.code, status: current.status ?? null, message: current.message },
    };
  }

  const handler = async (req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let force = false;
    try {
      const url = new URL(req.url ?? ROUTE_PATH, 'http://localhost');
      const refresh = url.searchParams.get('refresh');
      force = refresh === '1' || refresh === 'true';
    } catch {
      force = false;
    }
    const body = JSON.stringify(toView(await readSample(force)));
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(method === 'HEAD' ? undefined : body);
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }), 'dsh-opencode-go-quota: usage route');
}
