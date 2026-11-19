/**
 * Hot reload for one plugin directory, inside the running process.
 *
 * The mechanism is the one `@deepseek-ai/dsh-hmr` already uses for its own
 * watch roots, narrowed to a single directory supplied by the caller:
 *
 *   1. find the Node internal ESM loader (`ctx.loader.internal`, else the
 *      cascaded loader for `--expose-internals`);
 *   2. walk the `*`ModuleJob` link graph from every module under the target
 *      directory and collect exactly those URLs (never `node:`, never an
 *      unrelated `node_modules` subtree);
 *   3. evict them with `Map.prototype.delete.call(loadCache, url)`, plus the
 *      CJS twin from `require.cache` — keeping a backup of everything evicted;
 *   4. re-import only the plugin entry modules (fresh module instances),
 *   5. restart the owning loader entries: dispose every previous fiber, start
 *      the replacement under the *same parent context* with the *same raw
 *      config*, then put the old `entry` back on the new fiber so the loader
 *      keeps its identity, id and position in the tree;
 *   6. if any of steps 4–5 throws, restore the evicted cache entries and
 *      re-activate the previous plugin object, so the Host is left exactly as
 *      it was.
 *
 * Zero dependencies: `node:` builtins only. Every public function resolves to
 * a value; none of them reject because of a reload problem.
 *
 * @module dsh-plugin-updater/reload
 */

import { createRequire } from "node:module";
import { realpathSync, statSync } from "node:fs";
import { readFile as readPromises, stat as statPromises } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** File extensions treated as "code that lives in a plugin directory". */
const CODE_EXTENSIONS = new Set([
	".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
	".json", ".node", ".css", ".wasm",
]);

/** Directory names never descended into when scanning a plugin directory. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".hg", ".svn", ".turbo", ".cache", "coverage"]);

/** Shortest accepted debounce-free quiet period before a re-import is attempted, in ms. */
const SETTLE_RETRIES = 2;

// ── Serialization ──────────────────────────────────────────────────────────

/** Tail of the process-wide reload queue. Every reload chains onto it. */
let queue = Promise.resolve();

/**
 * Run `task` after every previously queued task settled.
 *
 * The chain never rejects: a failing task is contained, which keeps the queue
 * usable for the next caller.
 *
 * @param {() => Promise<any>} task
 * @returns {Promise<any>} the task's result, or the task's rejection.
 */
function serialize(task) {
	const run = queue.then(task, task);
	queue = run.then(noop, noop);
	return run;
}

function noop() {}

// ── Paths and identity ─────────────────────────────────────────────────────

/**
 * Canonical absolute form of a path that may not exist.
 *
 * Node keys its module cache by realpath, so `/tmp/x` and `/private/tmp/x` are
 * two different modules. Everything here canonicalises before comparing.
 *
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		if (parent === absolute) return absolute;
		try {
			return join(realpathSync(parent), basename(absolute));
		} catch {
			return absolute;
		}
	}
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Normalize a `file:` URL the way Node keys its cache.
 *
 * @param {string} url
 * @returns {string} the canonical `file:` URL, or `url` unchanged.
 */
export function canonicalUrl(url) {
	if (typeof url !== "string" || !url.startsWith("file:")) return url;
	try {
		return pathToFileURL(realpathSync(fileURLToPath(url))).href;
	} catch {
		return url;
	}
}

/**
 * True when `file` (absolute path or `file:` URL) is `dir` or lives under it.
 *
 * Compares whole path segments, so `/a/plug` never matches `/a/plugin`.
 *
 * @param {string} file
 * @param {string} dir canonical absolute directory
 * @returns {boolean}
 */
export function isInside(file, dir) {
	let target = String(file);
	if (target.startsWith("file:")) {
		try {
			target = fileURLToPath(target);
		} catch {
			return false;
		}
	}
	target = canonicalPath(target);
	const root = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
	if (target === root) return true;
	return target.startsWith(root + sep);
}

function errorText(error) {
	if (error instanceof Error) return error.message || String(error);
	if (error === undefined) return "unknown error";
	try {
		return String(error);
	} catch {
		return "unknown error";
	}
}

