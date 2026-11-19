/**
 * Inventory: what the current profile depends on, how it got there, and what
 * version it is running.
 *
 * One row per profile dependency that (a) ships a DSH bundle or (b) is a local
 * directory we can watch — plus, by default, every other dependency so tooling can
 * see the whole picture. Rows never throw; a broken row carries `error` and the
 * walk continues.
 *
 * Read-only: this module never writes the profile.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { isNewer, parseVersion } from "./semver.js";
import { defaultRegistries, readPackageManager, resolveRegistries, viewPackage } from "./registry.js";

/** Kind of spec, mirroring the contract. */
const KINDS = new Set(["registry", "link", "file", "git", "tarball", "path", "workspace", "unknown"]);

/** How many registry lookups run at once. pnpm view is fast; this keeps bursts civil. */
const REGISTRY_CONCURRENCY = 6;

/** Specs that name a git host. */
const GIT_RE = /^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:|ssh:\/\/|git@)/i;
/** Specs that name a tarball. */
const TARBALL_RE = /\.(?:tgz|tar\.gz|tar)$/i;
/** Specs that are a plain version / range / tag. */
const RANGE_RE = /^[\s]*[v=]?(?:\d+|x|X|\*|latest|next|beta|alpha|rc|canary)(?:[\s.=]|$|[-+])|^[\s]*[<>=~^*]/;

