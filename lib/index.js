/**
 * dsh-plugin-updater — keep the current profile's plugins current, and make
 * locally-developed ones refresh without restarting the Harness.
 *
 * ## The two problems it solves
 *
 * **npm plugins.** A profile installs bundle packages from a registry. Once
 * they are installed there is nothing that ever tells you a newer version
 * exists: the plugin manager's own pages answer "what is installed", not "what
 * is available". This plugin asks the registry and reports the difference,
 * leaving the decision to you (`autoUpdateRegistry` is off by default, because
 * replacing code that is currently running is not a background decision).
 *
 * **Local development.** A plugin under active work is installed as a
 * `link:` dependency, so the profile's `node_modules` points at the working
 * copy. Nothing watches that copy: the profile's `hmr` row is configured with
 * `root: []`, so module files are not watched at all — only `cordis.patch.yml`
 * and `package.json` are. Every source edit therefore used to need a full
 * Harness restart before it could be observed. This plugin closes that gap:
 * it watches the directories the profile already points at, and on a change it
 * evicts the plugin's modules from the running Node module cache and restarts
 * its fibers in place. Same process, same profile, new code.
 *
 * ## Why evicting at all is necessary
 *
 * Node caches an ES module by URL and never re-reads a file. `ctx.loader`
 * imports plugin modules through the same cache, so re-importing a plugin after
 * editing it returns the *old* module object — that is why a restart was the
 * only reliable way to see a change. Deleting the URL from the internal load
 * cache makes the next `import()` read the file again; the rest of the reload
 * is bookkeeping: stop the old fibers, activate the new module with the same
 * config, and put the new fiber where the loader expects it.
 *
 * The whole mechanism lives in `./reload.js`, which also owns the rollback:
 * if the new code throws, the previous module graph is restored and the
 * previous plugin object is re-activated, so a broken edit leaves the Host
 * exactly as it was instead of taking a plugin down.
 *
 * @module dsh-plugin-updater
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import z from "@deepseek-ai/schemastery";
import { listInstalled } from "./inventory.js";
import { reloadMany, canReload } from "./reload.js";
import { readUpdateHistory, recordUpdateHistory } from "./history.js";
import { createWatcher } from "./watch.js";

/** Cordis plugin name; the loader records it against the running entry. */
export const name = "plugin-updater";

/**
 * `tools` is what the agent-facing `plugin_update` tool registers into.
 * Everything else — the loader, the plugin manager, HMR — is looked up lazily,
 * because this plugin must stay usable in a profile that has none of them.
 */
export const inject = ["tools"];

/** Runtime defaults. The schemastery schema below reads these, so a config-less
 * loader row and an omitted field behave identically. */
export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	checkRegistry: true,
	checkIntervalMinutes: 360,
	autoUpdateRegistry: false,
	onlyEnabled: true,
	registries: [],
	includePrerelease: false,
	timeoutMs: 20000,
	watchLocal: true,
	debounceMs: 400,
	extraWatchDirs: [],
	ignored: [".git", ".cache", "coverage", "dist", "build"],
	watchExtensions: [".js", ".mjs", ".cjs", ".json", ".ts", ".tsx", ".css"],
	log: true,
});

/**
 * Mark one schema field as settings-page editable.
 *
 * Volatile fields are served by the Host settings service under this plugin's
 * loader entry id (`plugin-updater`) and are editable in the Plugins page
 * WITHOUT a restart: the settings service commits a volatile change into the
 * running fiber's config object instead of remounting the plugin. That is what
 * makes the frequency control in the UI take effect immediately.
 *
 * Volatile edits do not re-run `apply()`, so every value that the watcher or
 * the timer derives from config must be read LAZILY rather than captured once
 * at activation — see `currentConfig()` in `apply()`.
 */
function volatileField(field) {
	return typeof field.volatile === "function" ? field.volatile() : field;
}

export const Config = z.object({
	// ── Settings-page fields (volatile: live, no restart) ──────────────────
	enabled: volatileField(z.boolean().default(DEFAULT_CONFIG.enabled)),
	checkRegistry: volatileField(z.boolean().default(DEFAULT_CONFIG.checkRegistry)),
	/** How often the registry check repeats, in minutes. 0 = only on demand. */
	checkIntervalMinutes: volatileField(
		z.number().min(0).default(DEFAULT_CONFIG.checkIntervalMinutes),
	),
	autoUpdateRegistry: volatileField(z.boolean().default(DEFAULT_CONFIG.autoUpdateRegistry)),
	onlyEnabled: volatileField(z.boolean().default(DEFAULT_CONFIG.onlyEnabled)),
	watchLocal: volatileField(z.boolean().default(DEFAULT_CONFIG.watchLocal)),

	// ── Loader-row fields (a restart-scoped decision, not a toggle) ────────
	registries: z.array(z.string()).default([...DEFAULT_CONFIG.registries]),
	includePrerelease: z.boolean().default(DEFAULT_CONFIG.includePrerelease),
	timeoutMs: z.number().min(1000).default(DEFAULT_CONFIG.timeoutMs),
	debounceMs: z.number().min(0).default(DEFAULT_CONFIG.debounceMs),
	extraWatchDirs: z.array(z.string()).default([...DEFAULT_CONFIG.extraWatchDirs]),
	ignored: z.array(z.string()).default([...DEFAULT_CONFIG.ignored]),
	watchExtensions: z.array(z.string()).default([...DEFAULT_CONFIG.watchExtensions]),
	log: z.boolean().default(DEFAULT_CONFIG.log),
});

/** The single agent-facing tool's actions. */
const ACTIONS = ["status", "check", "refresh", "update", "watch", "unwatch"];

/**
 * Normalize a raw loader-row config into the exact shape the runtime code
 * below reads. Cordis has already validated through `Config` before `apply`
 * runs, so this is a belt-and-braces normalizer for direct construction in
 * tests, and it never throws.
 *
 * @param raw - whatever the loader row carried.
 * @returns a complete config object.
 */
