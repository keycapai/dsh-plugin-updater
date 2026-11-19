/**
 * A dependency-free directory watcher for plugin sources.
 *
 * `node:fs.watch(..., { recursive: true })` does the work where the platform
 * supports it (macOS and Windows). Where it does not (Linux, inotify), the same
 * interface is served by a bounded `readdirSync` poll that compares mtimes —
 * slower, but it needs no `chokidar` and no native module.
 *
 * Both backends feed one debounce: a burst of saves becomes a single
 * `onChange` call per directory, which is the granularity the reload engine
 * wants.
 *
 * @module dsh-plugin-updater/watch
 */

import { watch as fsWatch } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Names never looked at, on top of the caller's `ignored`. */
const DEFAULT_IGNORED = ["node_modules", "dist", "build", "out", ".git", ".hg", ".svn", ".turbo", ".cache", "coverage"];

/** Files that never carry plugin code. */
const DEFAULT_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".json", ".css", ".wasm"];

/** How many entries a single poll may visit before it gives up for this round. */
const POLL_BUDGET = 20000;

/** Ignore events arriving this soon after a watcher stream opens (see `accept`). */
const STARTUP_GRACE_MS = 200;

/**
 * @typedef {object} WatchBatch
 * @property {string} dir the root directory the changes belong to
 * @property {string[]} files absolute paths of the changed files
 */

/**
 * @typedef {object} WatcherOptions
 * @property {string[]} roots absolute directories to watch
 * @property {string[]} [ignored] extra directory names to skip
 * @property {number} [debounceMs] quiet period before `onChange` fires
 * @property {string[]} [extensions] file extensions that count as changes
 * @property {(batch: WatchBatch[]|WatchBatch) => any} onChange
 */

/**
 * Create a watcher over several plugin directories.
 *
 * The returned object is safe to call from anywhere: construction never
 * throws for a missing root (it is reported in `stats().missing`), and
 * `close()` is idempotent.
 *
 * @param {WatcherOptions} options
 * @returns {{close(): Promise<void>, stats(): {roots: string[], missing: string[], ignored: string[], watching: boolean, mode: "native"|"poll", debounceMs: number, pending: number, changes: number, batches: number, lastError: string|null}}}
 */