function errorText(error) {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function tryRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Strip `file:` / `link:` and resolve relative to `baseDir`. */
function resolveSpecPath(spec, baseDir) {
  const raw = spec.replace(/^(?:link|file):/, "").trim();
  if (raw === "") return null;
  return isAbsolute(raw) ? normalize(raw) : resolve(baseDir, raw);
}

/**
 * Classify one dependency spec.
 *
 * @param {string} spec the raw value from `dependencies`
 * @param {string} baseDir the declaring package's directory (the profile dir)
 * @returns {{kind:''|'registry'|'link'|'file'|'git'|'tarball'|'path'|'workspace'|'unknown', localDir:string|null, target:string|null}}
 *   `localDir` is the package directory for `link`/`path`/directory-`file`, `target` the raw target.
 */
export function classifySpec(spec, baseDir) {
  const result = { kind: "unknown", localDir: null, target: null };
  if (typeof spec !== "string") return result;
  const text = spec.trim();
  if (text === "") return { ...result, kind: "registry" };

  // pnpm protocols that are not a registry version.
  if (/^(?:link|portal|exec):/i.test(text)) {
    const path = resolveSpecPath(text.replace(/^(?:portal|exec):/i, "link:"), baseDir);
    return { kind: "link", target: text, localDir: path === null ? null : tryRealpath(path) ?? path };
  }
  if (/^workspace:/i.test(text)) return { kind: "workspace", target: text, localDir: null };

  if (/^file:/i.test(text)) {
    const path = resolveSpecPath(text, baseDir);
    if (path === null) return { kind: "file", target: text, localDir: null };
    // pnpm's `file:` is a local directory or tarball, decided by what is on disk.
    if (TARBALL_RE.test(path) || (isFile(path) && !isDirectory(path))) return { kind: "tarball", target: text, localDir: null };
    if (isDirectory(path)) return { kind: "file", target: text, localDir: tryRealpath(path) ?? path };
    // Does not exist (yet, or outside this machine): the extension is all we have.
    return { kind: TARBALL_RE.test(path) ? "tarball" : "file", target: text, localDir: null };
  }

  if (GIT_RE.test(text)) return { kind: "git", target: text, localDir: null };

  // A bare path: absolute, `./x`, `../x`, `~/x`.
  if (/^(?:\.{1,2}\/|\/|~\/)/.test(text)) {
    const path = text.startsWith("~/")
      ? resolve(process.env.HOME ?? baseDir, text.slice(2))
      : resolveSpecPath(text, baseDir);
    return { kind: "path", target: text, localDir: path === null ? null : tryRealpath(path) ?? path };
  }

  if (RANGE_RE.test(text) || /^\d/.test(text)) {
    // A name that happens to be a tarball URL is still a registry dep unless it is `http`.
    return { kind: "registry", target: text, localDir: null };
  }
  if (/^https?:\/\//i.test(text)) {
    return TARBALL_RE.test(text) ? { kind: "tarball", target: text, localDir: null } : { kind: "unknown", target: text, localDir: null };
  }
  if (TARBALL_RE.test(text)) return { kind: "tarball", target: text, localDir: null };
  // `owner/repo` shorthand (GitHub), `/` not preceded by ./ ../ or a scope.
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return { kind: "git", target: text, localDir: null };
  return { kind: "registry", target: text, localDir: null };
}

/** Where pnpm puts a direct dependency of the profile. */
function linkedLocation(profileDir, name) {
  return join(profileDir, "node_modules", ...name.split("/"));
}

/** pnpm's `.modules.yaml` is JSON in the current layout; whatever it is, failure means "no index". */
function readModulesIndex(profileDir) {
  return readJsonFile(join(profileDir, "node_modules", ".modules.yaml"));
}

/** Find a package directory for a dependency, following pnpm's layouts. */
function locatePackage(profileDir, name) {
  const linked = linkedLocation(profileDir, name);
  if (existsSync(linked)) {
    const real = tryRealpath(linked);
    return { path: linked, realDir: real, symlink: real !== null && real !== linked };
  }
  // Fallback: a dependency hoisted somewhere else (e.g. inside the virtual store).
  const modules = readModulesIndex(profileDir);
  const locations = modules?.hoistedLocations ?? {};
  if (locations !== null && typeof locations === "object") {
    for (const [key, rels] of Object.entries(locations)) {
      if (!key.startsWith(`${name}@`) && key !== name) continue;
      for (const rel of Array.isArray(rels) ? rels : []) {
        if (typeof rel !== "string") continue;
        const candidate = join(profileDir, rel);
        if (existsSync(candidate)) {
          const real = tryRealpath(candidate);
          return { path: candidate, realDir: real, symlink: real !== null && real !== candidate };
        }
      }
    }
  }
  return null;
}

/** The plugin's manifest, from a package directory. */
function readManifest(dir) {
  if (dir === null) return null;
  const json = readJsonFile(join(dir, "package.json"));
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  return json;
}

/**
 * Whether the manifest declares a DSH bundle.
 *
 * The authoritative rule in the shipped Host keys on `dsh.bundle.patch`, not on the
 * field's mere presence: `dsh-app-boot/lib/index.js:1072` reads
 * `bundle: bundleManifest(location, name)?.dsh?.bundle?.patch !== void 0`, and
 * `bundlePatchFiles()` (same file, ~:495) requires `bundle.patch` to be a string or
 * string[], so a literal `bundle: true` would throw there. Strictly, therefore,
 * `dsh.bundle: true` alone is NOT a bundle in DSH.
 *
 * We are DELIBERATELY more permissive, because CONTRACT.md documents this field as
 * `bundle: boolean; // declares dsh.bundle`, and we should not punish a third-party
 * author who wrote exactly what our own contract told them to write. The asymmetry is
 * what decides it: a false negative silently drops a real local plugin from the
 * inventory and from update offers with no diagnostic, while a false positive merely
 * shows one extra row. `listInstalled` uses this flag only to decide whether to keep a
 * row — installation belongs to the plugin manager — so nothing is granted by it.
 *
 * Accepted shapes, all treated as "this package is a bundle":
 *   - `dsh.bundle: { patch: "cordis.patch.yml" }`  the shipped object form
 *   - `dsh.bundle: "cordis.patch.yml"`             a patch path as a bare string
 *   - `dsh.bundle: true`                           the contract's stated shape
 *   - `dsh.patch: "x.yml"`                         a bundle naming its patch directly
 */
function declaresBundle(manifest) {
  if (manifest === null) return false;
  const dsh = manifest.dsh;
  if (dsh === null || typeof dsh !== "object") return false;
  const bundle = dsh.bundle;
  if (bundle === true) return true;
  if (typeof bundle === "string" && bundle !== "") return true;
  if (bundle !== null && typeof bundle === "object" && !Array.isArray(bundle)) return true;
  // A bundle without `dsh.bundle` is a package that ships a patch file.
  if (typeof dsh.patch === "string" && dsh.patch !== "") return true;
  return false;
}

/** The profile's selected bundle names (`dsh.profile.bundles`). */
function readSelectedBundles(profileDir) {
  const selected = new Set();
  const manifest = readJsonFile(join(profileDir, "package.json"));
  const list = manifest?.dsh?.profile?.bundles;
  if (Array.isArray(list)) for (const entry of list) if (typeof entry === "string") selected.add(entry);
  return selected;
}

/** Run `task` over `items` with bounded concurrency, preserving order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        results[index] = { error: errorText(error) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** The profile directory from a context, defensively. */
function profileDirOf(ctx) {
  const argvMatch = Array.isArray(process.argv)
    ? process.argv.find((arg) => typeof arg === "string" && arg.includes("/profiles/") && existsSync(arg) && existsSync(join(arg, "package.json")))
    : null;
  const isHostContext = Boolean(ctx && (ctx.root || ctx.fiber || typeof ctx.get === "function" || typeof ctx.plugin === "function"));
  const cwdCandidate = isHostContext && typeof process.cwd === "function" && existsSync(join(process.cwd(), "package.json")) && existsSync(join(process.cwd(), "cordis.patch.yml"))
    ? process.cwd()
    : null;
  const defaultDesktopProfile = isHostContext ? join(homedir(), ".dsh", "profiles", "desktop") : null;
  let directDir = null;
  try { directDir = typeof ctx?.get === "function" ? ctx.get("profileDir") : ctx?.profileDir; } catch {}
  let ctxDir = null;
  try { ctxDir = typeof ctx?.get === "function" ? ctx.get("profileContext")?.dir : ctx?.profileContext?.dir; } catch {}
  let ctxProfileDir = null;
  try { ctxProfileDir = typeof ctx?.get === "function" ? ctx.get("profileContext")?.profileDir : ctx?.profileContext?.profileDir; } catch {}
  const candidates = [
    ctxDir,
    ctxProfileDir,
    directDir,
    process.env.DSH_PROFILE_DIR,
    argvMatch,
    cwdCandidate,
    defaultDesktopProfile,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "" && existsSync(candidate) && existsSync(join(candidate, "package.json"))) {
      return resolve(candidate);
    }
  }
  return null;
}

