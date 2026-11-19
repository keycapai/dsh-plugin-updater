import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateRegistry, createCleanRelaunchEnv, restartApplication } from "../lib/index.js";
import { readUpdateHistory } from "../lib/history.js";

test("updateRegistry: dryRun lists candidates without installing", async () => {
  const snapshot = {
    profileDir: "/tmp/fake-profile",
    plugins: [
      { name: "foo", kind: "registry", installedVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true },
      { name: "bar", kind: "local", installedVersion: "2.0.0", latestVersion: "2.1.0", updateAvailable: true },
    ],
  };

  const report = await updateRegistry({}, {}, snapshot, { dryRun: true });
  assert.match(report, /Would install/);
  assert.match(report, /foo 1.0.0 → 1.1.0/);
  assert.doesNotMatch(report, /bar/);
});

test("updateRegistry: executes install and handles already-installed fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-update-test-"));
  try {
    const installed = [];
    const removed = [];

    const mockManager = {
      async installBundle(spec, options) {
        if (spec.startsWith("foo@")) {
          const err = new Error("already-installed");
          err.code = "already-installed";
          throw err;
        }
        installed.push({ spec, options });
        return { application: "applied" };
      },
      async runPnpm(args) {
        installed.push({ spec: args[1] });
        return { exitCode: 0 };
      },
    };

    const mockCtx = {
      get(name) {
        if (name === "pluginManager") return mockManager;
        return undefined;
      },
    };

    const snapshot = {
      profileDir: dir,
      plugins: [
        { name: "foo", kind: "registry", installedVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, enabled: true },
        { name: "baz", kind: "registry", installedVersion: "0.5.0", latestVersion: "0.6.0", updateAvailable: true, enabled: false },
      ],
    };

    const report = await updateRegistry(mockCtx, { onlyEnabled: false }, snapshot, { dryRun: false, trigger: "ui" });
    assert.match(report, /installed   foo@1.1.0 — restart-required/);
    assert.match(report, /installed   baz@0.6.0 — applied/);
    assert.equal(installed.length, 2);

    // Test when installBundle returns application: "failed" with already-installed and recovers via runPnpm
    const pnpmRan = [];
    const mockManagerPnpm = {
      async installBundle(spec) {
        return { application: "failed", error: { code: "already-installed" } };
      },
      async removeBundle() {
        return { application: "failed", error: { code: "bundle-in-use" } };
      },
      async runPnpm(args) {
        pnpmRan.push(args);
        return { exitCode: 0 };
      },
    };
    const mockCtx2 = {
      get(name) {
        if (name === "pluginManager") return mockManagerPnpm;
      },
    };
    const report2 = await updateRegistry(mockCtx2, { onlyEnabled: false }, snapshot, { dryRun: false, trigger: "ui" });
    assert.match(report2, /installed   foo@1.1.0 — restart-required/);
    assert.deepEqual(pnpmRan, [["add", "foo@1.1.0"], ["add", "baz@0.6.0"]]);

    const hist = readUpdateHistory(dir);
    assert.equal(hist.length, 4);
    assert.equal(hist[0].target, "baz");
    assert.equal(hist[0].status, "success");
    assert.equal(hist[0].trigger, "ui");
    assert.equal(hist[1].target, "foo");
    assert.equal(hist[1].status, "success");
    assert.equal(hist[1].trigger, "ui");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateRegistry: single target filtering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-update-single-"));
  try {
    const installed = [];
    const mockManager = {
      async installBundle(spec) {
        installed.push(spec);
        return { application: "applied" };
      },
    };
    const mockCtx = {
      get(name) {
        if (name === "pluginManager") return mockManager;
      },
    };
    const snapshot = {
      profileDir: dir,
      plugins: [
        { name: "foo", kind: "registry", installedVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true },
        { name: "baz", kind: "registry", installedVersion: "0.5.0", latestVersion: "0.6.0", updateAvailable: true },
      ],
    };

    const report = await updateRegistry(mockCtx, {}, snapshot, { dryRun: false, target: "foo" });
    assert.match(report, /installed   foo@1.1.0/);
    assert.doesNotMatch(report, /baz/);
    assert.deepEqual(installed, ["foo@1.1.0"]);

    // Test that target: "null", "undefined", "all", "" are treated as all
    for (const nullishTarget of ["null", "undefined", "all", "", null, undefined]) {
      const allReport = await updateRegistry(mockCtx, {}, snapshot, { dryRun: true, target: nullishTarget });
      assert.match(allReport, /foo 1.0.0 → 1.1.0/);
      assert.match(allReport, /baz 0.5.0 → 0.6.0/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("route registration and handler execution", async () => {
  const routes = new Map();
  const mockConnection = {
    fetch: {
      register(opts) {
        routes.set(opts.path, opts);
        return () => routes.delete(opts.path);
      },
    },
  };

  const installed = [];
  const mockManager = {
    async installBundle(spec) {
      installed.push(spec);
      return { application: "applied" };
    },
  };

  const effects = [];
  const scopedCtx = {
    get(name) {
      if (name === "connection") return mockConnection;
      if (name === "pluginManager") return mockManager;
    },
    effect(fn) {
      effects.push(fn);
    },
  };

  const mockCtx = {
    inject(deps, fn) {
      fn(scopedCtx);
    },
    get(name) {
      return scopedCtx.get(name);
    },
    effect() {},
    provide() {},
    agentTools: { register() {} },
  };

  const { apply } = await import("../lib/index.js");
  apply(mockCtx, { checkRegistry: false, watchLocal: false });

  // Run the route effect
  assert.equal(effects.length, 1);
  const cleanup = effects[0]();

  assert(routes.has("/api/dsh-plugin-updater/status"));
  assert(routes.has("/api/dsh-plugin-updater/update"));

  const statusRoute = routes.get("/api/dsh-plugin-updater/status");
  assert.deepEqual(statusRoute.methods, ["POST"]);

  // Test status query
  const res1 = await statusRoute.fetch({
    async json() { return {}; }
  });
  const data1 = await res1.json();
  assert.equal(data1.ok, true);
  assert.equal(data1.report, null);
  assert.equal(typeof data1.onlyEnabled, "boolean");
  assert.equal(typeof data1.restartRequired, "boolean");
  assert(Array.isArray(data1.pendingRestart));

  // Test action: check
  const res2 = await statusRoute.fetch({
    async json() { return { action: "check" }; }
  });
  const data2 = await res2.json();
  assert.equal(data2.ok, true);

  // Test action: update
  const res3 = await statusRoute.fetch({
    async json() { return { action: "update" }; }
  });
  const data3 = await res3.json();
  assert.equal(data3.ok, true);

  cleanup();
  assert.equal(routes.size, 0);
});

test("restartApplication: strips ELECTRON_RUN_AS_NODE and generates valid relaunch script", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-relaunch-test-"));
  try {
    const scriptPath = join(dir, "dsh-relaunch.sh");
    const pollutedEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/reno",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      DSH_DESKTOP_NODE_EXECUTABLE: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
      DSH_DESKTOP_BUNDLED_RUNTIME_DIR: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime",
      NODE_OPTIONS: "--expose-internals",
    };

    const clean = createCleanRelaunchEnv(pollutedEnv);
    assert.equal(clean.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(clean.ELECTRON_NO_ATTACH_CONSOLE, undefined);
    assert.equal(clean.DSH_DESKTOP_NODE_EXECUTABLE, undefined);
    assert.equal(clean.DSH_DESKTOP_BUNDLED_RUNTIME_DIR, undefined);
    assert.equal(clean.NODE_OPTIONS, undefined);
    assert.equal(clean.PATH, "/usr/bin:/bin");

    const result = restartApplication({
      dryRun: true,
      scriptPath,
      env: pollutedEnv,
      execPath: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
      mainPid: 12345,
      hostPid: 12346,
    });

    assert.equal(result.env.ELECTRON_RUN_AS_NODE, undefined);
    if (process.platform === "darwin") {
      assert.match(result.content, /unset ELECTRON_RUN_AS_NODE/);
      assert.match(result.content, /SingletonLock/);
      assert.match(result.content, /ShipIt/);
      assert.match(result.content, /___launch___/);
      assert.match(result.content, /file:\/\/\/Applications\/DeepSeek%20Harness\.app\//);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateRegistry: respects onlyEnabled option", async () => {
  const snapshot = {
    profileDir: "/tmp/fake-profile",
    plugins: [
      { name: "foo", kind: "registry", installedVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, enabled: true },
      { name: "baz", kind: "registry", installedVersion: "0.5.0", latestVersion: "0.6.0", updateAvailable: true, enabled: false },
    ],
  };

  // With onlyEnabled: true
  const report1 = await updateRegistry({}, { onlyEnabled: true }, snapshot, { dryRun: true });
  assert.match(report1, /foo 1.0.0 → 1.1.0/);
  assert.doesNotMatch(report1, /baz/);

  // With onlyEnabled: false
  const report2 = await updateRegistry({}, { onlyEnabled: false }, snapshot, { dryRun: true });
  assert.match(report2, /foo 1.0.0 → 1.1.0/);
  assert.match(report2, /baz 0.5.0 → 0.6.0/);

  // args.onlyEnabled overrides config
  const report3 = await updateRegistry({}, { onlyEnabled: false }, snapshot, { dryRun: true, onlyEnabled: true });
  assert.match(report3, /foo 1.0.0 → 1.1.0/);
  assert.doesNotMatch(report3, /baz/);

  // Targeting disabled plugin with onlyEnabled: true gives clear warning
  const report4 = await updateRegistry({}, { onlyEnabled: true }, snapshot, { dryRun: true, target: "baz" });
  assert.match(report4, /Plugin baz is disabled, and 'onlyEnabled' is active/);
});

test("client.js FooterUpdateIndicator preserves hook order across loading -> ready transition", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const clientCode = readFileSync(new URL("../client.js", import.meta.url), "utf8");

  let hookLogPerRender = [];
  let currentRenderHooks = null;
  let stateCells = [];
  let stateCursor = 0;
  let effects = [];

  const mockReact = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(init) {
      currentRenderHooks.push("useState");
      const idx = stateCursor++;
      if (!(idx in stateCells)) {
        stateCells[idx] = typeof init === "function" ? init() : init;
      }
      const setState = (next) => {
        stateCells[idx] = typeof next === "function" ? next(stateCells[idx]) : next;
      };
      return [stateCells[idx], setState];
    },
    useRef(init) {
      currentRenderHooks.push("useRef");
      const idx = stateCursor++;
      if (!(idx in stateCells)) {
        stateCells[idx] = { current: init };
      }
      return stateCells[idx];
    },
    useCallback(fn) {
      currentRenderHooks.push("useCallback");
      stateCursor++;
      return fn;
    },
    useEffect(fn) {
      currentRenderHooks.push("useEffect");
      const idx = stateCursor++;
      effects[idx] = fn;
    },
  };

  let registeredFactory = null;
  const sandbox = {
    // The renderer provides these; a bare vm context does not. Without them the
    // client's polling timer throws inside evalmachine instead of exercising
    // the hook-order assertion this test exists for.
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: {
      __ModuleLoader__: {
        load(spec) {
          registeredFactory = spec.factory;
        },
      },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
    },
    document: {
      getElementById() { return {}; },
      createElement() { return {}; },
      head: { appendChild() {} },
      querySelector() { return null; },
      addEventListener() {},
      removeEventListener() {},
    },
    fetch: async () => ({
      ok: true,
      async json() {
        return {
          ok: true,
          onlyEnabled: true,
          restartRequired: false,
          pendingRestart: [],
          plugins: [
            { name: "dsh-context", kind: "registry", enabled: true, installedVersion: "0.79.0", latestVersion: "0.81.0", updateAvailable: true },
          ],
        };
      },
    }),
  };

  vm.runInNewContext(clientCode, sandbox);
  assert.equal(typeof registeredFactory, "function");

  const pluginExports = registeredFactory((mod) => {
    if (mod === "react") return mockReact;
    return {};
  });

  let footerRenderFn = null;
  const mockSlots = {
    inject(slotName, fn) { return fn(); },
    register(meta, renderFn) {
      if (meta.name === "sidebar.footer.action") {
        footerRenderFn = renderFn;
      }
      return () => {};
    },
  };
  const mockConfigForms = {
    get() {
      return {
        getSnapshot() { return { status: "ready", value: { onlyEnabled: true }, writable: true, revision: 1 }; },
        subscribe() { return () => {}; },
        async set() {},
      };
    },
    whileServed(ns, fn) { return fn(); },
  };
  const mockCtx = {
    get(name) {
      if (name === "slots") return mockSlots;
      if (name === "configForms") return mockConfigForms;
      return null;
    },
    effect(fn) { fn(); },
  };

  pluginExports.apply(mockCtx);
  assert.equal(typeof footerRenderFn, "function");

  function renderFooter() {
    currentRenderHooks = [];
    stateCursor = 0;
    const tree = footerRenderFn({ wide: true });
    const Component = tree.type;
    const out = Component(tree.props);
    hookLogPerRender.push(currentRenderHooks);
    return out;
  }

  // Render 1: initial loading state (data === null)
  const out1 = renderFooter();
  assert.equal(out1, null);

  // Trigger mount effect (useStatus load)
  for (const eff of effects) {
    if (eff) eff();
  }
  await new Promise((r) => setTimeout(r, 10));

  // Render 2: ready state (data !== null)
  const out2 = renderFooter();
  assert.notEqual(out2, null);

  // Verify Rules of Hooks: exact same hook count and sequence between Render 1 and Render 2
  assert.deepEqual(hookLogPerRender[0], hookLogPerRender[1]);
});