export function resolveConfig(raw) {
	const config = { ...DEFAULT_CONFIG };
	if (raw === null || typeof raw !== "object") return config;
	const pick = (key, test) => {
		const value = raw[key];
		if (test(value)) config[key] = value;
	};
	pick("enabled", (v) => typeof v === "boolean");
	pick("checkRegistry", (v) => typeof v === "boolean");
	pick("checkIntervalMinutes", (v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
	pick("autoUpdateRegistry", (v) => typeof v === "boolean");
	pick("onlyEnabled", (v) => typeof v === "boolean");
	pick("includePrerelease", (v) => typeof v === "boolean");
	pick("watchLocal", (v) => typeof v === "boolean");
	pick("log", (v) => typeof v === "boolean");
	pick("debounceMs", (v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
	pick("timeoutMs", (v) => typeof v === "number" && Number.isFinite(v) && v >= 1000);
	pick("registries", (v) => Array.isArray(v) && v.every((s) => typeof s === "string"));
	pick("extraWatchDirs", (v) => Array.isArray(v) && v.every((s) => typeof s === "string"));
	pick("ignored", (v) => Array.isArray(v) && v.every((s) => typeof s === "string"));
	pick("watchExtensions", (v) => Array.isArray(v) && v.every((s) => typeof s === "string"));
	// A prune list of extensions is only meaningful when every entry starts with
	// a dot; drop anything else rather than shipping a matcher that never hits.
	config.watchExtensions = config.watchExtensions
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.startsWith("."));
	return config;
}

/**
 * Plugin entry.
 *
 * @param ctx - Cordis context; `ctx.tools` is injected.
 * @param rawConfig - the loader row's config, already validated by `Config`.
 */
export function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);

	/**
	 * The LIVE config.
	 *
	 * A volatile edit from the settings page does not re-run `apply()`: the
	 * settings service writes the new value into the running fiber's validated
	 * config object. Reading `rawConfig` captured here would therefore freeze
	 * the values from activation time and a changed interval would never take
	 * effect until a restart — which would defeat the point of the control.
	 *
	 * Cordis replaces the fiber's config object on every volatile commit, so
	 * this reads through `ctx.fiber.config` each time; falling back to the
	 * activation snapshot keeps direct (non-loader) construction working.
	 *
	 * @returns the current config, re-normalized.
	 */
	const currentConfig = () => {
		let live;
		try {
			live = ctx.fiber?.config;
		} catch {
			live = undefined;
		}
		if (live === undefined || live === null) return config;
		// Volatile-only changes keep the same shape, so normalizing is cheap and
		// protects against a partially persisted row.
		return Object.assign({}, resolveConfig(live), {
			// Loader-row fields are not volatile and cannot change at runtime;
			// keep the activation values so a stale raw row cannot unset them.
			registries: config.registries,
			includePrerelease: config.includePrerelease,
			timeoutMs: config.timeoutMs,
			debounceMs: config.debounceMs,
			extraWatchDirs: config.extraWatchDirs,
			ignored: config.ignored,
			watchExtensions: config.watchExtensions,
		});
	};

	const log = (...args) => {
		if (currentConfig().log) ctx.logger?.info?.(...args);
	};
	const warn = (...args) => ctx.logger?.warn?.(...args);

	if (!config.enabled) {
		log("plugin-updater: disabled by config; nothing armed");
		return;
	}

	/** Last known inventory, so `status` is cheap and `check` can diff. */
	let inventory = null;
	let inventoryAt = 0;
	let checkTimer = null;
	let watcher = null;
	let watching = false;
	/** Per-directory last reload, keyed by absolute dir. */
	const lastReload = new Map();
	/**
	 * This plugin's own package directory.
	 *
	 * Refreshing ourselves would dispose the very fiber that is running the
	 * refresh callback, so the watcher must skip this directory. The answer is
	 * taken from this module's own location — `import.meta.url` points at
	 * `<package>/lib/index.js` no matter how the package was installed
	 * (`link:`, a real directory, or inside the Host) — which is more reliable
	 * than rebuilding it from the loader row. Two forms are kept because a
	 * `link:` install resolves to the working copy, while the profile's
	 * `node_modules` entry is a symlink to it: both must be recognised.
	 */
	const selfDirs = (() => {
		const dirs = new Set();
		try {
			dirs.add(resolve(fileURLToPath(import.meta.url), "../.."));
		} catch {}
		try {
			// The symlink the profile actually loaded us through, when there is
			// one. Compared relative to the profile's node_modules directory.
			const profileDir = ctx.get?.("profileContext")?.dir;
			if (typeof profileDir === "string") dirs.add(resolve(profileDir, "node_modules", name === "" ? "" : "dsh-plugin-updater"));
		} catch {}
		return [...dirs].map((dir) => {
			try {
				return realpathSync(dir);
			} catch {
				return dir;
			}
		});
	})();

	/** True when `dir` is this plugin's own package directory. */
	const isSelf = (dir) => {
		let target = dir;
		try {
			target = realpathSync(dir);
		} catch {}
		return selfDirs.some((own) => target === own || target.startsWith(own + sep));
	};

	const readInventory = async ({ check = false, signal, onlyEnabled } = {}) => {
		const live = currentConfig();
		const isOnlyEnabled = typeof onlyEnabled === "boolean" ? onlyEnabled : live.onlyEnabled;
		const snapshot = await listInstalled(ctx, {
			...live,
			checkRegistry: check || live.checkRegistry,
			onlyEnabled: isOnlyEnabled,
			...(signal === undefined ? {} : { signal }),
		});
		if (snapshot.ok === false && process.env.DSH_PROFILE_DIR) {
			const fallbackSnapshot = await listInstalled({ profileDir: process.env.DSH_PROFILE_DIR }, {
				...live,
				checkRegistry: check || live.checkRegistry,
				onlyEnabled: isOnlyEnabled,
				...(signal === undefined ? {} : { signal }),
			});
			if (fallbackSnapshot.ok) {
				inventory = fallbackSnapshot;
				inventoryAt = Date.now();
				return fallbackSnapshot;
			}
		}
		inventory = snapshot;
		inventoryAt = Date.now();
		return snapshot;
	};

	/**
	 * Refresh one directory of local plugin code, in place.
	 *
	 * @param dir - absolute package directory whose modules changed.
	 * @param reason - what triggered it, for the log line.
	 * @returns the reload result.
	 */
	const refreshDir = async (dir, reason = "manual") => {
		const row = inventory?.plugins?.find((plugin) => plugin.localDir === dir);
		const target = { name: row?.name ?? dir, dir };
		const results = await reloadMany(ctx, [target]);
		const result = results[0] ?? { name: target.name, status: "failed", error: "no result" };
		lastReload.set(dir, { at: Date.now(), reason, ...result });
		if (result.status === "reloaded") {
			log("plugin-updater: refreshed %s (%s) — %d module(s) evicted, entries: %s", target.name, reason, result.invalidated ?? 0, (result.entries ?? []).join(", ") || "—");
		} else if (result.status === "failed") {
			warn("plugin-updater: refresh of %s failed, previous code still running: %s", target.name, result.error ?? "unknown error");
		} else {
			log("plugin-updater: %s — %s", target.name, result.status);
		}
		return result;
	};

	/** Local plugin directories the profile currently points at. */
	const localDirs = () => {
		const dirs = new Set();
		for (const plugin of inventory?.plugins ?? []) {
			if (plugin.local && typeof plugin.localDir === "string") dirs.add(plugin.localDir);
		}
		for (const dir of currentConfig().extraWatchDirs) dirs.add(dir);
		return [...dirs];
	};

	const startWatching = async () => {
		const live = currentConfig();
		if (watching || !live.watchLocal) return { watching, dirs: localDirs() };
		const dirs = localDirs();
		if (dirs.length === 0) {
			log("plugin-updater: no local plugin directories to watch");
			return { watching: false, dirs: [] };
		}
		watcher = createWatcher({
			roots: dirs,
			ignored: live.ignored,
			debounceMs: live.debounceMs,
			extensions: live.watchExtensions,
			onChange: async (batch) => {
				for (const { dir, files } of batch) {
					// Refreshing this plugin's own directory would dispose the
					// very fiber executing this callback. Report it instead.
					if (isSelf(dir)) {
						log("plugin-updater: %s changed — this plugin's own code; restart dsh to load it", dir);
						continue;
					}
					log("plugin-updater: change in %s (%d file(s), e.g. %s)", dir, files.length, files[0] ?? "");
					await refreshDir(dir, "file change");
				}
			},
		});
		watching = true;
		log("plugin-updater: watching %d local plugin dir(s)", dirs.length);
		return { watching, dirs };
	};

	const stopWatching = () => {
		if (watcher !== null) {
			try {
				watcher.close();
			} catch (error) {
				warn("plugin-updater: watcher close failed: %s", error?.message ?? String(error));
			}
			watcher = null;
		}
		watching = false;
	};

	// ── The agent-facing tool ──────────────────────────────────────────────
	const tool = {
		name: "plugin_update",
		description:
			"Keep this profile's plugins current. `status` lists every installed plugin with its kind (registry / local development / tarball / git), installed version, and whether a newer registry version exists. `check` re-queries the registries now (network read only; changes nothing). `refresh` reloads local-development (link:/path) plugins in this RUNNING process without restarting — it evicts their modules from the Node cache and restarts their fibers, so source edits become live immediately. `update` installs newer registry versions through the plugin manager (this changes the profile; ask the user first). Plugins that do not need a restart (e.g. local-development plugins via `refresh`) take effect directly; plugins that require a restart (e.g. registry-installed packages) will be installed, and `update` will return an explicit notification telling you that a restart is required so you can inform the user. `watch` / `unwatch` start or stop automatic refresh-on-change for local plugin directories.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: {
					type: "string",
					enum: ACTIONS,
					description: "Operation to perform.",
				},
				target: {
					type: "string",
					description:
						"For `refresh`: a plugin package name or an absolute directory. Omit to refresh every local-development plugin. For `update`: a package name, or omit to update every plugin with an available registry update.",
				},
				dryRun: {
					type: "boolean",
					description: "For `update`: report what would be installed without touching the profile. Defaults to true; pass false to actually install.",
				},
				onlyEnabled: {
					type: "boolean",
					description: "When true, only check or update plugins that are currently enabled in the profile. Defaults to the configured setting.",
				},
			},
			required: ["action"],
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }],
		},
		async execute(args) {
			const action = args?.action;
			switch (action) {
				case "status": {
					const snapshot = await readInventory({ check: false, onlyEnabled: args?.onlyEnabled });
					return renderStatus(snapshot, { watching, lastReload, canReload: canReload(ctx) });
				}
				case "check": {
					const snapshot = await readInventory({ check: true, onlyEnabled: args?.onlyEnabled });
					return renderStatus(snapshot, { watching, lastReload, canReload: canReload(ctx), checked: true });
				}
				case "refresh": {
					const dirs = resolveRefreshTargets(args?.target, inventory, localDirs());
					if (dirs.length === 0) return "No local-development plugin matched. Run `status` to see which plugins are refreshable.";
					const lines = [];
					for (const dir of dirs) {
						const result = await refreshDir(dir, "manual refresh");
						lines.push(`${result.status.padEnd(10)} ${result.name}${result.error === undefined ? "" : ` — ${result.error}`}`);
					}
					return lines.join("\n");
				}
				case "update": {
					const live = currentConfig();
					return updateRegistry(ctx, live, inventory ?? (await readInventory({ check: true, onlyEnabled: args?.onlyEnabled })), args);
				}
				case "watch": {
					const started = await startWatching();
					return started.watching
						? `Watching ${started.dirs.length} local plugin director${started.dirs.length === 1 ? "y" : "ies"}:\n${started.dirs.map((d) => `  ${d}`).join("\n")}`
						: "Nothing to watch: no local-development plugins and no extraWatchDirs configured.";
				}
				case "unwatch": {
					stopWatching();
					return "Stopped watching local plugin directories.";
				}
				default:
					return `Unknown action ${JSON.stringify(action)}. Expected one of: ${ACTIONS.join(", ")}.`;
			}
		},
	};

	ctx.effect(() => ctx.tools.register(tool), "plugin-updater.tool");

	// ── Periodic registry check ────────────────────────────────────────────
	//
	// A REPEATING check, not a one-shot. A previous revision armed a single
	// `setTimeout` and never re-armed it, so with the shipped six-hour default
	// the check ran once, six hours after start, and then never again — a
	// plugin whose whole purpose is noticing new versions would go quiet for
	// the rest of the session.
	//
	// The chain re-arms AFTER each check settles instead of on a fixed
	// interval, so a slow registry (20 s timeout per package by default) can
	// never stack overlapping checks on top of each other.
	ctx.effect(() => {
		const initial = currentConfig();
		if (!initial.checkRegistry || initial.checkIntervalMinutes <= 0) return () => {};
		// Set when the effect is disposed, so an in-flight check cannot re-arm a
		// timer after the plugin was unloaded (which would keep the process
		// awake and, worse, run work for a plugin that no longer exists).
		let disposed = false;
		/** Clear any pending timer; idempotent, so disposal is safe to re-run. */
		const disarm = () => {
			if (checkTimer !== null) clearTimeout(checkTimer);
			checkTimer = null;
		};
		const arm = () => {
			if (disposed || checkTimer !== null) return;
			const live = currentConfig();
			// A period is re-read on EVERY arm, so changing the interval in the
			// settings page takes effect at the next re-arm instead of after a
			// restart. 0 turns the repeating part off without unmounting.
			if (!live.checkRegistry || live.checkIntervalMinutes <= 0) return;
			// A plain Node timer rather than the timer service: that service is
			// an optional plugin, and this one must not depend on it.
			checkTimer = setTimeout(tick, live.checkIntervalMinutes * 60 * 1000);
			checkTimer?.unref?.();
		};
		const tick = () => {
			checkTimer = null;
			if (disposed) return;
			const live = currentConfig();
			readInventory({ check: true, onlyEnabled: live.onlyEnabled })
				.then((snapshot) => {
					const stale = (snapshot?.plugins ?? []).filter((plugin) => plugin.updateAvailable === true && (!live.onlyEnabled || plugin.enabled));
					if (stale.length === 0) {
						log("plugin-updater: periodic check — %d plugin(s) checked, no updates", snapshot?.plugins?.length ?? 0);
						return;
					}
					log("plugin-updater: %d plugin update(s) available: %s", stale.length, stale.map((plugin) => `${plugin.name} ${plugin.installedVersion}→${plugin.latestVersion}`).join(", "));
					if (live.autoUpdateRegistry) return updateRegistry(ctx, live, snapshot, { dryRun: false, onlyEnabled: live.onlyEnabled });
				})
				.catch((error) => warn("plugin-updater: periodic check failed: %s", error?.message ?? String(error)))
				// Re-arm whatever happened: a single transient network failure must
				// not silence every future check for the rest of the session.
				.finally(arm);
		};
		// The first check runs NOW rather than one period from now: that is when
		// the information is most useful, and it makes `status` answerable for a
		// user who never asks explicitly.
		tick();
		return () => {
			disposed = true;
			disarm();
		};
	}, "plugin-updater.check-timer");

	// ── Automatic refresh-on-change for local plugins ───────────────────────
	ctx.effect(() => {
		if (!currentConfig().watchLocal) return () => {};
		let disposed = false;
		readInventory({ check: false })
			.then(() => {
				if (!disposed) return startWatching();
			})
			.catch((error) => warn("plugin-updater: could not start the local watcher: %s", error?.message ?? String(error)));
		return () => {
			disposed = true;
			stopWatching();
		};
	}, "plugin-updater.watcher");

	// ── The settings card's data route ─────────────────────────────────────
	//
	// The Plugins page card needs facts `configForms` cannot carry: each
	// plugin's installed and latest version, which ones are local working
	// copies, and what the last refresh did. Those live only on the Host, so
	// the Host serves them from a prefixed HTTP route — the same pattern
	// dsh-tool-gate and dsh-context use to feed their cards.
	//
	// The route reads the live registry each time it is asked (with a short
	// cache so a page refresh does not hammer npm), which is what makes a newly
	// installed plugin appear without any client-side state.
	ctx.inject(["connection"], (scoped) => {
		const connection = scoped.get("connection");
		// `fetch.register` is a closure on the fetch object, so it can be called
		// through it directly; nothing here depends on `this`.
		const register = connection?.fetch?.register;
		if (typeof register !== "function") {
			warn("plugin-updater: no connection.fetch.register; the settings card will show config only");
			return;
		}
		const handleRequest = async (request) => {
			let body = {};
			try {
				if (request && typeof request.json === "function") {
					body = await request.json();
				}
			} catch (_) {}

			const live = currentConfig();
			let updateReport = null;

			if (body?.action === "restart") {
				const timer = setTimeout(() => {
					try {
						restartApplication();
					} catch (_) {}
				}, 150);
				timer?.unref?.();
				return Response.json({ ok: true, restarting: true }, {
					headers: { "cache-control": "no-store" },
				});
			} else if (body?.action === "update") {
				const currentSnapshot = inventory ?? (await readInventory({ check: true, onlyEnabled: live.onlyEnabled }));
				const rawTarget = body.target === undefined || body.target === null ? "" : String(body.target).trim();
				const target = !rawTarget || rawTarget === "null" || rawTarget === "undefined" || rawTarget === "all" || rawTarget === "*" ? null : rawTarget;
				updateReport = await updateRegistry(ctx, live, currentSnapshot, {
					dryRun: false,
					target,
					trigger: "ui",
					onlyEnabled: live.onlyEnabled,
				});
				await readInventory({ check: true, onlyEnabled: live.onlyEnabled });
			} else if (body?.action === "check" || body?.check === true) {
				await readInventory({ check: true, onlyEnabled: live.onlyEnabled });
			}

			const snapshot = inventory ?? (await readInventory({ check: live.checkRegistry, onlyEnabled: live.onlyEnabled }));
			const payload = {
				ok: true,
				report: updateReport,
				profileDir: snapshot?.profileDir ?? null,
				watcher: watching,
				hotReload: canReload(ctx),
				checkedAt: inventoryAt,
				intervalMinutes: live.checkIntervalMinutes,
				watchLocal: live.watchLocal,
				autoUpdateRegistry: live.autoUpdateRegistry,
				checkRegistry: live.checkRegistry,
				onlyEnabled: live.onlyEnabled,
				plugins: (snapshot?.plugins ?? []).map((plugin) => {
					const isEnabled = plugin.enabled !== false;
					const skipDisabled = live.onlyEnabled && !isEnabled;
					return {
						name: plugin.name,
						kind: plugin.kind,
						local: plugin.local === true,
						localDir: plugin.localDir ?? null,
						installedVersion: plugin.installedVersion ?? null,
						latestVersion: skipDisabled ? null : (plugin.latestVersion ?? null),
						updateAvailable: skipDisabled ? false : (plugin.updateAvailable === true),
						enabled: isEnabled,
						refresh: plugin.localDir === null || plugin.localDir === undefined
							? null
							: (lastReload.get(plugin.localDir) ?? null),
					};
				}),
				warnings: snapshot?.warnings ?? [],
				history: readUpdateHistory(snapshot?.profileDir ?? null),
				restartRequired: pendingRestart.size > 0,
				pendingRestart: [...pendingRestart],
			};
			return Response.json(payload, {
				headers: { "cache-control": "no-store" },
			});
		};

		scoped.effect(
			() => {
				const unregisterStatus = register({
					path: SETTINGS_ROUTE,
					methods: ["POST"],
					requestBody: "buffered",
					fetch: handleRequest,
				});
				const unregisterUpdate = register({
					path: UPDATE_ROUTE,
					methods: ["POST"],
					requestBody: "buffered",
					fetch: handleRequest,
				});
				return () => {
					if (typeof unregisterStatus === "function") unregisterStatus();
					if (typeof unregisterUpdate === "function") unregisterUpdate();
				};
			},
			"plugin-updater.settings-route",
		);
	});
}