/** Normalized config with documented defaults. */
function normalizeConfig(config) {
  const source = config !== null && typeof config === "object" ? config : {};
  const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);
  return {
    checkRegistry: bool(source.checkRegistry, true),
    onlyEnabled: bool(source.onlyEnabled, true),
    includePrerelease: bool(source.includePrerelease, false),
    includeAllDeps: bool(source.includeAllDeps, true),
    timeoutMs: Number.isFinite(source.timeoutMs) ? source.timeoutMs : 20000,
    registries: source.registries,
    signal: source.signal,
  };
}

/** The version a range was resolved to, read from the package itself. */
function installedVersionOf(manifest) {
  const version = manifest?.version;
  return typeof version === "string" && version.trim() !== "" ? version.trim() : null;
}

/**
 * Enumerate the profile's installed plugins and their update state.
 *
 * @param {object} ctx Host context. `ctx.profileContext.dir` is the profile. A plain
 *   `{profileContext:{dir}}` works; a real Cordis context also supplies `packageManager`.
 * @param {object} [config] `{checkRegistry, includePrerelease, includeAllDeps, timeoutMs, registries, signal}`
 * @returns {Promise<{
 *   ok: boolean, profileDir: string|null,
 *   plugins: Array<{
 *     name:string, spec:string, kind:string, local:boolean, localDir:string|null,
 *     installedVersion:string|null, packageDir:string|null, bundle:boolean, enabled:boolean,
 *     latestVersion:string|null, updateAvailable:boolean|null,
 *     description?:string, error?:string
 *   }>,
 *   warnings: string[],
 *   counts?: {total:number, local:number, bundles:number, updates:number},
 *   packageManager?: object|null,
 *   error?: string
 * }>}
 */
