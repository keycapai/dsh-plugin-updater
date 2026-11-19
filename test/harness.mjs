/**
 * Shared bootstrap for the dsh-plugin-updater tests.
 *
 * Two jobs:
 *
 *  1. FIND the real `@deepseek-ai/*` packages. At runtime the Host imports them
 *     from inside `app.asar`, which ordinary Node cannot read through, so they
 *     are extracted once and imported from the extracted copy. The location is
 *     DISCOVERED, never hardcoded: an earlier generation of DSH tests pinned
 *     `/tmp/asar-x` and every probe died with a confusing module-not-found the
 *     moment that directory was cleaned.
 *
 *  2. BOOT a real Cordis runtime for the reload proof: a `Context`, the real
 *     `Loader` service, and loader entries that import plugin files from a
 *     temporary directory. Nothing is faked — if the reload works here it works
 *     in the Host, because it is the same Cordis, the same Loader and the same
 *     Node ESM loader.
 *
 * The module is import-safe: importing it does no work beyond resolving paths.
 *
 * @module test/harness
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Candidate extraction roots, most durable first. */
const CANDIDATES = [join(homedir(), ".dsh", ".asar-x"), "/tmp/asar-x"];

/** The in-asar path prefix every extracted package keeps. */
const PREFIX = "dsh/node_modules/@deepseek-ai";

/** First extraction root that actually contains the packages. */
function resolveRoot() {
	for (const root of CANDIDATES) {
		if (existsSync(join(root, PREFIX, "cordis", "lib", "index.js"))) return root;
	}
	throw new Error(
		"dsh-plugin-updater tests: no extracted app.asar found.\n" +
			`Looked in: ${CANDIDATES.join(", ")}\n` +
			"Rebuild one with:\n" +
			"  mkdir -p ~/.dsh/.asar-x && npx --yes @electron/asar extract \\\n" +
			'    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" ~/.dsh/.asar-x\n',
	);
}

/** Absolute path to the extracted `@deepseek-ai/<name>` directory. */
export function packageDir(name) {
	return join(resolveRoot(), PREFIX, name);
}

/** `file://` URL for one extracted entry point, suitable for dynamic import. */
export function packageEntry(name, entry = "lib/index.js") {
	return `file://${join(packageDir(name), entry)}`;
}

// Ensure the preferred root exists so a future extraction has a home.
mkdirSync(join(homedir(), ".dsh", ".asar-x"), { recursive: true });

/**
 * True when this machine has an extracted app.asar to import Cordis from.
 *
 * CI runners do not: the asar lives inside the desktop app bundle, which only
 * exists on a machine that has DSH installed. So a missing extraction is a
 * SKIP, not a failure — a hard throw here would turn every CI run red for a
 * reason that has nothing to do with the code under test.
 */
export const HAS_ASAR = (() => {
	try {
		resolveRoot();
		return true;
	} catch {
		return false;
	}
})();

/** Extraction root, or null when this machine has none. */
export const ASAR_ROOT = HAS_ASAR ? resolveRoot() : null;

/**
 * The Cordis `Context` class, re-exported so a test needs one import for its
 * whole bootstrap. Resolved through {@link packageEntry}, never a hardcoded
 * path, so a cleared `/tmp` cannot break it. Null without an extraction.
 */
export const { Context } = HAS_ASAR ? await import(packageEntry("cordis")) : { Context: null };

/**
 * The real Loader service (`Context` plugin) that owns loader entries.
 * Null without an extraction.
 */
export const { default: Loader } = HAS_ASAR
  ? await import(packageEntry("cordis-plugin-loader"))
  : { default: null };

/**
 * True when this process can reach Node's internal ESM loader — the thing
 * `lib/reload.js` evicts module cache entries from.
 *
 * The extracted `Loader` already classifies the shape exactly the way the Host
 * does (`v2` when it owns `getOrCreateModuleJob`, `v1` when it owns
 * `getModuleJobForImport`), so we reuse that classification instead of
 * re-deriving it from `process.versions.node`.
 */
export async function internalLoader() {
	// No extraction on this machine (a CI runner): there is no Cordis to boot,
	// so report the same "unavailable" sentinel the callers already understand
	// and let them skip. Throwing here would redden the whole suite instead.
	if (!HAS_ASAR || !Context || !Loader) return undefined;

	// `Loader.internal` is resolved once at CONSTRUCTION from the running
	// process, using the same `ModuleLoader.fromInternal` probe the Host uses,
	// so any instance reports the same object. Reading it back through the
	// context requires the service's injection to have settled first: before
	// that, `ctx.loader` throws "cannot get property loader without inject".
	const fiber = new Context().plugin(Loader, {});
	await fiber.await?.();
	return fiber.ctx?.loader?.internal ?? undefined;
}

/**
 * Start a real Cordis runtime whose plugin entry names resolve against
 * `baseDir`.
 *
 * `baseDir` may be any absolute directory; FILESYSTEM CALLS FROM TESTS SHOULD
 * USE {@link realBaseDir} because Node reports module URLs through the
 * realpath (`/var` -> `/private/var` on macOS), and `lib/reload.js` must be
 * compared against realpath'd paths for its subtree match to hit.
 *
 * @param {string} baseDir absolute directory used to resolve `./x` entry names
 * @returns {Promise<{ctx: import("@deepseek-ai/cordis").Context, loader: any, dispose: () => Promise<void>}>}
 */
export async function bootRuntime(baseDir) {
	const ctx = new Context();
	const fiber = ctx.plugin(Loader, { baseUrl: new URL(`file://${realBaseDir(baseDir)}/`) });
	await fiber.await?.();
	const loader = ctx.loader;
	if (!loader) throw new Error("harness: the Loader service did not start");
	return {
		ctx,
		loader,
		/** Stop every plugin and every entry, then detach the runtime. */
		async dispose() {
			for (const entry of [...loader.entries()]) {
				try {
					entry.fiber?.dispose();
				} catch {}
			}
			try {
				ctx.fiber?.dispose?.();
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}

/**
 * Node's module URLs are built from realpaths; tests that compute the
 * directory they then compare against must use the same form.
 *
 * @param {string} path
 * @returns {string}
 */
export function realBaseDir(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Load one of the package's own modules, or `null` when it does not exist yet. */
export async function importLib(fileName) {
	const url = new URL(`../lib/${fileName}`, import.meta.url);
	const { existsSync: exists } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const file = fileURLToPath(url);
	if (!exists(file)) return null;
	return import(url.href);
}

/** Convenience: the repo root of the package under test. */
export const PACKAGE_ROOT = new URL("..", import.meta.url);