/**
 * Path of the Host route the settings card reads. Prefixed like every other
 * plugin route so it cannot collide with a harness endpoint.
 */
const SETTINGS_ROUTE = "/api/dsh-plugin-updater/status";
const UPDATE_ROUTE = "/api/dsh-plugin-updater/update";

/** Plugins updated in this session that require a DSH restart to load. */
export const pendingRestart = new Set();

/**
 * Build a clean environment for relaunching the Electron GUI application.
 *
 * The DSH Desktop Host child process is spawned by Electron main with
 * `ELECTRON_RUN_AS_NODE=1` and `DSH_DESKTOP_*` variables injected via
 * `desktopNodeEnvironment()`. If a relaunch helper inherits `ELECTRON_RUN_AS_NODE=1`,
 * the newly spawned `DeepSeek Harness` binary executes as a bare Node.js CLI
 * process instead of the Electron GUI app and immediately exits.
 */
export function createCleanRelaunchEnv(baseEnv = process.env) {
	const clean = { ...baseEnv };
	for (const key of Object.keys(clean)) {
		if (
			key.startsWith("ELECTRON_") ||
			key.startsWith("DSH_DESKTOP_") ||
			key === "NODE_OPTIONS"
		) {
			delete clean[key];
		}
	}
	return clean;
}

