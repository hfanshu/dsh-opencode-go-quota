/**
 * Client-half smoke test: the bundle registers both surfaces — the right-pane
 * tab and the sidebar-footer gauge — and the gauge renders its ring from the
 * tightest live window. React and the DOM are stand-ins, so this covers the
 * wiring the framework depends on, not pixels.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value ?? null }),
};

let bundlePromise = null;

/** Load the bundle the way the browser module loader does, with stubs. */
async function loadBundle() {
  if (bundlePromise === null) {
    bundlePromise = (async () => {
      let definition = null;
      globalThis.window = {
        __ModuleLoader__: {
          load(def) {
            definition = def;
          },
        },
      };
      globalThis.document = {
        getElementById: () => null,
        createElement: () => ({ style: {}, textContent: '', setAttribute() {} }),
        head: { appendChild() {} },
      };

      await import('../client.v3.js');

      assert.ok(definition !== null, 'bundle never called window.__ModuleLoader__.load');
      assert.equal(definition.id, 'dsh-opencode-go-quota');
      return definition.factory((name) => {
        if (name === 'react') return REACT_STUB;
        throw new Error(`unexpected require('${name}')`);
      });
    })();
  }
  return bundlePromise;
}

/** A ctx whose slots record registrations and whose services are inert stubs. */
function createClientCtx() {
  const registrations = [];
  const openedTabs = [];
  const slots = {
    inject(_name, factory) {
      factory();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };
  const scope = {
    slots,
    locale: {},
    effect: (fn) => fn(),
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: {
      openTab(kind) {
        openedTabs.push(kind);
      },
    },
  };
  const ctx = {
    slots,
    locale: {},
    effect: (fn) => fn(),
    inject(_deps, callback) {
      callback(scope);
      return () => {};
    },
    on() {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { ctx, registrations, openedTabs };
}

function find(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) find(child, predicate, found);
    return found;
  }
  if (node.type !== undefined && predicate(node)) found.push(node);
  const children = node.children;
  if (Array.isArray(children)) for (const child of children) find(child, predicate, found);
  return found;
}

function badgeState(windows) {
  return {
    phase: 'ok',
    loading: false,
    error: null,
    data: {
      ok: true,
      plan: 'go',
      endpoint: 'https://opencode.ai/zen/go/v1/usage',
      limits: { rolling: 12, weekly: 30, monthly: 60 },
      windows,
      fetchedAt: '2026-11-09T15:00:00.000Z',
      ageMs: 1000,
      stale: false,
      keySource: 'credentials:OPENCODE_GO_API_KEY',
      error: null,
    },
  };
}

test('registers the right-pane tab and the footer gauge', async () => {
  const bundle = await loadBundle();
  const { ctx, registrations } = createClientCtx();
  bundle.apply(ctx);

  const tab = registrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab');
  assert.ok(tab, 'sidebar.right.pane.tab was not registered');
  assert.equal(tab.options.key, 'opencode-go-quota');
  assert.equal(typeof tab.component, 'function');

  const badge = registrations.find((entry) => entry.options.name === 'sidebar.footer.action');
  assert.ok(badge, 'sidebar.footer.action was not registered');
  assert.equal(badge.options.id, 'opencode-go-quota-badge');
  assert.equal(typeof badge.component, 'function');
});

test('the gauge ring draws the tightest window and opens the tab on click', async () => {
  const bundle = await loadBundle();
  const { ctx, registrations, openedTabs } = createClientCtx();
  bundle.apply(ctx);
  const badge = registrations.find((entry) => entry.options.name === 'sidebar.footer.action');

  // The registration supplies `t`/`bus`/`openTab`; render the component it
  // names so the test can hand it a state instead of the live poller.
  const registered = badge.component({});
  const QuotaBadge = registered.type;
  assert.equal(typeof QuotaBadge, 'function');

  const state = badgeState({
    rolling: { status: 'ok', percent: 1, remainingPercent: 99, resetsAt: '2026-11-09T20:00:00.000Z' },
    weekly: { status: 'ok', percent: 8, remainingPercent: 92, resetsAt: '2026-11-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 4, remainingPercent: 96, resetsAt: '2026-12-08T00:00:00.000Z' },
  });
  const bus = { get: () => state, subscribe: () => () => {} };
  const tree = QuotaBadge({ t: (key) => key, bus, openTab: () => openedTabs.push('opened') });

  const controls = find(tree, (node) => node.props.className === 'ogq-badge');
  assert.equal(controls.length, 1);
  assert.equal(controls[0].props['aria-label'], 'badge.aria');

  const rings = find(tree, (node) => typeof node.props.className === 'string' && node.props.className.startsWith('ogq-ring-fill'));
  assert.equal(rings.length, 1);
  assert.equal(rings[0].props.className, 'ogq-ring-fill ogq-ring-ok');
  assert.equal(rings[0].props.strokeDasharray, '92 100');

  controls[0].props.onClick();
  assert.deepEqual(openedTabs, ['opened']);

  // Production wiring: the registered render function's openTab reaches the
  // Sidebar Right service captured through ctx.inject.
  registered.props.openTab();
  assert.deepEqual(openedTabs, ['opened', 'opencode-go-quota']);
});

test('without data the ring is idle and the tooltip stays closed', async () => {
  const bundle = await loadBundle();
  const { ctx, registrations } = createClientCtx();
  bundle.apply(ctx);
  const badge = registrations.find((entry) => entry.options.name === 'sidebar.footer.action');
  const QuotaBadge = badge.component({}).type;

  const bus = { get: () => ({ phase: 'init', data: null, error: null, loading: true }), subscribe: () => () => {} };
  const tree = QuotaBadge({ t: (key) => key, bus, openTab: () => {} });

  const rings = find(tree, (node) => typeof node.props.className === 'string' && node.props.className.startsWith('ogq-ring-fill'));
  assert.equal(rings[0].props.className, 'ogq-ring-fill ogq-ring-idle');
  assert.equal(rings[0].props.strokeDasharray, '0 100');
  assert.equal(find(tree, (node) => node.props.className === 'ogq-tip').length, 0);
  const control = find(tree, (node) => node.type === 'button' && String(node.props.className).startsWith('ogq-badge'))[0];
  assert.equal(control.props['aria-label'], 'badge.ariaEmpty');
});
