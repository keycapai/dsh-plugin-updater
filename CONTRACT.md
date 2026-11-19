# dsh-plugin-updater — frozen interfaces

A DSH **Host** bundle that keeps the current profile's plugins current, and that makes
locally-developed plugins refresh **without restarting the Harness process**.

Package root: `/Users/reno/Documents/deepseek-harness/default-workspace/dsh-plugin-updater`
Package name: `dsh-plugin-updater`

## Files (strict write ownership)

| File | Owner | Purpose |
|---|---|---|
| `package.json`, `cordis.patch.yml`, `README.md`, `lib/index.js` | Lead | manifest, patch row, plugin entry, agent tool |
| `lib/inventory.js` | A | classify profile deps (registry / link / file / git), read installed versions, query registry for latest |
| `lib/registry.js` | A | lowest-level package-manager + registry HTTP helpers used by inventory |
| `lib/semver.js` | A | dependency-free version compare / range test |
| `lib/reload.js` | B | THE primitive: evict module cache + re-import + restart fibers, with rollback |
| `lib/watch.js` | B | dependency-free recursive file watcher + debounce |
| `client.js`, `locale/*.json` | D | Plugins-page card (optional), display metadata |
| `test/*.mjs`, `test/run.sh` | C | tests + real-runtime proof |
| `CONTRACT.md` | Lead | this file |

Never write a file owned by someone else. If you need a change in another file, message its owner.

## Module contracts

### `lib/semver.js` (A)

```js
export function parseVersion(text)                  // -> {major,minor,patch,prerelease:string[],raw} | null
export function compareVersions(a, b)               // -> -1|0|1 ; parses both, throws TypeError on unparseable
export function satisfiesVersion(version, range)    // -> boolean; supports exact, ^, ~, >=, >, <=, <, =, *, x-range, "latest", "||" and space-AND
export function isNewer(candidate, current)         // -> boolean
export function versionDistance(current, next)      // -> 'major'|'minor'|'patch'|'prerelease'|'same'|'unknown'
```

No dependencies. Must not throw on malformed input in `satisfiesVersion`/`isNewer` (return false).

### `lib/registry.js` (A)

```js
export function normalizeRegistry(url)                                   // -> string ending in '/'
export async function readPackageManager(ctx)                            // -> {command, args, env} | null
   // ctx.profileContext.packageManager when present, else process.execPath-free fallback:
   // {command: 'node'|process.execPath, args:[<bundled pnpm.mjs>], env} discovered from the running install
export async function viewPackage(distTagsName, options)                 // -> {ok, version?, versions?, error?}
   // options: {name, profileDir, packageManager, registry, timeoutMs, signal}
export async function viewVersions(options)                              // -> {ok, versions:[], distTags:{}, error?}
export function defaultRegistries(ctx)                                   // -> [url,...] from pluginManager.registries() when available, else npmjs + npmmirror
```

`viewPackage` runs `<pm> view <name> --json` and parses JSON; returns `{ok:false,error}` — it never throws.

### `lib/inventory.js` (A)

```js
export async function listInstalled(ctx, config)   // -> Inventory
```

```ts
type Inventory = {
  profileDir: string;
  plugins: InstalledPlugin[];   // one row per profile dependency that ships a bundle AND per local path dep
  warnings: string[];
};

type InstalledPlugin = {
  name: string;                 // package name (or a stable label for path deps)
  spec: string;                 // the raw dependency spec from profile package.json
  kind: "registry" | "link" | "file" | "git" | "tarball" | "path" | "workspace" | "unknown";
  local: boolean;               // true => hot refresh applies (a directory on disk we can watch)
  localDir: string | null;      // absolute directory of the plugin package when kind is link/path
  installedVersion: string | null;
  packageDir: string | null;    // absolute resolved package directory
  bundle: boolean;              // declares dsh.bundle
  enabled: boolean;             // selected in dsh.profile.bundles
  latestVersion: string | null; // filled only when config.checkRegistry
  updateAvailable: boolean | null;
  error?: string;
};
```

Rules:
- Read `<profileDir>/package.json` `dependencies` (never write it).
- `kind`: `link:` → `link`; `file:` ending `.tgz|.tar.gz` → `tarball`; `file:` dir → `file`; absolute/relative path → `path`; `workspace:` → `workspace`; `git+`, `github:`, `gitlab:`, `bitbucket:` → `git`; a version range/`latest` → `registry`.
- `local` is true only for `link` and `path` (and `file` when it points at a directory that exists): those are the ones we can watch and reload.
- `localDir`: `link:<abs>` → `<abs>`; `path` spec → resolved against **the declaring package's** directory (the profile dir), realpathed.
- `installedVersion`: `readFileSync(<packageDir>/package.json).version`; for tarball/link also fine.
- `packageDir`: resolve `<profileDir>/node_modules/<name>` → `realpathSync`; null when unreadable.
- `latestVersion` only when `config.checkRegistry && kind === "registry"`; failures become `warnings`, never throw.
- Never throw for one bad row: record `error` on the row and continue.

### `lib/reload.js` (B) — the core

```js
export function canReload(ctx)                      // -> {ok:boolean, reason?:string}
export async function reloadPlugin(ctx, request)    // -> ReloadResult
export async function reloadMany(ctx, requests)     // -> ReloadResult[]
```