/**
 * Gracefully restart the DeepSeek Harness application across macOS, Windows, and Linux.
 *
 * Modeled after DSH's official desktop update & relaunch lifecycle (`main.js`
 * `finishQuit()` + `Squirrel.Mac` `ShipIt ___launch___` + `SingletonLock` release).
 */
export function restartApplication(options = {}) {
	const cleanEnv = createCleanRelaunchEnv(options.env ?? process.env);
	const dryRun = options.dryRun === true;

	if (process.platform === "darwin") {
		const execPath = options.execPath || process.execPath;
		const isMacApp = execPath.includes(".app/Contents/MacOS");
		const appPath = isMacApp
			? execPath.slice(0, execPath.indexOf(".app") + 4)
			: "/Applications/DeepSeek Harness.app";
		const appExecPath = isMacApp
			? execPath
			: join(appPath, "Contents/MacOS/DeepSeek Harness");
		const shipItBin = join(
			appPath,
			"Contents/Frameworks/Squirrel.framework/Resources/ShipIt",
		);
		const appFileUrl = pathToFileURL(appPath).href.replace(/\/?$/, "/");
		const userDataDir = join(
			homedir(),
			"Library/Application Support/@deepseek-ai/dsh-desktop",
		);
		const singletonLock = join(userDataDir, "SingletonLock");
		const singletonSocket = join(userDataDir, "SingletonSocket");
		const singletonCookie = join(userDataDir, "SingletonCookie");
		const mainPid = options.mainPid ?? process.ppid;
		const hostPid = options.hostPid ?? process.pid;
		const scriptPath = options.scriptPath || join(tmpdir(), "dsh-relaunch.sh");
		const logPath = join(tmpdir(), "dsh-relaunch.log");
		const content = `#!/bin/sh
trap '' HUP INT TERM

# 0. 彻底清理 Host 子进程继承的 ELECTRON_RUN_AS_NODE 等环境变量
# 否则 Electron 主程序会被当成普通 Node CLI 执行并瞬间退出
unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE ELECTRON_NO_ASAR
unset DSH_DESKTOP_NODE_EXECUTABLE DSH_DESKTOP_BUNDLED_RUNTIME_DIR NODE_OPTIONS

APP_PATH="${appPath}"
APP_EXEC="${appExecPath}"
SHIPIT_BIN="${shipItBin}"
APP_FILE_URL="${appFileUrl}"
MAIN_PID="${mainPid || ""}"
HOST_PID="${hostPid || ""}"
SINGLETON_LOCK="${singletonLock}"
SINGLETON_SOCKET="${singletonSocket}"
SINGLETON_COOKIE="${singletonCookie}"
LOG_FILE="${logPath}"

log_msg() {
  printf "[%s] %s\\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE" 2>/dev/null || true
}

is_pid_alive() {
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

is_app_running() {
  if [ -L "$SINGLETON_LOCK" ] || [ -e "$SINGLETON_LOCK" ]; then
    return 0
  fi
  if pgrep -x "DeepSeek Harness" >/dev/null 2>&1; then
    return 0
  fi
  if pgrep -f "$APP_EXEC" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

: > "$LOG_FILE" 2>/dev/null || true
log_msg "Starting DSH relaunch (MAIN_PID=$MAIN_PID, HOST_PID=$HOST_PID, APP_PATH=$APP_PATH)"

# 预留缓冲让 HTTP 响应先返回给前端
sleep 0.2

# 1. 异步发送 AppleScript quit（后台执行避免 Electron before-quit 异步停机期间阻塞 osascript）
( /usr/bin/osascript -e 'tell application id "com.deepseek.dsh" to quit' >/dev/null 2>&1 ) &

# 若 1 秒后主进程仍在运行，补发 SIGTERM 触发 Electron 正常退出流程
sleep 0.8
if is_pid_alive "$MAIN_PID"; then
  kill -TERM "$MAIN_PID" 2>/dev/null || true
fi

# 2. 等待 Electron 主进程 (MAIN_PID) 与当前 Host 进程 (HOST_PID) 退出（參考 Squirrel SQRLTerminationListener）
COUNT=0
while is_pid_alive "$MAIN_PID" || is_pid_alive "$HOST_PID"; do
  sleep 0.3
  COUNT=$((COUNT + 1))
  if [ "$COUNT" -eq 15 ]; then
    log_msg "Sending SIGTERM to remaining PIDs (MAIN_PID=$MAIN_PID, HOST_PID=$HOST_PID)"
    is_pid_alive "$MAIN_PID" && kill -TERM "$MAIN_PID" 2>/dev/null || true
    is_pid_alive "$HOST_PID" && kill -TERM "$HOST_PID" 2>/dev/null || true
  fi
  if [ "$COUNT" -ge 50 ]; then
    log_msg "Timeout waiting for graceful exit; sending SIGKILL"
    is_pid_alive "$MAIN_PID" && kill -9 "$MAIN_PID" 2>/dev/null || true
    is_pid_alive "$HOST_PID" && kill -9 "$HOST_PID" 2>/dev/null || true
    break
  fi
done

# 3. 确保应用包下所有残留子进程退出
WAIT_ALL=0
while pgrep -f "$APP_EXEC" >/dev/null 2>&1; do
  sleep 0.3
  WAIT_ALL=$((WAIT_ALL + 1))
  if [ "$WAIT_ALL" -ge 20 ]; then
    pkill -9 -f "$APP_EXEC" 2>/dev/null || true
    break
  fi
done

# 4. 清理可能因强制退出而残留的 Electron 单实例锁 (SingletonLock)
# 若旧锁残留，新启动的 DSH 会在 claimDesktopSingleInstance() 校验失败并立即退出
if ! pgrep -x "DeepSeek Harness" >/dev/null 2>&1 && ! pgrep -f "$APP_EXEC" >/dev/null 2>&1; then
  if [ -L "$SINGLETON_LOCK" ] || [ -e "$SINGLETON_LOCK" ]; then
    log_msg "Removing stale SingletonLock before relaunch"
    rm -f "$SINGLETON_LOCK" "$SINGLETON_SOCKET" "$SINGLETON_COOKIE" 2>/dev/null || true
  fi
fi

# 稳妥缓冲，等待 macOS LaunchServices 与 NSRunningApplication 完成注销
sleep 0.6

# 5. 重新拉起应用（参考 DSH 官方 Squirrel.Mac ShipIt ___launch___ 与 LaunchServices 机制）
log_msg "Launching via /usr/bin/open -a $APP_PATH"
/usr/bin/open -a "$APP_PATH" >/dev/null 2>&1 || /usr/bin/open -b com.deepseek.dsh >/dev/null 2>&1 || /usr/bin/open "$APP_PATH" >/dev/null 2>&1 || true

sleep 1.5
if ! is_app_running && [ -x "$SHIPIT_BIN" ]; then
  log_msg "Fallback 1: Launching via official Squirrel ShipIt ___launch___ $APP_FILE_URL"
  "$SHIPIT_BIN" ___launch___ "$APP_FILE_URL" >/dev/null 2>&1 &
  sleep 1.5
fi

if ! is_app_running; then
  log_msg "Fallback 2: Launching via AppleScript activate / direct binary in clean env"
  /usr/bin/osascript -e 'tell application id "com.deepseek.dsh" to activate' >/dev/null 2>&1 || "$APP_EXEC" >/dev/null 2>&1 &
fi

log_msg "Relaunch sequence finished"
`;
		try {
			writeFileSync(scriptPath, content, { mode: 0o755 });
			if (!dryRun) {
				const child = spawn("/bin/sh", [scriptPath], {
					detached: true,
					stdio: "ignore",
					env: cleanEnv,
				});
				child.unref();
			}
		} catch (_) {}
		return { scriptPath, content, env: cleanEnv };
	} else if (process.platform === "win32") {
		const exe = options.execPath || process.execPath;
		const batPath = options.scriptPath || join(tmpdir(), "dsh-relaunch.bat");
		const content = `@echo off\r\n` +
			`set "ELECTRON_RUN_AS_NODE="\r\n` +
			`set "ELECTRON_NO_ATTACH_CONSOLE="\r\n` +
			`set "DSH_DESKTOP_NODE_EXECUTABLE="\r\n` +
			`set "NODE_OPTIONS="\r\n` +
			`timeout /t 1 /nobreak >nul\r\n` +
			`taskkill /IM "DeepSeek Harness.exe" 2>nul\r\n` +
			`:wait_loop\r\n` +
			`tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>NUL | find /I /N "DeepSeek Harness.exe">NUL\r\n` +
			`if "%ERRORLEVEL%"=="0" (\r\n` +
			`  timeout /t 1 /nobreak >nul\r\n` +
			`  goto wait_loop\r\n` +
			`)\r\n` +
			`timeout /t 1 /nobreak >nul\r\n` +
			`start "" "${exe}"\r\n`;
		try {
			writeFileSync(batPath, content);
			if (!dryRun) {
				const child = spawn("cmd.exe", ["/c", "start", '""', batPath], {
					detached: true,
					stdio: "ignore",
					windowsHide: true,
					env: cleanEnv,
				});
				child.unref();
			}
		} catch (_) {}
		return { scriptPath: batPath, content, env: cleanEnv };
	} else {
		const exe = options.execPath || process.execPath;
		const scriptPath = options.scriptPath || join(tmpdir(), "dsh-relaunch.sh");
		const content = `#!/bin/sh\n` +
			`trap '' HUP INT TERM\n` +
			`unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE ELECTRON_NO_ASAR DSH_DESKTOP_NODE_EXECUTABLE NODE_OPTIONS\n` +
			`killall -TERM "DeepSeek Harness" 2>/dev/null || true\n` +
			`while pgrep -f "${exe}" >/dev/null 2>&1; do sleep 0.4; done\n` +
			`sleep 1.0\n` +
			`"${exe}" >/dev/null 2>&1 &\n`;
		try {
			writeFileSync(scriptPath, content, { mode: 0o755 });
			if (!dryRun) {
				const child = spawn("/bin/sh", [scriptPath], {
					detached: true,
					stdio: "ignore",
					env: cleanEnv,
				});
				child.unref();
			}
		} catch (_) {}
		return { scriptPath, content, env: cleanEnv };
	}
}