function isCodeFile(path) {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return false;
	return CODE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

// ── Internal loader access ─────────────────────────────────────────────────

/** Cached direct handle on the Node internal ESM loader. */
let internalCache;
let internalProbed = false;

/**
 * Classify a loader by the module-job API it owns.
 *
 * The shape is decided by which method exists, never by the Node version:
 * `v2` landed in 24.12, so a major-version test mistags 24.0–24.11.
 *
 * @param {any} loader
 * @returns {"v1"|"v2"|null}
 */
export function loaderShape(loader) {
	if (!loader) return null;
	if (typeof loader.getOrCreateModuleJob === "function") return "v2";
	if (typeof loader.getModuleJobForImport === "function") return "v1";
	return null;
}

function requireInternal() {
	try {
		return require("internal/modules/esm/loader");
	} catch {}
	// Desktop builds ship a native builtin resolver for processes started
	// without `--expose-internals`.
	try {
		return createRequire(import.meta.url)("node-addon-require-builtin").requireBuiltin("internal/modules/esm/loader");
	} catch {}
	return null;
}

function fromInternals() {
	if (internalProbed) return internalCache ?? null;
	internalProbed = true;
	const [major] = String(process.versions.node).split(".").map(Number);
	if (!Number.isFinite(major) || major < 22) return null;
	const raw = requireInternal()?.getOrInitializeCascadedLoader?.();
	if (!raw) return null;
	const version = loaderShape(raw);
	if (version === null) return null;
	try {
		Object.defineProperty(raw, "version", { value: version, configurable: true, writable: true });
	} catch {
		raw.version = version;
	}
	internalCache = raw;
	return raw;
}

/**
 * Locate the running Node internal ESM loader.
 *
 * `ctx.loader.internal` wins when a Cordis Loader is present; otherwise ask
 * Node directly, which needs `--expose-internals` (the Desktop Host sets it).
 *
 * @param {any} [ctx]
 * @returns {any|null} the loader, tagged with `version: "v1"|"v2"`.
 */
export function getInternalLoader(ctx) {
	try {
		const internal = ctx?.loader?.internal;
		if (internal) {
			const version = loaderShape(internal);
			if (version !== null) return internal.version === version ? internal : tag(internal, version);
		}
	} catch {}
	return fromInternals();
}

function tag(internal, version) {
	try {
		Object.defineProperty(internal, "version", { value: version, configurable: true, writable: true });
	} catch {}
	return internal;
}

/** The raw cache Map behind an internal loader, whichever shape it has. */
function loadCacheOf(internal) {
	const cache = internal?.loadCache;
	if (!cache) return null;
	if (typeof cache.get !== "function" || typeof cache[Symbol.iterator] !== "function") return null;
	return cache;
}

/**
 * Explicit capability probe used by the agent tool.
 *
 * @param {any} [ctx]
 * @returns {{ok: boolean, reason?: string, shape?: "v1"|"v2", cacheSize?: number, via?: string}}
 */
export function canReload(ctx) {
	const via = (() => {
		try {
			return ctx?.loader?.internal ? "ctx.loader.internal" : "internal/modules/esm/loader";
		} catch {
			return "internal/modules/esm/loader";
		}
	})();
	let internal;
	try {
		internal = getInternalLoader(ctx);
	} catch (error) {
		return { ok: false, reason: `internal loader unavailable: ${errorText(error)}` };
	}
	if (!internal) {
		return {
			ok: false,
			reason: "no internal ESM loader: start the Host with --expose-internals (or install node-addon-require-builtin)",
			via,
		};
	}
	const shape = loaderShape(internal);
	if (shape === null) {
		return { ok: false, reason: "unsupported internal loader shape (neither getOrCreateModuleJob nor getModuleJobForImport)", via };
	}
	const cache = loadCacheOf(internal);
	if (!cache) return { ok: false, reason: "internal loader exposes no module load cache", via };
	let size = -1;
	try {
		size = Map.prototype ? cacheSize(cache) : -1;
	} catch {}
	return { ok: true, shape, cacheSize: size, via };
}

function cacheSize(cache) {
	try {
		const direct = cache.size;
		if (typeof direct === "number") return direct;
	} catch {}
	try {
		const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cache), "size");
		if (descriptor?.get) return descriptor.get.call(cache);
	} catch {}
	return -1;
}

/**
 * Resolve a specifier against a parent URL using the *internal* loader.
 *
 * @param {any} internal
 * @param {string} specifier
 * @param {string} parentURL
 * @returns {Promise<string|null>}
 */
async function internalResolve(internal, specifier, parentURL) {
	try {
		if (typeof internal.resolveSync === "function") {
			return internal.resolveSync(parentURL, { specifier, attributes: {} });
		}
		if (typeof internal.resolve === "function") {
			return await internal.resolve(specifier, parentURL, {});
		}
	} catch {}
	return null;
}

/**
 * Import through the internal loader (which is what `EntryTree.import` does
 * when internals are present) so the module lands in the same cache we evict.
 *
 * @param {any} internal
 * @param {string} urlOrSpecifier
 * @param {string} parentURL
 * @returns {Promise<any>} module namespace
 */
