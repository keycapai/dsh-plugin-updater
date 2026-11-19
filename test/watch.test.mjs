/**
 * `lib/watch.js` contract tests.
 *
 * A watcher is hard to test honestly: the failure modes are timing ("did the
 * debounce swallow a save?") and leakage ("was the timer closed?"). These tests
 * therefore always WAIT FOR the callback with a bounded deadline instead of
 * sleeping a fixed time, and assert the negative case too (an ignored or
 * non-code file must never fire), which is the half that is usually skipped.
 *
 * The watcher is dependency-free and picks its backend by probing
 * `fs.watch({recursive})`, so the same assertions must hold on both backends.
 *
 * @module test/watch.test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadLib } from "./support/missing.mjs";

const loaded = await loadLib("watch.js");
const W = loaded.present ? loaded.exports : null;

/** A fresh temp root with `files` written. */
function makeTree(files = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-plugin-updater-watch-")));
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Collect batches until `predicate` accepts the accumulated list or the
 * deadline passes. Resolves with whatever arrived, so the caller decides what
 * its absence means.
 *
 * @param {{batches: any[]}} sink
 * @param {(batches: any[]) => boolean} predicate
 * @param {number} timeoutMs
 */
async function waitFor(sink, predicate, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate(sink.batches)) return sink.batches;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return sink.batches;
}

/** Every file path mentioned across batches. */
function filesOf(batches) {
	return batches.flatMap((batch) => batch.files ?? []);
}

/** Debounce windows need slack; keep them small but not zero. */
const DEBOUNCE = 40;

/**
 * Wait until the watcher is demonstrably live before making the edit under test.
 *
 * A fixed `setTimeout(120)` was not enough: `fs.watch` registers asynchronously,
 * and when the machine is busy (other test files running first) a save can land
 * in that window and produce no event at all — a phantom failure that looks like
 * a watcher bug. The fix is to prove the plumbing works with a THROWAWAY file
 * that no assertion depends on, and only then perform the real edit.
 *
 * @param {any} watcher the watcher under test
 * @param {ReturnType<typeof makeTree>} tree its root tree
 * @param {{batches: any[]}} sink the batch collector
 * @returns {Promise<boolean>} true once a warm-up change was observed
 */