export async function listInstalled(ctx, config) {
  const warnings = [];
  const cfg = normalizeConfig(config);
  const empty = { ok: false, profileDir: null, plugins: [], warnings, counts: { total: 0, local: 0, bundles: 0, updates: 0 } };

  let profileDir;
  try {
    profileDir = profileDirOf(ctx);
  } catch (error) {
    return { ...empty, error: errorText(error) };
  }
  if (profileDir === null) {
    return { ...empty, error: "listInstalled: ctx.profileContext.dir is missing or unreadable" };
  }

  // --- the profile manifest -----------------------------------------------------------------
  const manifestPath = join(profileDir, "package.json");
  const manifest = readJsonFile(manifestPath);
  if (manifest === null) {
    return { ...empty, profileDir, error: `listInstalled: cannot read ${manifestPath}` };
  }
  const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === "object" && !Array.isArray(manifest.dependencies)
    ? manifest.dependencies
    : {};
  if (manifest.dependencies !== undefined && manifest.dependencies !== dependencies) warnings.push("profile package.json dependencies is not an object; ignored");

  let selected = new Set();
  try {
    selected = readSelectedBundles(profileDir);
  } catch (error) {
    warnings.push(`cannot read dsh.profile.bundles: ${errorText(error)}`);
  }

  // --- package manager + registry, resolved once --------------------------------------------
  let packageManager = null;
  try {
    packageManager = await readPackageManager(ctx);
  } catch {
    packageManager = null;
  }
  if (packageManager === null && cfg.checkRegistry) warnings.push("no package manager found; registry versions were not checked");

  let registries = [];
  try {
    const resolvedList = await resolveRegistries(ctx, cfg);
    registries = resolvedList.registries;
  } catch {
    registries = defaultRegistries(ctx, cfg);
  }
  const shared = { profileDir, packageManager, registry: null, registries };

  // --- one row per dependency ---------------------------------------------------------------
  const names = Object.keys(dependencies).sort();
  const rows = [];
  for (const name of names) {
    const spec = dependencies[name];
    /** @type {any} */
    const row = {
      name,
      spec: typeof spec === "string" ? spec : String(spec ?? ""),
      kind: "unknown",
      local: false,
      localDir: null,
      installedVersion: null,
      packageDir: null,
      bundle: false,
      enabled: selected.has(name),
      latestVersion: null,
      updateAvailable: null,
    };
    try {
      const klass = classifySpec(row.spec, profileDir);
      row.kind = KINDS.has(klass.kind) ? klass.kind : "unknown";
      row.local = klass.kind === "link" || klass.kind === "path" || (klass.kind === "file" && klass.localDir !== null && isDirectory(klass.localDir));
      if (row.local && klass.localDir !== null) row.localDir = tryRealpath(klass.localDir) ?? klass.localDir;

      const located = locatePackage(profileDir, name);
      if (located !== null) {
        row.packageDir = located.realDir ?? resolve(located.path);
        if (!existsSync(row.packageDir)) {
          // A dangling symlink (link: target removed) still leaves the package.json readable
          // through the symlink path in most cases; record it and move on.
          row.error = "package directory is a dangling link";
        }
        const pluginManifest = readManifest(row.packageDir) ?? readManifest(located.path);
        if (pluginManifest !== null) {
          row.installedVersion = installedVersionOf(pluginManifest);
          row.bundle = declaresBundle(pluginManifest);
          if (typeof pluginManifest.description === "string" && pluginManifest.description !== "") row.description = pluginManifest.description;
        } else {
          row.error = "package.json missing or unreadable in the package directory";
        }
        // A directory shipped through `file:` may itself be the watchable local dir.
        if (!row.local && klass.kind === "file" && located.symlink === true && located.realDir !== null) {
          row.local = true;
          row.localDir = located.realDir;
        }
      } else {
        row.error = "not installed (no node_modules entry)";
        // A link/path dep that resolves straight to a real directory is still watchable.
        if (row.local && klass.localDir !== null && isDirectory(klass.localDir)) {
          row.packageDir = tryRealpath(klass.localDir) ?? klass.localDir;
          const pluginManifest = readManifest(row.packageDir);
          if (pluginManifest !== null) {
            row.installedVersion = installedVersionOf(pluginManifest);
            row.bundle = declaresBundle(pluginManifest);
            row.error = undefined;
          }
        }
      }
      if (row.bundle && !row.enabled) row.error = row.error ?? undefined;
    } catch (error) {
      row.error = errorText(error);
    }
    rows.push(row);
  }

  // --- registry lookups (only for registry rows, only when asked) ----------------------------
  if (cfg.checkRegistry) {
    const targets = packageManager === null
      ? []
      : rows.filter((row) => row.kind === "registry" && row.installedVersion !== null && (!cfg.onlyEnabled || row.enabled !== false));
    const outcomes = await mapLimit(targets, REGISTRY_CONCURRENCY, async (row) => {
      const result = await viewPackage(row.name, {
        name: row.name,
        profileDir,
        packageManager,
        registry: shared.registry,
        timeoutMs: cfg.timeoutMs,
        signal: cfg.signal,
      }).catch((error) => ({ ok: false, error: errorText(error) }));
      if (!result.ok) {
        warnings.push(`registry check failed for ${row.name}: ${result.error}`);
        row.latestVersion = null;
        row.updateAvailable = null;
        return;
      }
      const tags = result.distTags ?? {};
      const candidates = [];
      if (typeof tags.latest === "string") candidates.push(tags.latest);
      for (const version of result.versions ?? []) {
        const parsed = parseVersion(version);
        if (parsed === null) continue;
        if (!cfg.includePrerelease && parsed.prerelease.length > 0) continue;
        candidates.push(version);
      }
      let best = null;
      for (const candidate of candidates) {
        if (parseVersion(candidate) === null) continue;
        if (best === null || isNewer(candidate, best)) best = candidate;
      }
      // When the installed version is ahead of everything the range admits (a prerelease
      // installed from a dist-tag, say), say so by reporting the installed version: the
      // row then shows "current", and `updateAvailable` never claims a downgrade.
      row.latestVersion = best ?? row.installedVersion;
      row.updateAvailable = isNewer(row.latestVersion, row.installedVersion);
    });
    void outcomes;
  }

  // --- filter -------------------------------------------------------------------------------
  const plugins = cfg.includeAllDeps
    ? rows
    : rows.filter((row) => row.bundle || row.local);

  return {
    ok: true,
    profileDir,
    plugins,
    warnings,
    counts: {
      total: plugins.length,
      local: plugins.filter((row) => row.local).length,
      bundles: plugins.filter((row) => row.bundle).length,
      updates: plugins.filter((row) => row.updateAvailable === true).length,
    },
    packageManager,
    registries,
  };
}

/**
 * Convenience: one plugin's row from the last inventory, or a fresh read.
 * @param {object} ctx
 * @param {string} name
 * @param {object} [config]
 * @returns {Promise<object|null>}
 */
export async function describePlugin(ctx, name, config) {
  try {
    const inventory = await listInstalled(ctx, { ...(config ?? {}), checkRegistry: false, includeAllDeps: true });
    return inventory.plugins.find((row) => row.name === name) ?? null;
  } catch {
    return null;
  }
}

/** The watchable local directories, for lib/watch.js. */
export function localDirectories(inventory) {
  const dirs = [];
  const plugins = Array.isArray(inventory?.plugins) ? inventory.plugins : [];
  for (const plugin of plugins) {
    if (plugin?.local !== true) continue;
    const dir = typeof plugin.localDir === "string" ? plugin.localDir : plugin.packageDir;
    if (typeof dir === "string" && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

export const __internal = { classifySpec, locatePackage, declaresBundle, readSelectedBundles };
