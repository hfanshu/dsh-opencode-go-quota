/**
 * Host-half smoke test: credential resolution, both upstream payload shapes,
 * caching, and the route contract. No network: `fetch` is injected.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply } = await import('../index.js');

/** Minimal ctx: one webServer route, effects we can release, a quiet logger. */
function createCtx({ credentials = null } = {}) {
  const routes = [];
  const disposers = [];
  return {
    ctx: {
      webServer: {
        register(route) {
          routes.push(route);
          const dispose = () => {
            const index = routes.indexOf(route);
            if (index >= 0) routes.splice(index, 1);
          };
          return dispose;
        },
      },
      get(name) {
        return name === 'credentials' ? credentials : undefined;
      },
      effect(fn) {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
        return dispose;
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    routes,
    disposeAll: () => disposers.splice(0).forEach((fn) => fn()),
  };
}

/** Call the registered route handler with a fake request/response pair. */
function callRoute(route, url = '/api/opencode-go/usage') {
  return new Promise((resolve) => {
    const chunks = [];
    const headers = {};
    const res = {
      writeHead(status, extra) {
        headers.status = status;
        headers.extra = extra;
      },
      end(body) {
        if (body !== undefined) chunks.push(body);
        resolve({ status: headers.status, headers: headers.extra, body: JSON.parse(chunks.join('')) });
      },
    };
    route.handler({ method: 'GET', url }, res);
  });
}

function stubFetch(payload, { status = 200, seen = [] } = {}) {
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  };
  return seen;
}

test('normalizes the shipped usage shape and exposes remaining share', async () => {
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  const seen = stubFetch({
    usage: {
      rolling: { status: 'ok', percent: 52, resetsAt: '2026-09-23T00:34:52.704Z' },
      weekly: { status: 'ok', percent: 20, resetsAt: '2026-09-28T00:00:00.000Z' },
      monthly: { status: 'ok', percent: 61.5, resetsAt: '2026-09-25T14:30:41.000Z' },
    },
  });
  const { ctx, routes } = createCtx();
  apply(ctx, { apiKey: 'sk-test', cacheMs: 60000 });

  const response = await callRoute(routes[0]);
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.windows.rolling.percent, 52);
  assert.equal(response.body.windows.rolling.remainingPercent, 48);
  assert.equal(response.body.windows.monthly.remainingPercent, 38.5);
  assert.equal(response.body.keySource, 'config');
  assert.equal(response.body.error, null);
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/usage$/);
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-test');
  // The key never leaves the Host.
  assert.equal(JSON.stringify(response.body).includes('sk-test'), false);
});

test('parses the legacy windows[] shape and caches one upstream sample', async () => {
  const seen = stubFetch({
    windows: [
      { name: 'rolling', status: 'ok', usagePercent: 30 },
      { name: 'weekly', status: 'ok', usagePercent: 10 },
    ],
  });
  const { ctx, routes } = createCtx();
  apply(ctx, { apiKey: 'sk-test', cacheMs: 60000 });

  const first = await callRoute(routes[0]);
  const second = await callRoute(routes[0]);
  assert.equal(first.body.windows.rolling.remainingPercent, 70);
  assert.equal(first.body.windows.weekly.remainingPercent, 90);
  assert.equal(first.body.windows.monthly, null);
  assert.equal(seen.length, 1, 'second read is served from the cache');
  assert.deepEqual(second.body.windows, first.body.windows);
});

test('401 becomes unauthorized, and the previous windows stay as stale data', async () => {
  const { ctx, routes } = createCtx();
  stubFetch({ usage: { rolling: { status: 'ok', percent: 40 } } });
  apply(ctx, { apiKey: 'sk-test', cacheMs: 1 });
  const healthy = await callRoute(routes[0]);
  assert.equal(healthy.body.ok, true);

  stubFetch({ error: 'nope' }, { status: 401 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const rejected = await callRoute(routes[0], '/api/opencode-go/usage?refresh=1');
  assert.equal(rejected.body.ok, false);
  assert.equal(rejected.body.error.code, 'unauthorized');
  assert.equal(rejected.body.stale, true);
  assert.equal(rejected.body.windows.rolling.percent, 40);
});

test('a missing key reports no_key without calling upstream', async () => {
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  const seen = stubFetch({ usage: {} });
  const dir = await mkdtemp(join(tmpdir(), 'ogq-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ other: { type: 'api', key: 'zzz' } }), 'utf8');

  const { ctx, routes } = createCtx();
  apply(ctx, { authPath });
  const response = await callRoute(routes[0]);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, 'no_key');
  assert.equal(response.body.keySource, null);
  assert.equal(seen.length, 0);
});

test('reads the Go key out of an OpenCode auth.json', async () => {
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  const seen = stubFetch({ usage: { rolling: { status: 'ok', percent: 12 } } });
  const dir = await mkdtemp(join(tmpdir(), 'ogq-'));
  const authPath = join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-from-file' } }), 'utf8');

  const { ctx, routes } = createCtx();
  apply(ctx, { authPath });
  const response = await callRoute(routes[0]);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.keySource, 'auth.json');
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-from-file');
});

test('a bare payload without windows is bad_payload, not a crash', async () => {
  stubFetch({ usage: { something: 'else' } });
  const { ctx, routes } = createCtx();
  apply(ctx, { apiKey: 'sk-test' });
  const response = await callRoute(routes[0]);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, 'bad_payload');
});

test('resolves the key through the Host credential seam before env or auth.json', async () => {
  const seen = stubFetch({ usage: { rolling: { status: 'ok', percent: 7 } } });
  const asked = [];
  const credentials = {
    async resolve(ref) {
      asked.push(ref);
      if (ref !== 'OPENCODE_GO_API_KEY') return undefined;
      return { value: 'sk-from-credentials', source: 'user-env' };
    },
  };
  const { ctx, routes } = createCtx({ credentials });
  apply(ctx, {});
  const response = await callRoute(routes[0]);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.keySource, 'credentials:OPENCODE_GO_API_KEY');
  assert.deepEqual(asked, ['OPENCODE_GO_API_KEY']);
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-from-credentials');
  assert.equal(JSON.stringify(response.body).includes('sk-from-credentials'), false);
});

test('an explicit apiKey still outranks the credential seam', async () => {
  const seen = stubFetch({ usage: { rolling: { status: 'ok', percent: 7 } } });
  let asked = 0;
  const credentials = { async resolve() { asked += 1; return { value: 'sk-should-not-be-used' }; } };
  const { ctx, routes } = createCtx({ credentials });
  apply(ctx, { apiKey: 'sk-config-wins' });
  const response = await callRoute(routes[0]);
  assert.equal(response.body.keySource, 'config');
  assert.equal(asked, 0);
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-config-wins');
});