async function internalImport(internal, urlOrSpecifier, parentURL) {
	if (typeof internal.import === "function") return await internal.import(urlOrSpecifier, parentURL, {});
	return await import(urlOrSpecifier);
}

// ── Module graph ───────────────────────────────────────────────────────────

/**
 * Every module URL the load cache holds inside `dir`.
 *
 * The cache is authoritative: if a file was imported it has a job, and the
 * job's URL is the realpath-keyed one we must evict.
 *
 * @param {Map} cache
 * @param {string} dir canonical absolute directory
 * @returns {string[]}
 */
function cachedUrlsInside(cache, dir) {
	const urls = [];
	let entries;
	try {
		entries = Map.prototype.keys.call(cache);
	} catch {
		try {
			entries = cache.keys();
		} catch {
			return urls;
		}
	}
	for (const url of entries) {
		if (typeof url !== "string" || !url.startsWith("file:")) continue;
		if (isInside(url, dir)) urls.push(url);
	}
	return urls;
}

/**
 * Walk the `ModuleJob` link graph from a root URL and collect the URLs that
 * live inside `dir`.
 *
 * Mirrors dsh-hmr's `loadDependencies`: a visited set prevents cycles, and
 * `node:` modules and foreign `node_modules` trees are not traversed. Here the
 * boundary is the caller's directory rather than "anything but node_modules",
 * so a link-installed sibling package is never touched.
 *
 * @param {Map} cache
 * @param {string} rootUrl
 * @param {string} dir canonical absolute directory
 * @returns {Promise<Set<string>>} reachable URLs under `dir`
 */
async function collectSubtree(cache, rootUrl, dir) {
	const found = new Set();
	const visited = new Set();
	const queue = [rootUrl];

	while (queue.length > 0) {
		const url = queue.shift();
		if (visited.has(url)) continue;
		visited.add(url);
		if (typeof url !== "string" || url.startsWith("node:")) continue;
		if (!url.startsWith("file:") || !isInside(url, dir)) continue;
		found.add(url);

		let job;
		try {
			job = Map.prototype.get ? Map.prototype.get.call(cache, url) : cache.get(url);
		} catch {
			job = undefined;
		}
		if (!job) continue;

		let linked;
		try {
			linked = await job.linked;
		} catch (error) {
			// A module whose linking failed has no children to walk.
			continue;
		}
		if (!linked) continue;
		for (const child of Array.prototype.slice.call(linked)) {
			const childUrl = typeof child === "string" ? child : child?.url;
			if (typeof childUrl === "string" && !visited.has(childUrl)) queue.push(childUrl);
		}
		// The raw job sometimes keeps the ids it was linked from.
		for (const key of ["linkedIds", "dependencySpecifiers"]) {
			const extra = job[key];
			if (!extra) continue;
			for (const value of Array.prototype.slice.call(extra)) {
				const candidate = typeof value === "string" ? value : value?.url;
				if (typeof candidate === "string" && candidate.startsWith("file:") && !visited.has(candidate)) queue.push(candidate);
			}
		}
	}
	return found;
}

// ── Cache eviction ─────────────────────────────────────────────────────────

/**
 * Remove the given module URLs from the ESM load cache and the CJS twins from
 * `require.cache`, keeping a backup so the move can be undone exactly.
 *
 * `Map.prototype.delete.call(...)` is used rather than `loadCache.delete`
 * because Node 24+ wraps the cache in a `LoadCache` class whose own `delete`
 * only blanks one type slot, and whose prototypes are `LoadCache`/`SafeMap` —
 * it is not a `Map` subclass, so the borrowed method must be applied
 * generically. It works on plain `Map` caches (Node 22/23) too.
 *
 * @param {Map} cache
 * @param {Iterable<string>} urls
 * @returns {{evicted: number, esmBackup: Map<string, any>, cjsBackup: Map<string, any>}}
 */
function evict(cache, urls) {
	const esmBackup = new Map();
	const cjsBackup = new Map();
	let evicted = 0;

	for (const url of urls) {
		let job;
		let present = false;
		try {
			job = Map.prototype.get.call(cache, url);
			present = Map.prototype.has.call(cache, url);
		} catch {
			try {
				job = cache.get(url);
				present = job !== undefined;
			} catch {
				continue;
			}
		}
		if (!present && job === undefined) continue;
		esmBackup.set(url, job);
		try {
			Map.prototype.delete.call(cache, url);
		} catch {
			try {
				const own = Object.getPrototypeOf(cache).delete;
				own.call(cache, url);
			} catch {}
		}
		evicted += 1;

		try {
			const filepath = fileURLToPath(url);
			const twin = require.cache?.[filepath];
			if (twin) {
				cjsBackup.set(filepath, twin);
				Reflect.deleteProperty(require.cache, filepath);
			}
		} catch {}
	}
	return { evicted, esmBackup, cjsBackup };
}