/**
 * Turn a `refresh` target into the list of directories to reload.
 *
 * Accepts a package name, an absolute directory, or nothing (every local
 * plugin). Unknown names are reported by returning an empty list rather than
 * guessing, so a typo never reloads something unintended.
 *
 * @param target - the tool argument.
 * @param inventory - the last inventory snapshot.
 * @param allDirs - every local directory currently known.
 * @returns absolute directories to refresh.
 */
export function resolveRefreshTargets(target, inventory, allDirs) {
	if (target === undefined || target === null) return [...allDirs];
	const raw = String(target).trim();
	if (raw === "" || raw === "null" || raw === "undefined" || raw === "all" || raw === "*") return [...allDirs];
	if (raw.startsWith("/")) return allDirs.includes(raw) ? [raw] : [raw];
	const row = (inventory?.plugins ?? []).find((plugin) => plugin.name === raw);
	if (row?.localDir !== undefined && row.localDir !== null) return [row.localDir];
	return [];
}

/**
 * Install newer registry versions through the profile's plugin manager.
 *
 * This is the only path in this plugin that changes the profile, and it goes
 * through `ctx.pluginManager.installBundle`, which is the same code the
 * plugin manager page and the `plugin_manager` tool use — lockfile handling,
 * compatibility checks and rollback are its problem, not ours.
 *
 * @param ctx - Cordis context.
 * @param config - resolved plugin config.
 * @param snapshot - inventory to act on.
 * @param args - tool arguments (`target`, `dryRun`).
 * @returns a human-readable report.
 */
