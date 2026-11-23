import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Evaluate the built Client bundle outside a browser the way the DSH module
 * table does: register the factory, materialize it with only React externals,
 * then run `apply` against a fake slot/locale context.
 */
test('client bundle wraps __ModuleLoader__ and registers the sidebar and main slots', async () => {
  let registered = null;
  const previousWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { registered = entry; },
    },
  };
  try {
    await import('../lib/client.js');
    assert.notEqual(registered, null);
    assert.equal(registered.id, 'dsh-jiezi');
    assert.equal(typeof registered.factory, 'function');

    const empty = {};
    const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') };
    const react = {
      ...empty,
      useCallback: (fn) => fn,
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useState: (value) => [value, () => {}],
      createElement: () => null,
    };
    const modules = registered.factory((specifier) => {
      if (specifier === 'react') return react;
      if (specifier === 'react/jsx-runtime') return jsxRuntime;
      throw new Error(`unexpected external module: ${specifier}`);
    });
    assert.equal(typeof modules.apply, 'function');
    assert.deepEqual(modules.inject, ['slots', 'locale']);

    const registeredSlots = [];
    const localeRegisters = [];
    const cleanups = [];
    const t = (key) => ({ panelTitle: '芥子' })[key] ?? key;
    const ctx = {
      effect(factory) {
        const cleanup = factory();
        cleanups.push(cleanup);
        return cleanup;
      },
      locale: {
        register(namespace, dictionaries) {
          localeRegisters.push({ namespace, languages: Object.keys(dictionaries).sort() });
          return () => {};
        },
        bind() { return t; },
      },
      slots: {
        inject(owner, callback) {
          callback();
          return () => {};
        },
        register(options, component) {
          registeredSlots.push({ options, component });
          return () => {};
        },
      },
    };

    modules.apply(ctx);
    assert.deepEqual(localeRegisters, [{ namespace: 'jiezi.panel', languages: ['en', 'zh'] }]);
    assert.equal(registeredSlots.length, 2);

    const sidebar = registeredSlots.find((entry) => entry.options.name === 'sidebar.panellist');
    assert.ok(sidebar);
    assert.equal(sidebar.options.id, 'jiezi');
    assert.equal(sidebar.options.label(), '芥子');
    assert.equal(typeof sidebar.component, 'function');

    const main = registeredSlots.find((entry) => entry.options.name === 'main');
    assert.ok(main);
    assert.equal(main.options.key, 'jiezi');
    assert.equal(main.options.locale, 'jiezi.panel');
    assert.equal(typeof main.component, 'function');

    for (const cleanup of cleanups.reverse()) cleanup();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('client bundle explains pairing continuity and labels all durable devices', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8');
  assert.match(locales, /插件更新后无需重新扫码/);
  assert.match(locales, /配对另一台 iPhone/);
  assert.match(locales, /已配对设备/);
  assert.match(bundle, /pairingContinued/);
  assert.match(bundle, /pairAnother/);
  assert.match(bundle, /Existing devices keep their original credential/);
});