function restore(cache, { esmBackup, cjsBackup }) {
	for (const [url, job] of esmBackup) {
		try {
			Map.prototype.set.call(cache, url, job);
		} catch {
			try {
				cache.set(url, job);
			} catch {}
		}
	}
	for (const [filepath, twin] of cjsBackup) {
		try {
			if (require.cache) require.cache[filepath] = twin;
		} catch {}
	}
}

// ── Loader entries ─────────────────────────────────────────────────────────

function entryName(entry) {
	const name = entry?.options?.name;
	return typeof name === "string" ? name : null;
}

/**
 * Normalize a loader `baseUrl` to a specifier string.
 *
 * Cordis keeps whatever URL instance the caller configured — `Loader` does
 * `this.ctx.baseUrl = config.baseUrl` and `Context#extend` copies it — so it is
 * a `URL` object, not a string, in every real Host. Both forms, plus a plain
 * absolute path, are accepted here.
 *
 * @param {unknown} baseUrl
 * @returns {string|null} a URL string usable as a resolution base
 */
function baseUrlString(baseUrl) {
	if (typeof baseUrl === "string" && baseUrl.length > 0) return baseUrl;
	if (baseUrl instanceof URL) return baseUrl.href;
	if (baseUrl && typeof baseUrl === "object" && typeof baseUrl.href === "string" && baseUrl.href.length > 0) {
		return baseUrl.href;
	}
	return null;
}

/**
 * Resolve the module URL an entry loads, using the loader's own resolution
 * first (so `./plug.mjs` resolves against that entry's tree base URL) and the
 * internal loader second.
 *
 * @param {any} loader
 * @param {any} internal
 * @param {any} entry
 * @returns {Promise<string|null>}
 */
async function resolveEntryUrl(loader, internal, entry) {
	const name = entryName(entry);
	if (name === null || name.startsWith("cordis:")) return null;

	// 1. The entry's own tree context, exactly as EntryTree.import resolves.
	const treeCtx = entry?.parent?.tree?.ctx ?? entry?.parent?.tree?.context;
	const baseUrl = baseUrlString(treeCtx?.baseUrl ?? entry?.ctx?.baseUrl ?? entry?.parent?.ctx?.baseUrl);
	if (baseUrl !== null) {
		try {
			if (name.startsWith(".") || isAbsolute(name)) return canonicalUrl(new URL(name, baseUrl).href);
			const resolved = await internalResolve(internal, name, baseUrl);
			const fallback = isAbsolute(name) || name.startsWith("file:") ? null : new URL(name, baseUrl).href;
			if (resolved) return canonicalUrl(resolved);
			if (fallback) return canonicalUrl(fallback);
		} catch {}
	}
	// 2. The internal loader, rooted at the module that asked.
	if (baseUrl !== null) {
		const resolved = await internalResolve(internal, name, baseUrl);
		if (resolved) return canonicalUrl(resolved);
	}
	// 3. Last resort: a bare absolute path or a file: URL.
	try {
		if (name.startsWith("file:")) return canonicalUrl(name);
		if (isAbsolute(name)) return canonicalUrl(pathToFileURL(name).href);
	} catch {}
	return null;
}

/**
 * Every loader entry whose module resolves into `dir`.
 *
 * @param {any} ctx
 * @param {any} internal
 * @param {string} dir
 * @returns {Promise<Array<{entry:any, url:string, id:string}>>}
 */
async function entriesInside(ctx, internal, dir) {
	const loader = ctx?.loader;
	if (!loader || typeof loader.entries !== "function") return [];
	let rows;
	try {
		rows = [...loader.entries()];
	} catch {
		return [];
	}
	const matched = [];
	for (const entry of rows) {
		try {
			if (!entry || entry.disabled) continue;
			const name = entryName(entry);
			if (name === null) continue;
			// Cheap pre-filter: an entry that is not a path likewise cannot be
			// in `dir` unless it is a package installed *inside* it.
			const looksLikePath = name.startsWith(".") || name.startsWith("/") || name.startsWith("file:") || name.includes(sep);
			const packageDir = dir + sep;
			if (!looksLikePath && !name.includes(packageDir)) {
				// A bare package name can match this dir if dir itself is that package,
				// or if it lives in dir/node_modules.
				const isSelfPackage = basename(dir) === name || isFile(join(dir, "package.json"));
				if (!isSelfPackage && !isDirectory(join(dir, "node_modules", name))) continue;
			}
			const url = await resolveEntryUrl(loader, internal, entry);
			// No URL means we cannot re-import it; restarting such an entry
			// would replay a stale module, so it is not a reload candidate.
			if (url === null || !isInside(url, dir)) continue;
			matched.push({ entry, url, id: String(entry?.id ?? name) });
		} catch {}
	}
	return matched;
}