```ts
type ReloadRequest = {
  name: string;            // plugin package name, used for reporting
  dir: string;             // absolute package directory (or file) whose modules to invalidate
  changedFile?: string;    // optional: only reload when this file belongs to `dir`
};

type ReloadResult = {
  name: string;
  status: "reloaded" | "unchanged" | "unsupported" | "failed";
  generation?: number;     // increments per successful reload
  entries?: string[];      // loader entry ids restarted
  invalidated?: number;    // module cache entries evicted
  error?: string;
};
```

Implementation requirements (this is the whole point of the plugin):
1. Reach the running Node ESM loader through `ctx.loader.internal` first; if absent, fall back to
   `createRequire(...)("internal/modules/esm/loader").getOrInitializeCascadedLoader()`. If neither works,
   return `{status:"unsupported"}` — never throw. Support BOTH loader shapes: `v1`
   (`getModuleJobForImport`) and `v2` (`getOrCreateModuleJob`).
2. Evict with `Map.prototype.delete.call(loadCache, url)` (Node 24+ `LoadCache` only blanks a type slot
   through its own `delete`), and also evict the CJS twin from `require.cache` by file path.
3. Invalidate the WHOLE module subtree of `dir`: every URL in the load cache whose `fileURLToPath` starts
   with `dir + sep`, plus every transitive dependency reached through `job.linked`, restricted to files
   under `dir` (never evict `node:` or unrelated node_modules).
4. Restart the owning loader entries: for each `ctx.loader.entries()` row whose `options.name` resolves
   into `dir` (resolve via the loader's own `resolveSync`/`resolve`, or by comparing the resolved module
   URL), dispose the old fiber and re-import. Preserve each fiber's config and re-attach `entry.fiber`, so
   the plugin keeps its settings and its loader identity.
5. Rollback: if re-import or re-activation fails, restore the previous cache entries AND re-activate the
   previous plugin object, then report `status:"failed"` with the error. A failed reload must leave the
   Host exactly as it was.
6. Serialize: only one reload at a time process-wide (a module-level promise chain). When `ctx.get("hmr")`
   exists, run inside `hmr.runExclusive(...)` when that is safe; never nest transactions — if already
   inside one, do the work directly.
7. `status:"unchanged"` when no module under `dir` is currently loaded (nothing to refresh).

The algorithm to mirror is `@deepseek-ai/dsh-hmr` `partialReload()` in
`/Users/reno/.dsh/.asar-x/dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js` (read it).

### `lib/watch.js` (B)

```js
export function createWatcher(options)  // -> {close(), stats()}
// options: { roots: string[], ignored: string[] (extra dir names to skip), debounceMs, onChange(batch) }
// batch: { dir: string, files: string[] }
```

- Dependency-free: `node:fs.watch(..., {recursive:true})` when supported (macOS/Windows), else a
  `readdirSync` poll every `debounceMs*4` comparing `mtimeMs`. Probe support by try/catch on the first root.
- Always skip `node_modules`, `.git`, `dist`-style build noise unless configured otherwise.
- One `onChange` per directory per debounce window. `close()` is idempotent and removes every watcher/timer.
- Must not throw when a root does not exist; report it via `stats().missing`.

### `lib/index.js` (Lead)

- `export const name = "plugin-updater"`, `export const inject = ["tools"]` plus optional lookups.
- `export const Config` (schemastery): `enabled`, `checkRegistry`, `checkIntervalMinutes`,
  `autoUpdateRegistry` (default **false**), `onlyEnabled` (default **true**), `watchLocal` (default **true**), `debounceMs`,
  `extraWatchDirs`, `ignored`, `registries`, `includePrerelease`, `timeoutMs`, `log`.
- Registers ONE agent tool `plugin_update` with `action`:
  `status | check | refresh | update | watch | unwatch`.
- Whenever the watcher fires, call `reloadMany(...)` and log; no restart.
- Everything registered through `ctx.effect` so unloading the plugin removes watchers/timers.

## Status (final)

All modules delivered and verified. `./test/run.sh` => 74/74 pass.
The package is installed in the `desktop` profile as a `link:` dependency and
selected in `dsh.profile.bundles`; it activates on the next Host start.

Deviations from this contract, all deliberate:
- `declaresBundle` also accepts `dsh.bundle: true` (the Host itself keys on
  `dsh.bundle.patch`, but a false negative would silently hide a real local
  plugin from the watch list; a false positive only adds a row).
- `ReloadResult` also carries `rolledBack` / `rollbackError`.
- `lib/watch.js` takes `extensions` (not `ignored`-only) and swallows one cold
  macOS fsevents ghost frame per root.

## Environment facts (verified)

- Desktop Host runs with `--expose-internals`; Node 26.11.1; internal ESM loader reports version `v2`
  (`getOrCreateModuleJob`), `loadCache` is a class extending `Map`.
- `Map.prototype.delete.call(internal.loadCache, url)` then `import(url)` re-reads the file — proven.
- Profile: `~/.dsh/profiles/desktop`, deps with `link:` point at real dirs
  (e.g. `dsh-models-dev-enrich` → `…/default-workspace/dsh-models-dev-enrich`).
- Packaged runtime pnpm: `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`
  — `node <that> view <name> version` works.
- The profile's `hmr` row is configured `root: []`, so module files are NOT watched today; only
  `cordis.patch.yml` and `package.json` are. That is the gap this plugin fills.
- Extracted packages (for tests): `~/.dsh/.asar-x/dsh/node_modules/@deepseek-ai/*`.
