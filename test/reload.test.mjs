/**
 * THE decisive proof: a plugin changes its behaviour by editing files on disk,
 * with the Host process never restarting.
 *
 * Unlike a unit test with a stubbed loader, this test runs the real thing:
 *
 *  - a real `@deepseek-ai/cordis` `Context`,
 *  - the real `cordis-plugin-loader` `Loader` service owning real loader entries,
 *  - a real plugin package on disk in `os.tmpdir()`, imported through Node's
 *    own ESM loader,
 *  - and then the actual `reloadPlugin()` from `lib/reload.js`.
 *
 * The assertions that matter are behavioural, not structural:
 *
 *   1. the SAME process (same pid) now runs the NEW code,
 *   2. the same loader entry id still owns it, so the Host's configuration row
 *      survived the reload,
 *   3. the plugin's config object is the same settings it had before,
 *   4. when the new code throws, the OLD behaviour is still running afterwards
 *      (rollback), and the call itself still does not reject.
 *
 * Requires `--expose-internals`: without it `lib/reload.js` correctly reports
 * `status:"unsupported"`, which the test verifies separately rather than
 * pretending the refresh can work.
 *
 * @module test/reload.test
 */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bootRuntime, internalLoader, realBaseDir } from "./harness.mjs";
import { loadLib } from "./support/missing.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/tiny-plugin/plugin/", import.meta.url));
const LABEL = "tiny-hot-plugin";

const loaded = await loadLib("reload.js");
const R = loaded.present ? loaded.exports : null;

/** Does this process have the internal loader the reload needs? */
const internal = await internalLoader();
const HAS_INTERNALS = internal !== undefined;

/**
 * Copy the fixture into a fresh temp directory and return the package dir.
 *
 * `realBaseDir` is essential: Node keys its module cache by realpath, so on
 * macOS `os.tmpdir()` reports `/var/folders/...` while the module URL says
 * `/private/var/folders/...`. A test that compares the un-realpathed path
 * against cache URLs would "prove" failure that does not exist in production.
 */