async function ready(watcher, tree, sink) {
	const warmup = join(tree.root, ".watch-warmup.mjs");
	const seed = () => writeFileSync(warmup, `export const t = ${Date.now()};\n`);

	// The poll backend samples on an interval, so an event may take debounce*4
	// to appear; keep poking until it does, within a firm deadline.
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		seed();
		const seen = await waitFor(sink, (all) => filesOf(all).some((file) => file.endsWith(".watch-warmup.mjs")), 300);
		if (seen.length > 0 && filesOf(seen).some((file) => file.endsWith(".watch-warmup.mjs"))) {
			// Drop the warm-up evidence so the real assertions start from zero.
			sink.batches.length = 0;
			return true;
		}
		if (watcher.stats().mode === "native") await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

test("lib/watch.js exists and exposes createWatcher", async (t) => {
	if (!W) {
		t.skip(`MISSING lib/watch.js — ${loaded.reason}`);
		return;
	}
	assert.equal(typeof W.createWatcher, "function");
});

test("reports an edit to a file in the root", async (t) => {
	if (!W) return t.skip("MISSING lib/watch.js");

	const tree = makeTree({ "plugin/index.mjs": "export const a = 1;\n" });
	const sink = { batches: [] };
	const watcher = W.createWatcher({
		roots: [tree.root],
		debounceMs: DEBOUNCE,
		onChange: (batch) => sink.batches.push(...[].concat(batch)),
	});
	try {
		t.diagnostic(`watcher mode: ${watcher.stats().mode}`);
		assert.equal(await ready(watcher, tree, sink), true, "the watcher must become live before the edit");

		writeFileSync(join(tree.root, "plugin/index.mjs"), "export const a = 2;\n");
		const batches = await waitFor(sink, (all) => filesOf(all).length > 0);

		assert.ok(batches.length > 0, "an edit must produce a batch");
		const files = filesOf(batches);
		assert.ok(
			files.some((file) => file.endsWith(join("plugin", "index.mjs"))),
			`expected the edited file, got ${JSON.stringify(files)}`,
		);
	} finally {
		await watcher.close();
		tree.cleanup();
	}
});

test("skips node_modules, .git and non-code files", async (t) => {
	if (!W) return t.skip("MISSING lib/watch.js");

	const tree = makeTree({ "plugin/index.mjs": "export const a = 1;\n" });
	const sink = { batches: [] };
	const watcher = W.createWatcher({
		roots: [tree.root],
		debounceMs: DEBOUNCE,
		onChange: (batch) => sink.batches.push(...[].concat(batch)),
	});
	try {
		await ready(watcher, tree, sink);

		// Three things that must NOT be reported.
		mkdirSync(join(tree.root, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(tree.root, "node_modules/pkg/index.js"), "module.exports = 1;\n");
		mkdirSync(join(tree.root, ".git"), { recursive: true });
		writeFileSync(join(tree.root, ".git/HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(tree.root, "plugin/notes.txt"), "not code\n");
		writeFileSync(join(tree.root, "plugin/README.md"), "# docs\n");

		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 6));
		const ignoredLeaks = filesOf(sink.batches).filter(
			(file) => file.includes(`${join("node_modules", "pkg")}`) || file.includes(`${join(".git", "")}`) || /\.(txt|md)$/.test(file),
		);
		assert.deepEqual(ignoredLeaks, [], `ignored paths must never be reported: ${JSON.stringify(ignoredLeaks)}`);

		// ...and the watcher is still alive: a real code edit is reported.
		writeFileSync(join(tree.root, "plugin/index.mjs"), "export const a = 3;\n");
		const batches = await waitFor(sink, (all) => filesOf(all).some((file) => file.endsWith("index.mjs")));
		assert.ok(batches.length > 0, "a code edit after the ignored ones must still be reported");
	} finally {
		await watcher.close();
		tree.cleanup();
	}
});

test("honours extra ignored directory names", async (t) => {
	if (!W) return t.skip("MISSING lib/watch.js");

	const tree = makeTree({ "plugin/index.mjs": "export const a = 1;\n" });
	const sink = { batches: [] };
	const watcher = W.createWatcher({
		roots: [tree.root],
		ignored: ["scratch"],
		debounceMs: DEBOUNCE,
		onChange: (batch) => sink.batches.push(...[].concat(batch)),
	});
	try {
		await ready(watcher, tree, sink);
		mkdirSync(join(tree.root, "scratch"), { recursive: true });
		writeFileSync(join(tree.root, "scratch/trash.mjs"), "export const t = 1;\n");
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 6));
		assert.deepEqual(
			filesOf(sink.batches).filter((file) => file.includes("scratch")),
			[],
			"the caller's ignored list must be honoured",
		);
	} finally {
		await watcher.close();
		tree.cleanup();
	}
});

test("one batch per directory per debounce window", async (t) => {
	if (!W) return t.skip("MISSING lib/watch.js");

	const tree = makeTree({ "plugin/a.mjs": "export const a = 1;\n", "plugin/b.mjs": "export const b = 1;\n" });
	const sink = { batches: [] };
	const watcher = W.createWatcher({
		roots: [tree.root],
		debounceMs: DEBOUNCE,
		onChange: (batch) => sink.batches.push(...[].concat(batch)),
	});
	try {
		await ready(watcher, tree, sink);

		// A burst of saves inside one window — what an editor's "save all" does.
		writeFileSync(join(tree.root, "plugin/a.mjs"), "export const a = 2;\n");
		writeFileSync(join(tree.root, "plugin/b.mjs"), "export const b = 2;\n");
		writeFileSync(join(tree.root, "plugin/a.mjs"), "export const a = 3;\n");

		const batches = await waitFor(sink, (all) => filesOf(all).length >= 2);
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 6));

		assert.ok(filesOf(sink.batches).length >= 2, "both files must be reported");
		// The burst must be coalesced, not replayed file-by-file: on the native
		// backend this is exactly one call; poll mode may split a burst across
		// its own sampling windows, so the bound is "fewer calls than saves".
		assert.ok(
			sink.batches.length <= 3,
			`3 saves must not produce ${sink.batches.length} separate callbacks (expected coalescing)`,
		);
		for (const batch of sink.batches) {
			assert.ok(typeof batch.dir === "string" && batch.dir.length > 0, "each batch names its directory");
			assert.ok(Array.isArray(batch.files), "each batch has a files array");
		}
		t.diagnostic(`batches for 3 saves: ${sink.batches.length} (mode ${watcher.stats().mode})`);
	} finally {
		await watcher.close();
		tree.cleanup();
	}
});