/**
 * Remember what is needed to put an entry's fiber back exactly as it was.
 *
 * @param {{entry:any, url:string, id:string}} row
 */
function snapshotEntry({ entry, url, id }) {
	const fiber = entry?.fiber;
	const runtime = fiber ? safeRegistryGet(entry?.ctx, fiber.runtime?.callback) : undefined;
	return {
		entry,
		url,
		id,
		parentContext: fiber?.parent ?? entry?.parent?.ctx ?? null,
		previousPlugin: fiber?.runtime?.callback,
		config: entry?.options?.config ?? fiber?._config,
		fiber,
		runtime,
		hadFiber: Boolean(fiber),
	};
}

function safeRegistryGet(ctx, plugin) {
	if (plugin === undefined || plugin === null) return undefined;
	try {
		return ctx?.registry?.get(plugin);
	} catch {
		return undefined;
	}
}

/**
 * Call-site frames for Cordis error composition.
 *
 * Cordis treats this as a *function* and may call it more than once, with no
 * arguments (`handleError` splices the frames into a thrown error, and the
 * fiber's catch path composes again). So it must be a fresh zero-argument
 * function each time — never a captured array.
 *
 * @param {any} entry the loader entry whose module is starting
 * @returns {() => string[]}
 */
function outerStackFor(entry) {
	const fallback = [`    at ${typeof entry?.options?.name === "string" ? entry.options.name : "plugin-updater"}`];
	return () => {
		try {
			const own = entry?.getOuterStack?.();
			if (Array.isArray(own) && own.length > 0) return own;
		} catch {}
		return fallback;
	};
}

/**
 * Loader shape of the returned wrapper from `ctx.plugin()`.
 *
 * `ctx.plugin()` returns a `Fiber` wrapped in `Object.create(fiber)` with a
 * `then` hook, so `wrapper.ctx.fiber` is the real fiber and `wrapper.uid` is
 * inherited from it (the fiber clears its own `uid` on dispose). A disposed
 * fiber therefore reads as `null`; an active one as a number, `0` being root.
 */
function fiberOf(returned) {
	if (!returned) return null;
	try {
		const fiber = returned.ctx?.fiber ?? returned;
		return typeof fiber?.uid === "number" ? fiber : null;
	} catch {
		return null;
	}
}

/**
 * Stop whatever the snapshot's entry currently runs.
 *
 * Prefers the registry record of the plugin object we know about (the same
 * route dsh-hmr takes: `registry.delete(plugin)` then await each fiber), and
 * falls back to the single remembered fiber when the registry no longer knows
 * the plugin. Every step is guarded — a plugin whose cleanup throws must not
 * block the restart.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof snapshotEntry>} snapshot
 */
async function retire(ctx, snapshot) {
	const plugin = snapshot.previousPlugin;
	const registry = safeRegistryGet(ctx, plugin) ?? snapshot.runtime ?? null;
	if (snapshot.entry) snapshot.entry.fiber = null;

	// `registry.fibers` is a `DisposableList`: iterable, but with no index
	// access (`fibers[0]` is undefined), so iterate — never index.
	const fibers = [];
	if (registry?.fibers && typeof registry.fibers[Symbol.iterator] === "function") fibers.push(...registry.fibers);
	if (snapshot.fiber) fibers.push(snapshot.fiber);

	try {
		if (registry) ctx.registry?.delete?.(plugin);
	} catch {}

	for (const fiber of new Set(fibers)) {
		try {
			await fiber?.dispose?.();
		} catch {}
		try {
			await fiber?.await?.();
		} catch {
			// A throwing startup error was already reported; it does not mean
			// the fiber is still running.
		}
	}
}

/**
 * Start `plugin` for one entry, under the entry's own parent context and with
 * the entry's raw config, then give the fiber the entry identity: this is what
 * keeps the loader row's id, position and settings after a reload.
 *
 * @param {any} ctx
 * @param {any} loader
 * @param {ReturnType<typeof snapshotEntry>} snapshot
 * @param {any} plugin
 * @returns {Promise<any>} the new fiber
 * @throws when the plugin rejects its config or throws while starting
 */