/**
 * Execute pnpm add in the profile directory as a reliable fallback
 * when pluginManager.installBundle refuses to reinstall an already-installed package.
 */
/** Ensure a bundle's name is present in dsh.profile.bundles so it stays enabled across restarts. */
function ensureBundleEnabled(profileDir, bundleName) {
	if (!profileDir) return;
	try {
		const manifestPath = join(profileDir, "package.json");
		if (!existsSync(manifestPath)) return;
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.dsh = manifest.dsh || {};
		manifest.dsh.profile = manifest.dsh.profile || {};
		const bundles = manifest.dsh.profile.bundles || [];
		if (!bundles.includes(bundleName)) {
			bundles.push(bundleName);
			manifest.dsh.profile.bundles = bundles;
			writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
		}
	} catch (_) {}
}
async function runProfilePnpmAdd(manager, profileDir, spec) {
	if (typeof manager?.runPnpm === "function") {
		try {
			const res = await manager.runPnpm(["add", spec]);
			if (res && (res.exitCode === 0 || res.exitCode === undefined) && !res.timedOut) {
				return { application: "restart-required" };
			}
		} catch (_) {}
	}
	if (!profileDir) {
		throw new Error("No profile directory available to run pnpm add.");
	}
	const pnpmPaths = [
		"/Users/reno/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs",
		"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs",
	];
	const nodePaths = [
		"/Users/reno/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node",
		process.execPath,
	];
	const pnpmBin = pnpmPaths.find((p) => {
		try { return existsSync(p); } catch { return false; }
	});
	const nodeBin = nodePaths.find((p) => {
		try { return existsSync(p); } catch { return false; }
	}) || "node";

	if (pnpmBin) {
		const res = await execFileAsync(nodeBin, [pnpmBin, "add", spec], {
			cwd: profileDir,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});
		return { application: "restart-required", output: res.stdout };
	}
	throw new Error("Neither pluginManager.runPnpm nor bundled pnpm was found to perform the upgrade.");
}
export async function updateRegistry(ctx, config, snapshot, args) {
	const manager = ctx.get?.("pluginManager");
	const dryRun = args?.dryRun !== false;
	const rawWanted = args?.target === undefined || args?.target === null ? "" : String(args.target).trim();
	const wanted = !rawWanted || rawWanted === "null" || rawWanted === "undefined" || rawWanted === "all" || rawWanted === "*" ? null : rawWanted;
	const onlyEnabled = typeof args?.onlyEnabled === "boolean" ? args.onlyEnabled : config?.onlyEnabled !== false;
	const candidates = (snapshot?.plugins ?? []).filter(
		(plugin) =>
			plugin.kind === "registry" &&
			plugin.updateAvailable === true &&
			(!onlyEnabled || plugin.enabled !== false) &&
			(wanted === null || plugin.name === wanted),
	);
	if (candidates.length === 0) {
		if (wanted !== null) {
			const targetRow = (snapshot?.plugins ?? []).find((p) => p.name === wanted);
			if (targetRow && onlyEnabled && targetRow.enabled === false) {
				return `Plugin ${wanted} is disabled, and 'onlyEnabled' is active. Enable it first or turn off the 'onlyEnabled' switch to update it.`;
			}
			return `No update available for ${wanted}. Run \`status\` to see its installed and latest versions.`;
		}
		return "No registry plugin has an update available. Run `check` to re-query the registry.";
	}
	const plan = candidates.map((plugin) => `${plugin.name} ${plugin.installedVersion ?? "?"} → ${plugin.latestVersion ?? "?"}`);
	if (dryRun) return `Would install (dry run — pass dryRun: false to apply):\n${plan.map((line) => `  ${line}`).join("\n")}`;
	if (manager === undefined) return "The plugin manager is not available in this profile, so plugin updates cannot be installed automatically. Use the Plugin Manager page instead.";
	const results = [];
	for (const plugin of candidates) {
		const spec = `${plugin.name}@${plugin.latestVersion}`;
		const enabled = plugin.enabled !== false;
		try {
			let outcome;
			let installError = null;
			try {
				outcome = await manager.installBundle(spec, { enabled });
			} catch (err) {
				installError = err;
			}

			const failed = installError !== null || outcome?.application === "failed";
			if (failed) {
				const errMsg = installError?.message || outcome?.error?.diagnostic || outcome?.error?.message || "";
				try {
					outcome = await runProfilePnpmAdd(manager, snapshot?.profileDir ?? null, spec);
					if (enabled) {
						ensureBundleEnabled(snapshot?.profileDir ?? null, plugin.name);
					}
				} catch (pnpmErr) {
					throw installError || new Error(pnpmErr?.message || errMsg || "Installation failed");
				}
			}

			const appStatus = outcome?.application ?? "unknown";
			if (appStatus === "failed") {
				const failureReason = outcome?.error?.diagnostic || outcome?.error?.code || "failed";
				throw new Error(failureReason);
			}

			results.push(`installed   ${spec} — ${appStatus}`);
			if (plugin.kind === "registry" && enabled) {
				pendingRestart.add(plugin.name);
			}
			recordUpdateHistory(snapshot?.profileDir ?? null, {
				target: plugin.name,
				fromVersion: plugin.installedVersion,
				toVersion: plugin.latestVersion,
				status: "success",
				trigger: args?.trigger ?? "manual",
			});
		} catch (error) {
			const errStr = error?.message ?? String(error);
			results.push(`failed      ${spec} — ${errStr}`);
			recordUpdateHistory(snapshot?.profileDir ?? null, {
				target: plugin.name,
				fromVersion: plugin.installedVersion,
				toVersion: plugin.latestVersion,
				status: "failed",
				error: errStr,
				trigger: args?.trigger ?? "manual",
			});
		}
	}
	const restartItems = [...pendingRestart];
	if (restartItems.length > 0) {
		results.push(`\n【需要重启】以下插件已成功安装写入 profile，但由于模块已被 Host 加载运行，需要重启 DeepSeek Harness 才能生效：\n  ${restartItems.join(", ")}\n请向用户汇报更新结果，并告知用户可在方便时重启 DSH 客户端完成激活。\n（说明：本地开发插件 link:/path 无需重启，可直接通过 refresh 即时生效；npm registry 安装包需要重启应用生效）`);
	} else {
		results.push("\n所有更新均已直接生效，无需重启。");
	}
	return results.join("\n");
}