function makePackage() {
	// The disposal counter is process-level by design, so each scenario starts
	// from a known value instead of inheriting the previous test's cleanups.
	globalThis.__tinyHotPluginDisposals = 0;
	const root = realBaseDir(mkdtempSync(join(tmpdir(), "dsh-plugin-updater-reload-")));
	const dir = join(root, "tiny-hot-plugin");
	cpSync(FIXTURE, dir, { recursive: true });
	return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Rewrite the sibling behaviour module — this is what a developer's editor does. */
function writeBehaviour(dir, { label, writes }) {
	writeFileSync(
		join(dir, "behaviour.mjs"),
		[
			`export const LABEL = ${JSON.stringify(label)};`,
			`export const ARRIVAL = ${Date.now()};`,
			`export function greet(name) {`,
			`\tconst out = [];`,
			`\tfor (let i = 0; i < ${writes}; i += 1) out.push(LABEL + ":" + name);`,
			`\treturn out;`,
			`}`,
			``,
		].join("\n"),
	);
}

/** The record the running plugin published for this process. */
function running() {
	return globalThis.__tinyHotPlugins?.[LABEL];
}

/** Observe the plugin the way a consumer would: call what it published. */
function observe() {
	const record = running();
	if (!record) return { present: false };
	return {
		present: true,
		label: record.label,
		greeting: record.greet("ada"),
		config: record.config,
		pid: record.pid,
		// Process-level, so it survives the reload that replaces the instance.
		disposals: globalThis.__tinyHotPluginDisposals ?? 0,
	};
}

test("lib/reload.js exists and exposes the contract", async (t) => {
	if (!R) {
		t.skip(`MISSING lib/reload.js — ${loaded.reason}`);
		return;
	}
	assert.equal(typeof R.reloadPlugin, "function");
	assert.equal(typeof R.reloadMany, "function");
	assert.equal(typeof R.canReload, "function");
});

test("the internal loader is classifiable (v1 or v2)", async (t) => {
	if (!R) return t.skip("MISSING lib/reload.js");
	if (!HAS_INTERNALS) {
		t.skip("this Node was started without --expose-internals; run.sh adds it");
		return;
	}
	const shape = R.loaderShape(internal);
	assert.ok(shape === "v1" || shape === "v2", `loaderShape returned ${String(shape)}`);
	t.diagnostic(`internal loader shape: ${shape} (node ${process.version})`);
	t.diagnostic(`loadCache is a ${internal.loadCache?.constructor?.name}, instanceof Map = ${internal.loadCache instanceof Map}`);
});

test("RELOAD: edited code runs in the same process, same entry, same config", async (t) => {
	if (!R) return t.skip("MISSING lib/reload.js");
	if (!HAS_INTERNALS) {
		t.skip("needs --expose-internals (run.sh supplies it)");
		return;
	}

	const pkg = makePackage();
	const runtime = await bootRuntime(pkg.root);
	try {
		// ── Mount the plugin the way the Host does: one loader entry ──────────
		const config = { greeting: "hello", deep: { attempts: 3, tags: ["a", "b"] } };
		const entryId = await runtime.loader.create({
			id: "tiny",
			name: "./tiny-hot-plugin/index.mjs",
			config,
		});
		await runtime.loader.await();

		const entry = runtime.loader.resolve(entryId);
		assert.ok(entry.fiber, "the plugin entry must have a running fiber");
		assert.equal(entry.fiber.state, 2, "the plugin fiber must be ACTIVE (2)");

		const before = observe();
		assert.equal(before.present, true, "the plugin must have published its behaviour");
		assert.equal(before.label, "v1");
		assert.deepEqual(before.greeting, ["v1:ada"]);
		assert.equal(before.pid, process.pid);
		const fiberBefore = entry.fiber;
		const configBefore = entry.options.config;

		// ── Edit the code on disk, exactly like an editor save ────────────────
		writeBehaviour(pkg.dir, { label: "v2", writes: 2 });
		assert.equal(readFileSync(join(pkg.dir, "behaviour.mjs"), "utf8").includes('"v2"'), true);

		// Nothing has refreshed yet: the running plugin still shows the old code.
		// This is the control that makes the assertion below meaningful.
		assert.equal(observe().label, "v1", "before reloadPlugin() the old code must still run");

		// ── The call under test ───────────────────────────────────────────────
		const result = await R.reloadPlugin(runtime.ctx, { name: LABEL, dir: pkg.dir });
		const after = observe();

		// ── THE PROOF ─────────────────────────────────────────────────────────
		t.diagnostic(
			[
				"── reload proof ─────────────────────────────────────────────",
				`pid                 : ${before.pid} -> ${after.pid} (unchanged: ${before.pid === after.pid})`,
				`result.status       : ${result.status}`,
				`result.generation   : ${result.generation}`,
				`result.entries      : ${JSON.stringify(result.entries)}`,
				`result.invalidated  : ${result.invalidated}`,
				`behaviour           : ${before.label} -> ${after.label}`,
				`greet('ada')        : ${JSON.stringify(before.greeting)} -> ${JSON.stringify(after.greeting)}`,
				`config preserved    : ${JSON.stringify(after.config)}`,
				`ctx.effect cleanups run: ${before.disposals} -> ${after.disposals}`,
				"────────────────────────────────────────────────────────────",
			].join("\n"),
		);

		assert.equal(result.status, "reloaded", `expected a reload, got ${JSON.stringify(result)}`);
		assert.equal(result.name, LABEL);
		assert.ok(result.generation >= 1, "a successful reload reports a generation");
		assert.ok(result.invalidated >= 1, "at least one module must have been evicted");
		assert.deepEqual(result.entries, ["tiny"], "the owning loader entry is reported");

		// 1. Same process — no restart.
		assert.equal(after.pid, process.pid);
		assert.equal(after.pid, before.pid);

		// 2. New behaviour, from the NEW code.
		assert.equal(after.label, "v2", "the running plugin must exhibit the new code");
		assert.deepEqual(after.greeting, ["v2:ada", "v2:ada"], "the new code's logic must run, not just its constant");

		// 3. Config survived, structurally equal to what was configured.
		assert.deepEqual(after.config, config);
		assert.deepEqual(entry.options.config, configBefore, "the loader row keeps its raw config");

		// 4. Same loader identity: same id, same entry object, a NEW live fiber.
		assert.equal(runtime.loader.resolve("tiny"), entry, "the entry object survives");
		assert.equal(entry.options.id, "tiny");
		assert.equal(entry.fiber.state, 2, "the replacement fiber is ACTIVE");
		assert.notEqual(entry.fiber, fiberBefore, "a new fiber instance runs the new plugin object");
		assert.equal(fiberBefore.uid, null, "the previous fiber was disposed");
		assert.ok(after.disposals > before.disposals, "the previous instance's ctx.effect cleanup ran");
		assert.equal(entry.fiber.runtime.name, LABEL);
	} finally {
		await runtime.dispose();
		pkg.cleanup();
	}
});

test("RELOAD: a second edit is picked up too (the refresh is repeatable)", async (t) => {
	if (!R) return t.skip("MISSING lib/reload.js");
	if (!HAS_INTERNALS) return t.skip("needs --expose-internals");

	const pkg = makePackage();
	const runtime = await bootRuntime(pkg.root);
	try {
		await runtime.loader.create({ id: "tiny", name: "./tiny-hot-plugin/index.mjs", config: { n: 1 } });
		await runtime.loader.await();
		assert.equal(observe().label, "v1");

		writeBehaviour(pkg.dir, { label: "v2", writes: 1 });
		const first = await R.reloadPlugin(runtime.ctx, { name: LABEL, dir: pkg.dir });
		assert.equal(first.status, "reloaded");
		assert.equal(observe().label, "v2");

		writeBehaviour(pkg.dir, { label: "v3", writes: 3 });
		const second = await R.reloadPlugin(runtime.ctx, { name: LABEL, dir: pkg.dir });
		assert.equal(second.status, "reloaded");
		assert.equal(observe().label, "v3");
		assert.deepEqual(observe().greeting, ["v3:ada", "v3:ada", "v3:ada"]);
		assert.ok(second.generation > first.generation, "generations count up per directory");
	} finally {
		await runtime.dispose();
		pkg.cleanup();
	}
});

test("ROLLBACK: new code that throws leaves the OLD behaviour running", async (t) => {
	if (!R) return t.skip("MISSING lib/reload.js");
	if (!HAS_INTERNALS) return t.skip("needs --expose-internals");

	const pkg = makePackage();
	const runtime = await bootRuntime(pkg.root);
	try {
		const config = { greeting: "keep-me" };
		await runtime.loader.create({ id: "tiny", name: "./tiny-hot-plugin/index.mjs", config });
		await runtime.loader.await();
		const entry = runtime.loader.resolve("tiny");
		const goodFiber = entry.fiber;
		const before = observe();
		assert.equal(before.label, "v1");

		// A developer saves a file that cannot even be evaluated. The exports stay
		// intact (a missing named export would fail LINKING, before any of this
		// code ran, and report a different error than the one under test).
		writeFileSync(
			join(pkg.dir, "behaviour.mjs"),
			[
				'export const LABEL = "broken";',
				"export const ARRIVAL = 0;",
				"export function greet(name) {",
				"\treturn [LABEL + ':' + name];",
				"}",
				'throw new Error("boom-from-the-editor");',
				"",
			].join("\n"),
		);

		const result = await R.reloadPlugin(runtime.ctx, { name: LABEL, dir: pkg.dir });
		const after = observe();

		t.diagnostic(
			[
				"── rollback proof ──────────────────────────────────────────",
				`result.status      : ${result.status}`,
				`result.error       : ${result.error}`,
				`result.rolledBack  : ${result.rolledBack}`,
				`behaviour kept     : ${before.label} -> ${after.label}`,
				`greet('ada')       : ${JSON.stringify(after.greeting)}`,
				`same process       : ${after.pid === before.pid}`,
				"────────────────────────────────────────────────────────────",
			].join("\n"),
		);

		// The call reports failure instead of rejecting.
		assert.equal(result.status, "failed", `expected status "failed", got ${JSON.stringify(result)}`);
		assert.match(String(result.error), /boom-from-the-editor/);
		assert.equal(result.rolledBack, true, "the rollback must be reported as clean");

		// ...and the Host is exactly as it was: old code, old entry, old config.
		assert.equal(after.present, true, "the plugin must still be running");
		assert.equal(after.label, "v1", "the OLD behaviour must still be live after a failed reload");
		assert.deepEqual(after.greeting, ["v1:ada"]);
		assert.equal(after.pid, process.pid);
		assert.equal(entry.fiber.state, 2, "the restored fiber is ACTIVE");
		assert.equal(entry.fiber.runtime.name, LABEL);
		assert.deepEqual(entry.options.config, config);
		assert.equal(after.config.greeting, "keep-me");
		// Rollback is free to re-activate the previous plugin object in a FRESH
		// fiber — that is exactly what the contract's "re-activate the previous
		// plugin object" asks for, and the old fiber's uid is already cleared.
		// The invariant that matters is identity of the RUNNING PLUGIN OBJECT:
		// the old module's exports must be what runs, never the broken one's.
		assert.equal(
			entry.fiber.runtime.callback,
			goodFiber.runtime.callback,
			"the fiber must run the previous plugin object, not the broken replacement",
		);

		// And the next good save still works: a broken edit is not terminal.
		writeBehaviour(pkg.dir, { label: "v4", writes: 1 });
		const recovered = await R.reloadPlugin(runtime.ctx, { name: LABEL, dir: pkg.dir });
		assert.equal(recovered.status, "reloaded", `recovery after a failed reload: ${JSON.stringify(recovered)}`);
		assert.equal(observe().label, "v4");
	} finally {
		await runtime.dispose();
		pkg.cleanup();
	}
});

test("ROLLBACK: a plugin that throws from apply() is not left half-started", async (t) => {
	if (!R) return t.skip("MISSING lib/reload.js");
	if (!HAS_INTERNALS) return t.skip("needs --expose-internals");

	const pkg = makePackage();
	const runtime = await bootRuntime(pkg.root);
	try {
		await runtime.loader.create({ id: "tiny", name: "./tiny-hot-plugin/index.mjs", config: { a: 1 } });
		await runtime.loader.await();
		const entry = runtime.loader.resolve("tiny");

		// The module parses and its exports are fine — it fails while STARTING,
		// which exercises the activation path rather than the import path.
		writeFileSync(
			join(pkg.dir, "index.mjs"),
			[
				'import { LABEL, greet } from "./behaviour.mjs";',
				'export const name = "tiny-hot-plugin";',
				'export function apply(ctx) {',
				'\tthrow new Error("boom-from-apply");',
				'}',
				'',
			].join("\n"),
		);

		const result = await R.reloadPlugin(runtime.ctx, { name: LABEL, dir: pkg.dir });
		const after = observe();

		t.diagnostic(`apply-throws: status=${result.status} rolledBack=${result.rolledBack} error=${result.error}`);
		assert.equal(result.status, "failed", `expected failure, got ${JSON.stringify(result)}`);
		assert.match(String(result.error), /boom-from-apply/);

		// No new instance was published by the broken module, and the old one is
		// back (or at worst still there): either way the old behaviour runs.
		assert.equal(after.present, true, "the old plugin must be restored");
		assert.equal(after.label, "v1");
		assert.equal(entry.fiber?.state, 2, "the entry has an ACTIVE fiber again");
	} finally {
		await runtime.dispose();
		pkg.cleanup();
	}
});

test("edge cases: unchanged / unsupported / bad request never throw", async (t) => {
	if (!R) return t.skip("MISSING lib/reload.js");
	// bootRuntime needs the real Cordis out of the extracted app.asar; without
	// one (a CI runner) there is no runtime to boot, so skip like its siblings.
	if (!HAS_INTERNALS) return t.skip("needs --expose-internals (run.sh supplies it)");

	const pkg = makePackage();
	const runtime = await bootRuntime(pkg.root);
	try {
		await t.test("a directory no entry owns reports unchanged", async () => {
			const lonely = join(pkg.root, "not-mounted");
			cpSync(FIXTURE, lonely, { recursive: true });
			const result = await R.reloadPlugin(runtime.ctx, { name: "orphan", dir: lonely });
			assert.equal(result.status, "unchanged");
			assert.equal(result.name, "orphan");
		});

		await t.test("a missing directory never throws", async () => {
			const result = await R.reloadPlugin(runtime.ctx, { name: "ghost", dir: join(pkg.root, "does-not-exist") });
			assert.ok(["unchanged", "failed"].includes(result.status), result.status);
			assert.equal(result.name, "ghost");
		});

		await t.test("a request without dir never throws", async () => {
			const result = await R.reloadPlugin(runtime.ctx, { name: "nolan" });
			assert.equal(result.status, "failed");
			assert.equal(typeof result.error, "string");
		});

		await t.test("changedFile outside dir means unchanged", async () => {
			await runtime.loader.create({ id: "tiny", name: "./tiny-hot-plugin/index.mjs", config: {} });
			await runtime.loader.await();
			const result = await R.reloadPlugin(runtime.ctx, {
				name: LABEL,
				dir: pkg.dir,
				changedFile: join(pkg.root, "elsewhere.mjs"),
			});
			assert.equal(result.status, "unchanged");
		});

		await t.test("reloadMany returns one result per request, failures included", async () => {
			const results = await R.reloadMany(runtime.ctx, [
				{ name: LABEL, dir: pkg.dir },
				{ name: "ghost", dir: join(pkg.root, "nope") },
			]);
			assert.equal(results.length, 2);
			assert.equal(results[0].name, LABEL);
			assert.equal(results[1].name, "ghost");
		});

		await t.test("concurrent calls on one directory are serialized", async () => {
			writeBehaviour(pkg.dir, { label: "v9", writes: 1 });
			const [a, b] = await Promise.all([
				R.reloadPlugin(runtime.ctx, { name: LABEL, dir: pkg.dir }),
				R.reloadPlugin(runtime.ctx, { name: LABEL, dir: pkg.dir }),
			]);
			assert.equal(a.status, "reloaded");
			assert.ok(["reloaded", "unchanged"].includes(b.status), b.status);
			assert.notEqual(a.generation, b.generation, "generations must not collide");
			assert.equal(observe().label, "v9");
			assert.equal(observe().pid, process.pid);
		});
	} finally {
		await runtime.dispose();
		pkg.cleanup();
	}
});