async function start(ctx, loader, snapshot, plugin) {
	const { entry, config, parentContext } = snapshot;
	// dsh-hmr's route: the *owning context* starts the plugin, so the new
	// fiber is a sibling of the old one (same parent fiber, same isolate
	// chain) instead of a new child of the loader entry. `RegistryService`
	// itself carries no context, so the owning context comes from the parent
	// fiber, falling back to the entry's own context.
	const owner = parentContext?.fiber?.ctx ?? parentContext?.ctx ?? ctx;
	if (!owner) throw new Error("no owning context to start the plugin in");
	const registry = owner.registry;
	if (!registry?.plugin) throw new Error("no registry to start the plugin with");

	const fiber = fiberOf(registry.plugin(plugin, config, outerStackFor(entry)));
	if (entry && fiber) {
		fiber.entry = entry;
		entry.fiber = fiber;
	}
	if (fiber) await fiber.await();
	return fiber;
}

/**
 * Bring one entry to a defined state: stop the old instance, optionally start
 * a replacement, and always re-attach the entry identity on success.
 *
 * @param {any} ctx
 * @param {any} loader
 * @param {ReturnType<typeof snapshotEntry>} snapshot
 * @param {any} plugin the plugin object to (re)activate; `undefined` only stops
 * @returns {Promise<any>} the new fiber (or `undefined` when nothing ran)
 */
async function activate(ctx, loader, snapshot, plugin) {
	await retire(ctx, snapshot);
	if (plugin === undefined || plugin === null) return undefined;
	return await start(ctx, loader, snapshot, plugin);
}

/**
 * Re-import the entry's module and normalize its exports the way the loader
 * does, so a default export, a named export or a CJS module all work.
 *
 * @param {any} loader
 * @param {any} internal
 * @param {string} url
 * @param {any} entry
 */
/**
 * Wait until a file's bytes stop changing, then return its identity.
 *
 * `fs.watch` (and a debounce) can fire while an editor is still writing, or
 * before the kernel makes the new bytes visible: a reload started then would
 * re-import the file we were asked to replace. Both `stat` and a full read are
 * used because mtime granularity is coarse on some filesystems — a same-size,
 * same-millisecond write still changes content.
 *
 * @param {string} file absolute path
 * @param {number} [attempts] how many observations to compare
 * @param {number} [delayMs]
 * @returns {Promise<void>}
 */
async function settleFile(file, attempts = 3, delayMs = 15) {
	if (typeof file !== "string") return;
	let previous = null;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		let current;
		try {
			const stat = await statPromises(file);
			const content = await readPromises(file);
			current = `${stat.mtimeMs}:${stat.size}:${content.length}:${hash(content)}`;
		} catch {
			// Missing or unreadable: nothing to wait for, the import will report it.
			return;
		}
		if (previous !== null && current === previous) return;
		previous = current;
		await sleep(delayMs);
	}
}

/** Cheap stable fingerprint of a Buffer, without node:crypto. */
function hash(buffer) {
	let value = 0;
	for (let index = 0; index < buffer.length; index += 1) {
		value = (value * 31 + buffer[index]) | 0;
	}
	return value;
}

/**
 * Await a short real delay.
 *
 * The timer is deliberately NOT `unref()`d: an unref'd timer does not keep the
 * event loop alive, so awaiting one in a process with nothing else pending
 * never settles (the process exits with an unsettled top-level await instead).
 *
 * @param {number} ms
 */
function sleep(ms) {
	return new Promise((done) => setTimeout(done, ms));
}

async function importPlugin(loader, internal, url, entry) {
	const treeCtx = entry?.parent?.tree?.ctx ?? entry?.parent?.tree?.context;
	const baseUrl = baseUrlString(treeCtx?.baseUrl ?? entry?.ctx?.baseUrl) ?? url;
	const namespace = await internalImport(internal, url, baseUrl);
	if (typeof loader?.unwrapExports === "function") return loader.unwrapExports(namespace);
	return namespace?.default ?? namespace;
}

async function awaitLoader(loader) {
	try {
		if (typeof loader?.await === "function") await loader.await();
	} catch (error) {
		logDebug("loader.await() rejected: " + errorText(error));
	}
}

function logDebug(message) {
	try {
		if (process.env.DSH_PLUGIN_UPDATER_DEBUG) console.debug("[plugin-updater] " + message);
	} catch {}
}

// ── The public surface ─────────────────────────────────────────────────────

/**
 * @typedef {object} ReloadRequest
 * @property {string} name plugin package name, used for reporting
 * @property {string} dir absolute package directory (or file) whose modules to invalidate
 * @property {string} [changedFile] only reload when this file belongs to `dir`
 * @property {number} [generation] previous generation to increment
 */

/**
 * @typedef {object} ReloadResult
 * @property {string} name
 * @property {"reloaded"|"unchanged"|"unsupported"|"failed"} status
 * @property {number} [generation] increments per successful reload
 * @property {string[]} [entries] loader entry ids restarted
 * @property {number} [invalidated] module cache entries evicted
 * @property {string} [error]
 * @property {number} [at] epoch ms
 */