/**
 * Render an inventory as text a model can act on.
 *
 * @param snapshot - the inventory.
 * @param state - extra runtime state to report.
 * @returns a plain-text report.
 */
export function renderStatus(snapshot, state) {
	const plugins = snapshot?.plugins ?? [];
	const lines = [];
	lines.push(`Profile: ${snapshot?.profileDir ?? "unknown"}`);
	lines.push(`Hot refresh: ${state.canReload?.ok ? "available" : `unavailable — ${state.canReload?.reason ?? "unknown reason"}`}`);
	lines.push(`Watcher: ${state.watching ? "on" : "off"}`);
	if (plugins.length === 0) lines.push("No bundle plugins installed in this profile.");
	if (snapshot?.error) lines.push(`error: ${snapshot.error}`);
	for (const plugin of plugins) {
		const where = plugin.local ? `local ${plugin.localDir ?? ""}`.trim() : plugin.kind;
		const version = plugin.installedVersion ?? "?";
		const disabledTag = plugin.enabled === false ? " (disabled)" : "";
		let line = `  ${plugin.name}  [${where}]  ${version}${disabledTag}`;
		if (plugin.latestVersion !== null && plugin.latestVersion !== undefined) {
			line += plugin.updateAvailable ? `  → ${plugin.latestVersion} available` : "  (up to date)";
		}
		if (plugin.error !== undefined) line += `  ! ${plugin.error}`;
		const reload = plugin.localDir === null || plugin.localDir === undefined ? undefined : state.lastReload.get(plugin.localDir);
		if (reload !== undefined) line += `  last refresh: ${reload.status} (${reload.reason})`;
		lines.push(line);
	}
	for (const warning of snapshot?.warnings ?? []) lines.push(`warning: ${warning}`);
	return lines.join("\n");
}