export function createWatcher(options = {}) {
	const roots = uniqueRoots(options.roots);
	const debounceMs = normalizeDebounce(options.debounceMs);
	const ignored = new Set([...DEFAULT_IGNORED, ...(Array.isArray(options.ignored) ? options.ignored : [])]
		.map((name) => String(name).trim())
		.filter(Boolean));
	const extensions = new Set(
		(Array.isArray(options.extensions) && options.extensions.length > 0 ? options.extensions : DEFAULT_EXTENSIONS)
			.map((ext) => (ext.startsWith(".") ? ext.toLowerCase() : "." + ext.toLowerCase())),
	);
	const onChange = typeof options.onChange === "function" ? options.onChange : null;

	/** @type {Map<string, {dir: string, files: Set<string>}>} */
	const pending = new Map();
	/** @type {{root: string, watcher: any}[]} */
	const handles = [];
	/** @type {Map<string, Map<string, number>>} last snapshot per root, poll mode */
	const snapshots = new Map();
	/** @type {Set<NodeJS.Timeout>} */
	const timers = new Set();
	/** When the current stream was opened; earlier events are cold-start noise. */
	let openedAt = Date.now();

	const state = {
		closed: false,
		mode: /** @type {"native"|"poll"} */ ("poll"),
		missing: /** @type {string[]} */ ([]),
		changes: 0,
		batches: 0,
		lastError: /** @type {string|null} */ (null),
		flushing: false,
	};

	let pollTimer = null;

	// ── change intake ──────────────────────────────────────────────────────

	/** True when the file's extension is one this watcher reports. */
	const wants = (file) => {
		const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
		const dot = file.lastIndexOf(".");
		if (dot <= slash) return false; // no extension (or a dot in a directory name)
		return extensions.has(file.slice(dot).toLowerCase());
	};

	/**
	 * True when any path segment names an ignored directory.
	 *
	 * Accepts either a segment array (what {@link relativeParts} returns) or a
	 * path string, so the two helpers cannot drift apart again.
	 */
	const isIgnoredPath = (segments) => {
		const parts = Array.isArray(segments) ? segments : String(segments).split(/[\\/]+/);
		return parts.some((part) => ignored.has(part));
	};

	const accept = (root, dir, file) => {
		if (state.closed) return;
		if (typeof file !== "string" || file.length === 0) return;
		const absolute = resolve(file);
		if (isIgnoredPath(relativeParts(root, absolute))) return;
		if (!wants(absolute)) return;
		// Only real files. Directory events must never start a reload.
		try {
			if (!statSync(absolute).isFile()) return;
		} catch {
			// Deleted between the event and now: a legitimate change to report.
		}
		state.changes += 1;
		const key = dir;
		let group = pending.get(key);
		if (!group) {
			group = { dir: key, files: new Set() };
			pending.set(key, group);
		}
		group.files.add(absolute);
		schedule();
	};

	const schedule = () => {
		if (state.closed) return;
		const timer = setTimeout(() => {
			// `flush` already contains onChange's errors; this is the last line
			// of defence for anything else (e.g. a getter throwing).
			flush().catch((error) => {
				state.lastError = error instanceof Error ? error.message : String(error);
			});
		}, debounceMs);
		timers.add(timer);
	};

	// ── debounce flush ─────────────────────────────────────────────────────

	const flush = async () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		if (state.closed || pending.size === 0 || state.flushing) return;
		state.flushing = true;
		const batch = [...pending.values()].map(({ dir, files }) => ({ dir, files: [...files] }));
		pending.clear();
		state.batches += 1;
		try {
			await onChange?.(batch);
		} catch (error) {
			state.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			state.flushing = false;
			if (pending.size > 0 && !state.closed) schedule();
		}
	};

	// ── native backend ─────────────────────────────────────────────────────

	/** Try `fs.watch({recursive})` on one root; `null` when unsupported. */
	const openNative = (root) => {
		try {
			openedAt = Date.now();
			// A cold stream replays ONE reference frame: spurious `rename`
			// events for files that already existed when it opened, which no
			// stat can distinguish from a save. Swallow that first frame only,
			// and only while it is still inside the startup window — a real edit
			// arriving later is always handled.
			let cold = true;
			let coldTimer = null;
			let disarmQueued = false;
			const disarm = () => {
				cold = false;
				if (coldTimer) clearTimeout(coldTimer);
				coldTimer = null;
			};
			coldTimer = setTimeout(disarm, STARTUP_GRACE_MS);
			coldTimer.unref?.();

			const watcher = fsWatch(root, { recursive: true, persistent: true }, (event, filename) => {
				// An event handler that throws would become an uncaught exception
				// and take the whole Host down, so nothing may escape here.
				try {
					if (!filename) return;
					if (cold) {
						// The stream's initial snapshot coalesces into one callback;
						// the next turn of the loop starts reporting real edits.
						if (!disarmQueued) {
							disarmQueued = true;
							setTimeout(disarm, 0);
						}
						return;
					}
					const name = String(filename);
					const file = name.startsWith(sep) || /^[a-zA-Z]:[\\/]/.test(name) ? name : join(root, name);
					accept(root, root, file);
				} catch (error) {
					state.lastError = error instanceof Error ? error.message : String(error);
				}
			});
			watcher.once?.("close", disarm);
			watcher.on("error", (error) => {
				state.lastError = error instanceof Error ? error.message : String(error);
			});
			return watcher;
		} catch {
			return null;
		}
	};

	// ── poll backend ───────────────────────────────────────────────────────

	const snapshotOf = (root) => {
		/** @type {Map<string, number>} */
		const snapshot = new Map();
		const stack = [root];
		let budget = POLL_BUDGET;
		while (stack.length > 0 && budget > 0) {
			const current = stack.pop();
			let entries;
			try {
				entries = readdirSync(current, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				budget -= 1;
				if (budget <= 0) break;
				if (ignored.has(entry.name)) continue;
				const path = join(current, entry.name);
				if (entry.isDirectory()) {
					stack.push(path);
				} else if (entry.isFile() && wants(path)) {
					try {
						const stat = statSync(path);
						snapshot.set(path, stat.mtimeMs);
					} catch {}
				}
			}
		}
		return snapshot;
	};

	const pollOnce = () => {
		try {
			pollRoots();
		} catch (error) {
			// Same rule as the native callback: a poll must never throw.
			state.lastError = error instanceof Error ? error.message : String(error);
		}
	};

	const pollRoots = () => {
		for (const root of roots) {
			const previous = snapshots.get(root) ?? new Map();
			const next = snapshotOf(root);
			snapshots.set(root, next);
			for (const [file, mtime] of next) {
				if (previous.get(file) !== mtime) accept(root, root, file);
			}
		}
	};

	// ── setup ──────────────────────────────────────────────────────────────

	for (const root of roots) {
		let isDir = false;
		try {
			isDir = statSync(root).isDirectory();
		} catch {
			isDir = false;
		}
		if (!isDir) {
			state.missing.push(root);
			continue;
		}
		if (state.mode === "native") {
			const watcher = openNative(root);
			if (watcher) {
				handles.push({ root, watcher });
				continue;
			}
			// One root failed: fall back for every root, and drop what we opened.
			closeHandles();
			state.mode = "poll";
			break;
		}
		const probe = openNative(root);
		if (probe) {
			state.mode = "native";
			handles.push({ root, watcher: probe });
		} else {
			state.mode = "poll";
			break;
		}
	}

	// Roots that arrived after a first missing one still get watched.
	if (state.mode === "native") {
		for (const root of roots) {
			if (state.missing.includes(root) || handles.some((handle) => handle.root === root)) continue;
			const watcher = openNative(root);
			if (watcher) handles.push({ root, watcher });
		}
	} else if (handles.length === 0 && roots.some((root) => !state.missing.includes(root))) {
		// Poll mode: take a baseline now so only real edits are reported.
		for (const root of roots) if (!state.missing.includes(root)) snapshots.set(root, snapshotOf(root));
		pollTimer = setInterval(pollOnce, Math.max(debounceMs * 4, 200));
		pollTimer.unref?.();
	}

	function closeHandles() {
		for (const { watcher } of handles.splice(0)) {
			try {
				watcher.close();
			} catch {}
		}
	}

	// ── teardown ───────────────────────────────────────────────────────────

	let closing = null;

	const close = () => {
		if (closing) return closing;
		state.closed = true;
		closing = (async () => {
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			closeHandles();
			pending.clear();
			snapshots.clear();
			// Let an in-flight onChange finish so callers see a quiescent end.
			while (state.flushing) await new Promise((resolve) => setTimeout(resolve, 5));
		})();
		return closing;
	};

	const stats = () => ({
		roots: [...roots],
		missing: [...state.missing],
		ignored: [...ignored],
		watching: !state.closed && handles.length > 0,
		mode: state.mode,
		debounceMs,
		pending: pending.size,
		changes: state.changes,
		batches: state.batches,
		lastError: state.lastError,
	});

	return { close, stats };
}

// ── helpers ────────────────────────────────────────────────────────────────

function uniqueRoots(roots) {
	const list = Array.isArray(roots) ? roots : roots ? [roots] : [];
	const seen = new Set();
	const result = [];
	for (const root of list) {
		if (typeof root !== "string" || root.length === 0) continue;
		const absolute = resolve(root);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		result.push(absolute);
	}
	return result;
}

function normalizeDebounce(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return 120;
	return Math.min(Math.max(Math.trunc(number), 10), 60_000);
}

/** Path segments of `file` relative to `root`, or of `file` itself outside it. */
function relativeParts(root, file) {
	const prefix = root.endsWith(sep) ? root : root + sep;
	if (file === root) return [];
	if (file.startsWith(prefix)) return file.slice(prefix.length).split(sep);
	return file.split(sep);
}