/** Generation counter per canonical directory, so a reload reports "the n-th". */
const generations = new Map();

function targetDirectory(request) {
	const dir = request?.dir;
	if (typeof dir !== "string" || dir.length === 0) return null;
	if (dir.startsWith("file:")) {
		try {
			return canonicalPath(fileURLToPath(dir));
		} catch {
			return null;
		}
	}
	return canonicalPath(dir);
}

/**
 * Reload one plugin directory in place.
 *
 * Never rejects: every outcome is a `ReloadResult`. Concurrent calls are
 * serialized process-wide, and a call made while another is in flight simply
 * queues behind it.
 *
 * @param {any} ctx the running Cordis context
 * @param {ReloadRequest} request
 * @returns {Promise<ReloadResult>}
 */
export async function reloadPlugin(ctx, request) {
	const name = typeof request?.name === "string" && request.name ? request.name : String(request?.dir ?? "unknown");

	try {
		return await serialize(() => exclusive(ctx, () => reloadLocked(ctx, request, name)));
	} catch (error) {
		return { name, status: "failed", error: errorText(error), at: Date.now() };
	}
}

/**
 * Run `operation` inside `hmr.runExclusive` when an HMR service is present and
 * we are not already inside one of its transactions.
 *
 * @param {any} ctx
 * @param {() => Promise<ReloadResult>} operation
 */
async function exclusive(ctx, operation) {
	let hmr;
	try {
		hmr = typeof ctx?.get === "function" ? ctx.get("hmr") : ctx?.hmr;
	} catch {
		hmr = undefined;
	}
	if (!hmr || typeof hmr.runExclusive !== "function") return await operation();

	let nested = false;
	try {
		nested = hmr.executing?.getStore?.() === true;
	} catch {}
	if (nested) return await operation();

	try {
		return await hmr.runExclusive(operation);
	} catch (error) {
		// Nesting detected from inside (a different HMR instance), or HMR is
		// disposed: neither means the work is invalid — do it directly.
		const text = errorText(error);
		if (/nested|disposed/i.test(text)) return await operation();
		throw error;
	}
}

/**
 * The body of a reload. Runs with the queue held.
 *
 * @param {any} ctx
 * @param {ReloadRequest} request
 * @param {string} name
 * @returns {Promise<ReloadResult>}
 */
async function reloadLocked(ctx, request, name) {
	const dir = targetDirectory(request);
	if (dir === null) return { name, status: "failed", error: "request.dir must be an absolute path", at: Date.now() };

	if (typeof request?.changedFile === "string" && request.changedFile.length > 0 && !isInside(request.changedFile, dir)) {
		return { name, status: "unchanged", invalidated: 0, entries: [], at: Date.now() };
	}

	const internal = getInternalLoader(ctx);
	if (!internal) {
		return {
			name,
			status: "unsupported",
			error: "not running with --expose-internals (set it, or install node-addon-require-builtin)",
			at: Date.now(),
		};
	}
	const cache = loadCacheOf(internal);
	if (!cache) return { name, status: "unsupported", error: "internal loader exposes no module load cache", at: Date.now() };

	const loader = (() => {
		try {
			return ctx?.loader ?? null;
		} catch {
			return null;
		}
	})();

	// 1. Which entries own this directory? Snapshot them before touching code.
	let rows = await entriesInside(ctx, internal, dir);
	if (rows.length === 0) {
		// No loader entry claims the directory, so there is no fiber to
		// restart and no config or identity to preserve. Evicting on its own
		// cannot make anything new run — the already-imported namespace stays
		// bound to its old objects — so the only honest report is "nothing to
		// refresh". (A first load of that directory after this call will read
		// the new files, which is exactly what "unchanged" implies.)
		return { name, status: "unchanged", invalidated: 0, entries: [], at: Date.now() };
	}

	const snapshots = rows.map(snapshotEntry);

	// 2. Collect the subtree, rooted at each entry module, bounded by `dir`.
	const targets = new Set();
	for (const snapshot of snapshots) {
		for (const url of await collectSubtree(cache, snapshot.url, dir)) targets.add(url);
	}
	for (const url of cachedUrlsInside(cache, dir)) targets.add(url);
	if (targets.size === 0) {
		// Entry modules exist but nothing under the directory is loaded yet:
		// the plugin is still starting, so there is nothing stale to replace.
		return { name, status: "unchanged", invalidated: 0, entries: snapshots.map((s) => s.id), at: Date.now() };
	}

	// 3. Evict, then re-import every entry from disk.
	const { evicted, esmBackup, cjsBackup } = evict(cache, [...targets]);
	const backup = { esmBackup, cjsBackup, evicted };
	const started = [];

	try {
		// The caller may have been woken by a filesystem event that raced the
		// write itself; never re-import a file that is still being written.
		for (const url of targets) {
			if (url.startsWith("file:")) await settleFile(fileURLToPath(url));
		}

		const next = [];
		for (const snapshot of snapshots) {
			let plugin;
			let lastError;
			for (let attempt = 0; attempt <= SETTLE_RETRIES; attempt += 1) {
				try {
					plugin = await importPlugin(loader, internal, snapshot.url, snapshot.entry);
					lastError = undefined;
					break;
				} catch (error) {
					lastError = error;
				}
			}
			if (lastError) throw decorate(lastError, snapshot);
			next.push({ snapshot, plugin });
		}

		// 4. Restart the fibers, transactionally.
		for (const { snapshot, plugin } of next) {
			started.push({ snapshot, plugin });
			await activate(ctx, loader, snapshot, plugin);
		}
	} catch (error) {
		const rollbackError = await rollback(ctx, loader, cache, started, backup);
		const result = {
			name,
			status: "failed",
			invalidated: evicted,
			entries: snapshots.map((s) => s.id),
			error: errorText(error),
			rolledBack: rollbackError === null,
			at: Date.now(),
		};
		if (rollbackError !== null) result.rollbackError = rollbackError;
		return result;
	}

	await awaitLoader(loader);

	const generation = (generations.get(dir) ?? 0) + 1;
	generations.set(dir, generation);
	notifyHmr(ctx, { name, dir, entries: snapshots.map((s) => s.id) });

	return {
		name,
		status: "reloaded",
		generation,
		entries: snapshots.map((s) => s.id),
		invalidated: evicted,
		at: Date.now(),
	};
}

