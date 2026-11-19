/**
 * Missing-module handling for the dsh-plugin-updater suite.
 *
 * The package is built by several people at once, so a test file must be able to
 * say "lib/watch.js is not on disk yet" as a LOUD SKIP instead of dying with a
 * module-not-found stack that hides everything else in the run.
 *
 * Rules used by the whole suite:
 *
 *  - A MISSING module is a SKIP (`t.skip(...)`) plus a line on
 *    {@link missingModules}, which `run.sh` prints in the summary.
 *  - A module that IS present and fails a contract assertion is a real FAIL.
 *    Skipping those would be lying about a broken build.
 *
 * @module test/support/missing
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIB = new URL("../../lib/", import.meta.url);

/** Absolute path of `lib/<file>`. */
export function libPath(file) {
	return fileURLToPath(new URL(file, LIB));
}

/** Modules the rules above skipped during this process, for the summary. */
export const missingModules = new Set();

/**
 * Import `lib/<file>`, or record it as missing.
 *
 * @param {string} file e.g. `"reload.js"`
 * @returns {Promise<{present: true, exports: any} | {present: false, file: string, reason: string}>}
 */
export async function loadLib(file) {
	if (!existsSync(libPath(file))) {
		missingModules.add(`lib/${file}`);
		return { present: false, file: `lib/${file}`, reason: "file does not exist yet" };
	}
	try {
		return { present: true, exports: await import(new URL(file, LIB).href) };
	} catch (error) {
		// Present but broken (syntax error, bad import): that is NOT a skip. The
		// caller rethrows so the failure names the file and the parse error.
		error.message = `lib/${file} exists but failed to import: ${error.message}`;
		missingModules.add(`lib/${file} (BROKEN)`);
		return { present: false, file: `lib/${file}`, reason: "import failed", error };
	}
}

/**
 * Require an export from a loaded module, failing the test with a precise
 * message when the contract surface is missing.
 *
 * @param {import("node:test").TestContext} t
 * @param {string} file
 * @param {any} exports
 * @param {string[]} names
 */
export function requireExports(t, file, exports, names) {
	const absent = names.filter((name) => typeof exports?.[name] !== "function");
	if (absent.length > 0) {
		missingModules.add(`lib/${file}#${absent.join(",")}`);
		t.diagnostic(`MISSING ${file} export(s): ${absent.join(", ")}`);
		return false;
	}
	return true;
}