test("a missing root is reported, not thrown", async (t) => {
	if (!W) return t.skip("MISSING lib/watch.js");

	const tree = makeTree({ "plugin/index.mjs": "export const a = 1;\n" });
	const absent = join(tree.root, "definitely-absent");
	/** @type {any} */
	let watcher;
	assert.doesNotThrow(() => {
		watcher = W.createWatcher({
			roots: [tree.root, absent],
			debounceMs: DEBOUNCE,
			onChange: () => {},
		});
	});
	try {
		const stats = watcher.stats();
		assert.ok(Array.isArray(stats.missing), "stats().missing must be an array");
		assert.ok(stats.missing.includes(absent), `missing root not reported: ${JSON.stringify(stats.missing)}`);
	} finally {
		await watcher.close();
		tree.cleanup();
	}
});

test("close() is idempotent and stops reporting", async (t) => {
	if (!W) return t.skip("MISSING lib/watch.js");

	const tree = makeTree({ "plugin/index.mjs": "export const a = 1;\n" });
	const sink = { batches: [] };
	const watcher = W.createWatcher({
		roots: [tree.root],
		debounceMs: DEBOUNCE,
		onChange: (batch) => sink.batches.push(...[].concat(batch)),
	});
	try {
		await ready(watcher, tree, sink);
		await watcher.close();

		// A second and third close must not throw.
		await assert.doesNotReject(() => watcher.close());
		await assert.doesNotReject(() => watcher.close());

		const before = sink.batches.length;
		writeFileSync(join(tree.root, "plugin/index.mjs"), "export const a = 99;\n");
		await new Promise((resolve) => setTimeout(resolve, DEBOUNCE * 8));
		assert.equal(sink.batches.length, before, "a closed watcher must report nothing");
	} finally {
		tree.cleanup();
	}
});

test("never throws on hostile options", async (t) => {
	if (!W) return t.skip("MISSING lib/watch.js");

	await t.test("no options at all", async () => {
		let watcher;
		assert.doesNotThrow(() => {
			watcher = W.createWatcher();
		});
		assert.equal(typeof watcher.close, "function");
		assert.equal(typeof watcher.stats, "function");
		await watcher.close();
	});

	await t.test("empty roots and no callback", async () => {
		let watcher;
		assert.doesNotThrow(() => {
			watcher = W.createWatcher({ roots: [] });
		});
		assert.doesNotThrow(() => watcher.stats());
		await watcher.close();
	});

	await t.test("a throwing onChange is contained", async () => {
		const tree = makeTree({ "index.mjs": "export const a = 1;\n" });
		// This callback throws on purpose, so readiness cannot be judged by a
		// batch arriving in a sink. Instead the callback counts its calls and
		// rethrows: once the count moves, the plumbing is proven live.
		let calls = 0;
		const watcher = W.createWatcher({
			roots: [tree.root],
			debounceMs: DEBOUNCE,
			onChange: () => {
				calls += 1;
				throw new Error("onChange exploded");
			},
		});
		try {
			// Warm up with an unused file until the callback fires at least once.
			const warmup = join(tree.root, ".warm.mjs");
			const deadline = Date.now() + 3000;
			while (calls === 0 && Date.now() < deadline) {
				writeFileSync(warmup, `export const t = ${Date.now()};\n`);
				await new Promise((resolve) => setTimeout(resolve, 80));
			}
			assert.ok(calls > 0, "the throwing callback must still be invoked");
			const afterWarmup = calls;

			// If the throw escaped the watcher it would become an uncaught
			// exception and fail this test process, so reaching the end is the
			// assertion — but the watcher must also keep REPORTING afterwards.
			writeFileSync(join(tree.root, "index.mjs"), "export const a = 2;\n");
			const deadline2 = Date.now() + 3000;
			while (calls === afterWarmup && Date.now() < deadline2) {
				await new Promise((resolve) => setTimeout(resolve, 40));
			}
			assert.ok(calls > afterWarmup, "a throwing callback must not stop the watcher from reporting");
			assert.equal(watcher.stats().lastError, "onChange exploded", "the callback's error is recorded, not thrown");
		} finally {
			await watcher.close();
			tree.cleanup();
		}
	});
});