function decorate(error, snapshot) {
	if (error instanceof Error && !/^\[plugin-updater\]/.test(error.message)) {
		error.message = `[plugin-updater] ${snapshot.id}: ${error.message}`;
	}
	return error;
}

/**
 * Undo a partial reload: tear down whatever the replacement started, restore
 * the evicted modules so the next import sees the old code again, then put the
 * previous plugin object back where it ran.
 *
 * Steps are individually guarded: one failing step must not stop the others,
 * because the goal is to leave the Host as close to "before" as possible.
 *
 * @param {any} ctx
 * @param {any} loader
 * @param {Map} cache the internal load cache
 * @param {Array<{snapshot: any, plugin: any}>} started entries already re-activated
 * @param {{esmBackup: Map, cjsBackup: Map, evicted: number}} backup
 * @returns {Promise<string|null>} the first rollback error, or null when clean
 */
async function rollback(ctx, loader, cache, started, backup) {
	let rollbackError = null;
	const note = (error) => {
		rollbackError ??= errorText(error);
	};

	// 1. Stop the replacement fibers (including half-started ones).
	for (const { snapshot } of [...started].reverse()) {
		try {
			await activate(ctx, loader, snapshot, undefined);
		} catch (error) {
			note(error);
		}
	}

	// 2. Put every evicted job back, so `import()` yields the previous code.
	restore(cache, backup);

	// 3. Re-activate the previous plugin object for each entry that had one.
	for (const { snapshot } of [...started].reverse()) {
		if (!snapshot.hadFiber || snapshot.previousPlugin === undefined) continue;
		try {
			snapshot.entry.fiber = null;
			await activate(ctx, loader, snapshot, snapshot.previousPlugin);
		} catch (error) {
			note(error);
		}
	}
	return rollbackError;
}

function notifyHmr(ctx, info) {
	try {
		if (typeof ctx?.emit === "function") ctx.emit("plugin-updater/reload", info);
	} catch {}
}

/**
 * Reload several directories, one after another, in the order given.
 *
 * Each request gets its own result; a failure never stops the batch.
 *
 * @param {any} ctx
 * @param {ReloadRequest[]} requests
 * @returns {Promise<ReloadResult[]>}
 */
export async function reloadMany(ctx, requests) {
	const list = Array.isArray(requests) ? requests : requests ? [requests] : [];
	const results = [];
	for (const request of list) {
		const name = typeof request?.name === "string" && request.name ? request.name : String(request?.dir ?? "unknown");
		try {
			results.push(await reloadPlugin(ctx, request));
		} catch (error) {
			results.push({ name, status: "failed", error: errorText(error), at: Date.now() });
		}
	}
	return results;
}

/**
 * Pending count of the process-wide reload queue. For tests and diagnostics.
 *
 * @returns {Promise<void>} resolves when every queued reload settled
 */
export function whenIdle() {
	return queue.then(noop, noop);
}

export { CODE_EXTENSIONS, isDirectory, errorText };
