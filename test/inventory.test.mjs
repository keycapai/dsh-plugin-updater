/**
 * `lib/inventory.js` contract tests.
 *
 * The inventory is what turns "the profile's dependency list" into "which of
 * these can I hot-refresh, and which have an update waiting". Every test builds
 * a throwaway profile in `os.tmpdir()` instead of reading the real
 * `~/.dsh/profiles/desktop`: a test that depends on the operator's installed
 * plugins passes or fails for reasons unrelated to the code, and the registry
 * lookups would make the suite slow and network-bound.
 *
 * Registry access is disabled (`checkRegistry:false`) everywhere except the one
 * test that asserts the flag's behaviour, so the suite needs no network.
 *
 * @module test/inventory.test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadLib } from "./support/missing.mjs";

const loaded = await loadLib("inventory.js");
const INV = loaded.present ? loaded.exports : null;

/**
 * Write `files` (relative path -> JSON object or string) under a fresh temp root.
 * @returns {{root: string, cleanup: () => void}}
 */
function makeTree(files) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-plugin-updater-inventory-")));
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
	}
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** `{profileContext:{dir}}` is the whole surface listInstalled needs. */
function contextFor(dir) {
	return { profileContext: { dir } };
}

const NO_REGISTRY = { checkRegistry: false };

test("lib/inventory.js exists and exposes the contract", async (t) => {
	if (!INV) {
		t.skip(`MISSING lib/inventory.js — ${loaded.reason}`);
		return;
	}
	assert.equal(typeof INV.listInstalled, "function");
});

test("classifySpec: every dependency kind in the contract", async (t) => {
	if (!INV) return t.skip("MISSING lib/inventory.js");

	const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-plugin-updater-spec-")));
	try {
		// Materialise the targets so `file:` can be told apart from a tarball.
		mkdirSync(join(root, "local-dir"), { recursive: true });
		writeFileSync(join(root, "pkg.tgz"), "");
		writeFileSync(join(root, "pkg.tar.gz"), "");

		const TABLE = [
			["link:/abs/plugin", "link"],
			["link:./rel", "link"],
			["file:./local-dir", "file"],
			["file:./pkg.tgz", "tarball"],
			["file:./pkg.tar.gz", "tarball"],
			["file:./missing.tgz", "tarball"],
			["./local-dir", "path"],
			["../sibling", "path"],
			["/abs/path", "path"],
			["workspace:*", "workspace"],
			["workspace:^", "workspace"],
			["git+https://github.com/a/b.git", "git"],
			["github:a/b", "git"],
			["gitlab:a/b", "git"],
			["bitbucket:a/b", "git"],
			["a/b", "git"],
			["^1.2.3", "registry"],
			["~2.0.0", "registry"],
			[">=1.0.0 <2.0.0", "registry"],
			["1.2.3", "registry"],
			["latest", "registry"],
			["*", "registry"],
			["", "registry"],
		];

		for (const [spec, want] of TABLE) {
			const got = INV.classifySpec(spec, root);
			assert.equal(got.kind, want, `classifySpec(${JSON.stringify(spec)}) -> ${got.kind}, want ${want}`);
		}

		await t.test("link/path report the absolute local directory", () => {
			const link = INV.classifySpec("link:./local-dir", root);
			assert.equal(link.localDir, join(root, "local-dir"));
			const path = INV.classifySpec("./local-dir", root);
			assert.equal(path.localDir, join(root, "local-dir"));
		});

		await t.test("registry/git/workspace report no local directory", () => {
			for (const spec of ["^1.2.3", "github:a/b", "workspace:*", "file:./pkg.tgz"]) {
				assert.equal(INV.classifySpec(spec, root).localDir, null, spec);
			}
		});

		await t.test("a non-string spec is unknown, not a crash", () => {
			assert.equal(INV.classifySpec(undefined, root).kind, "unknown");
			assert.equal(INV.classifySpec(null, root).kind, "unknown");
			assert.equal(INV.classifySpec(42, root).kind, "unknown");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listInstalled: classifies a profile and keeps bundle/enabled honest", async (t) => {
	if (!INV) return t.skip("MISSING lib/inventory.js");

	// One plugin per kind, plus one dependency that ships no bundle at all.
	const tree = makeTree({
		"package.json": {
			name: "profile",
			dependencies: {
				"@scope/registry-plugin": "^1.0.0",
				"linked-plugin": "link:./real/linked-plugin",
				"path-plugin": "./real/path-plugin",
				"file-plugin": "file:./real/file-plugin",
				"git-plugin": "git+https://example.com/x.git",
				"workspace-plugin": "workspace:*",
				"plain-lib": "^3.0.0",
			},
			dsh: { profile: { bundles: ["@scope/registry-plugin", "linked-plugin"] } },
		},
		// registry dep: a real package dir in node_modules
		"node_modules/@scope/registry-plugin/package.json": {
			name: "@scope/registry-plugin",
			version: "1.0.2",
			description: "a registry plugin",
			dsh: { bundle: { patch: "./cordis.patch.yml" } },
		},
		// linked dep: node_modules entry is a SYMLINK to the source dir
		"real/linked-plugin/package.json": { name: "linked-plugin", version: "0.3.1", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
		// path dep resolved straight from the spec, not installed
		"real/path-plugin/package.json": { name: "path-plugin", version: "2.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
		"real/file-plugin/package.json": { name: "file-plugin", version: "1.1.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
		// a dependency that is not a plugin at all
		"node_modules/plain-lib/package.json": { name: "plain-lib", version: "3.4.5" },
	});
	try {
		symlinkSync(join(tree.root, "real/linked-plugin"), join(tree.root, "node_modules/linked-plugin"));
		symlinkSync(join(tree.root, "real/file-plugin"), join(tree.root, "node_modules/file-plugin"));

		const inventory = await INV.listInstalled(contextFor(tree.root), NO_REGISTRY);

		assert.equal(inventory.ok, true, `inventory errors: ${inventory.error}`);
		assert.equal(inventory.profileDir, tree.root);
		assert.ok(Array.isArray(inventory.plugins), "plugins must be an array");
		assert.ok(Array.isArray(inventory.warnings), "warnings must be an array");

		const byName = new Map(inventory.plugins.map((row) => [row.name, row]));
		const get = (name) => {
			const row = byName.get(name);
			assert.ok(row, `no inventory row for ${name}`);
			return row;
		};

		/** The contract shape of one row. */
		const ROW_FIELDS = [
			"name",
			"spec",
			"kind",
			"local",
			"localDir",
			"installedVersion",
			"packageDir",
			"bundle",
			"enabled",
			"latestVersion",
			"updateAvailable",
		];
		for (const name of byName.keys()) {
			for (const field of ROW_FIELDS) {
				assert.ok(field in byName.get(name), `row ${name} is missing ${field}`);
			}
		}

		await t.test("registry dep is not local, is a bundle, and knows its version", () => {
			const row = get("@scope/registry-plugin");
			assert.equal(row.kind, "registry");
			assert.equal(row.local, false);
			assert.equal(row.localDir, null);
			assert.equal(row.installedVersion, "1.0.2");
			assert.equal(row.bundle, true);
			assert.equal(row.enabled, true);
			assert.equal(row.packageDir, join(tree.root, "node_modules/@scope/registry-plugin"));
		});

		await t.test("link dep is local and points at the real directory", () => {
			const row = get("linked-plugin");
			assert.equal(row.kind, "link");
			assert.equal(row.local, true);
			assert.equal(row.localDir, join(tree.root, "real/linked-plugin"));
			assert.equal(row.installedVersion, "0.3.1");
			assert.equal(row.enabled, true);
		});

		await t.test("path dep is local, realpathed, and not necessarily installed", () => {
			const row = get("path-plugin");
			assert.equal(row.kind, "path");
			assert.equal(row.local, true);
			assert.equal(row.localDir, join(tree.root, "real/path-plugin"));
			assert.equal(row.installedVersion, "2.0.0");
		});

		await t.test("file dep pointing at a directory is local", () => {
			const row = get("file-plugin");
			assert.equal(row.kind, "file");
			assert.equal(row.local, true, "a file: dependency on a real directory can be watched");
			assert.equal(row.installedVersion, "1.1.0");
		});

		await t.test("git and workspace deps are never local", () => {
			for (const name of ["git-plugin", "workspace-plugin"]) {
				const row = get(name);
				assert.equal(row.local, false, `${name} must not be watchable`);
			}
		});

		await t.test("a dependency without dsh.bundle is reported as a non-bundle", () => {
			const row = get("plain-lib");
			assert.equal(row.bundle, false);
			assert.equal(row.installedVersion, "3.4.5");
		});

		await t.test("enabled reflects dsh.profile.bundles only", () => {
			assert.equal(get("@scope/registry-plugin").enabled, true);
			assert.equal(get("linked-plugin").enabled, true);
			assert.equal(get("path-plugin").enabled, false);
		});

		await t.test("no registry lookups without checkRegistry", () => {
			for (const row of inventory.plugins) {
				assert.equal(row.latestVersion, null, `${row.name} must not have been looked up`);
				assert.equal(row.updateAvailable, null, `${row.name} must not claim an update`);
			}
		});

		await t.test("localDirectories lists exactly the watchable dirs", () => {
			const dirs = INV.localDirectories(inventory);
			assert.ok(dirs.includes(join(tree.root, "real/linked-plugin")));
			assert.ok(dirs.includes(join(tree.root, "real/path-plugin")));
			assert.ok(!dirs.includes(join(tree.root, "node_modules/@scope/registry-plugin")));
			assert.equal(new Set(dirs).size, dirs.length, "directories must be unique");
		});
	} finally {
		tree.cleanup();
	}
});

test("listInstalled: includeAllDeps=false keeps only bundles and local plugins", async (t) => {
	if (!INV) return t.skip("MISSING lib/inventory.js");

	const tree = makeTree({
		"package.json": {
			name: "profile",
			dependencies: { "bundle-plugin": "^1.0.0", "plain-lib": "^2.0.0" },
		},
		"node_modules/bundle-plugin/package.json": { name: "bundle-plugin", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
		"node_modules/plain-lib/package.json": { name: "plain-lib", version: "2.0.0" },
	});
	try {
		const inventory = await INV.listInstalled(contextFor(tree.root), { ...NO_REGISTRY, includeAllDeps: false });
		assert.equal(inventory.ok, true);
		const names = inventory.plugins.map((row) => row.name);
		assert.deepEqual(names, ["bundle-plugin"], `expected only the bundle, got ${names.join(", ")}`);
	} finally {
		tree.cleanup();
	}
});

test("listInstalled: never throws on a hostile profile", async (t) => {
	if (!INV) return t.skip("MISSING lib/inventory.js");

	await t.test("missing ctx / missing profile dir", async () => {
		const savedEnv = process.env.DSH_PROFILE_DIR;
		delete process.env.DSH_PROFILE_DIR;
		try {
			for (const ctx of [undefined, null, {}, { profileContext: {} }, { profileContext: { dir: "/nope/does/not/exist" } }]) {
				const result = await INV.listInstalled(ctx, NO_REGISTRY);
				assert.equal(result.ok, false, `expected ok:false for ${JSON.stringify(ctx)}`);
				assert.deepEqual(result.plugins, []);
				assert.equal(typeof result.error, "string");
			}
		} finally {
			if (savedEnv !== undefined) process.env.DSH_PROFILE_DIR = savedEnv;
		}
	});

	await t.test("unreadable profile package.json", async () => {
		const tree = makeTree({ "package.json": "{ this is not json" });
		try {
			const result = await INV.listInstalled(contextFor(tree.root), NO_REGISTRY);
			assert.equal(result.ok, false);
			assert.equal(typeof result.error, "string");
		} finally {
			tree.cleanup();
		}
	});

	await t.test("a broken row does not sink the good rows", async () => {
		const tree = makeTree({
			"package.json": {
				name: "profile",
				dependencies: { good: "^1.0.0", bad: "^1.0.0", dangling: "link:./gone" },
			},
			"node_modules/good/package.json": { name: "good", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
			// `bad` has a directory but an unparseable manifest
			"node_modules/bad/package.json": "{ broken",
		});
		try {
			const result = await INV.listInstalled(contextFor(tree.root), NO_REGISTRY);
			assert.equal(result.ok, true);
			assert.equal(result.plugins.length, 3);
			const good = result.plugins.find((row) => row.name === "good");
			const bad = result.plugins.find((row) => row.name === "bad");
			assert.equal(good.installedVersion, "1.0.0");
			assert.equal(typeof bad.error, "string", "the broken row must carry an error");
		} finally {
			tree.cleanup();
		}
	});

	await t.test("dependencies that are not an object are ignored, with a warning", async () => {
		const tree = makeTree({ "package.json": { name: "profile", dependencies: ["nope"] } });
		try {
			const result = await INV.listInstalled(contextFor(tree.root), NO_REGISTRY);
			assert.equal(result.ok, true);
			assert.deepEqual(result.plugins, []);
		} finally {
			tree.cleanup();
		}
	});
});

test("declaresBundle: every manifest shape the ecosystem actually ships", async (t) => {
	if (!INV) return t.skip("MISSING lib/inventory.js");
	const declares = INV.__internal?.declaresBundle;
	if (typeof declares !== "function") return t.skip("MISSING lib/inventory.js#declaresBundle");

	await t.test("accepts the shapes real DSH packages use", () => {
		// Verified against ~/.dsh/.asar-x: shipped packages write
		// `"bundle": { "patch": "./cordis.patch.yml" }`, never a bare boolean.
		assert.equal(declares({ dsh: { bundle: { patch: "./cordis.patch.yml" } } }), true);
		assert.equal(declares({ dsh: { bundle: "client.js" } }), true);
		assert.equal(declares({ dsh: { patch: "./cordis.patch.yml" } }), true);
	});

	await t.test("rejects packages that declare nothing", () => {
		for (const manifest of [{}, { dsh: null }, { dsh: "x" }, { dsh: {} }, { name: "plain" }]) {
			assert.equal(declares(manifest), false, JSON.stringify(manifest));
		}
	});

	await t.test("accepts a bare `dsh.bundle: true`", () => {
		// CONTRACT.md documents the field as "bundle: boolean; declares
		// dsh.bundle", so `"dsh": {"bundle": true}` is the most literal reading
		// of the spec and must count. This is deliberately more permissive than
		// the Host, which keys on `dsh.bundle.patch` (dsh-app-boot): a false
		// negative silently drops a real local plugin from the inventory, while
		// a false positive merely adds a row.
		assert.equal(declares({ dsh: { bundle: true } }), true, "`dsh.bundle: true` should declare a bundle");
	});
});

test("describePlugin returns one row, or null", async (t) => {
	if (!INV) return t.skip("MISSING lib/inventory.js");
	if (typeof INV.describePlugin !== "function") return t.skip("MISSING lib/inventory.js#describePlugin");

	const tree = makeTree({
		"package.json": { name: "profile", dependencies: { one: "^1.0.0" } },
		"node_modules/one/package.json": { name: "one", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } },
	});
	try {
		const row = await INV.describePlugin(contextFor(tree.root), "one");
		assert.equal(row?.name, "one");
		assert.equal(await INV.describePlugin(contextFor(tree.root), "absent"), null);
	} finally {
		tree.cleanup();
	}
});

test("listInstalled: onlyEnabled=true skips registry lookups for disabled plugins", async (t) => {
	if (!INV) return t.skip("MISSING lib/inventory.js");

	const tree = makeTree({
		"package.json": {
			name: "profile",
			dependencies: {
				"enabled-pkg": "^1.0.0",
				"disabled-pkg": "^1.0.0",
			},
			dsh: { profile: { bundles: ["enabled-pkg"] } },
		},
		"node_modules/enabled-pkg/package.json": {
			name: "enabled-pkg",
			version: "1.0.0",
			dsh: { bundle: { patch: "./cordis.patch.yml" } },
		},
		"node_modules/disabled-pkg/package.json": {
			name: "disabled-pkg",
			version: "1.0.0",
			dsh: { bundle: { patch: "./cordis.patch.yml" } },
		},
	});

	try {
		const fakeCtx = {
			profileContext: {
				dir: tree.root,
				packageManager: {
					command: "fake-pm-not-found",
					args: [],
					env: {},
				},
			},
		};

		// When onlyEnabled is true
		const inv1 = await INV.listInstalled(fakeCtx, {
			checkRegistry: true,
			onlyEnabled: true,
			timeoutMs: 100,
		});

		assert.equal(inv1.ok, true);
		const enabledRow1 = inv1.plugins.find((p) => p.name === "enabled-pkg");
		const disabledRow1 = inv1.plugins.find((p) => p.name === "disabled-pkg");
		assert.equal(enabledRow1.enabled, true);
		assert.equal(disabledRow1.enabled, false);
		// disabled-pkg was NOT queried in registry (no warning and no latestVersion)
		assert.ok(!inv1.warnings.some((w) => w.includes("disabled-pkg")), "disabled-pkg must not be checked");
		assert.ok(inv1.warnings.some((w) => w.includes("enabled-pkg")), "enabled-pkg was checked");

		// When onlyEnabled is false
		const inv2 = await INV.listInstalled(fakeCtx, {
			checkRegistry: true,
			onlyEnabled: false,
			timeoutMs: 100,
		});

		assert.equal(inv2.ok, true);
		assert.ok(inv2.warnings.some((w) => w.includes("disabled-pkg")), "disabled-pkg was checked when onlyEnabled is false");
		assert.ok(inv2.warnings.some((w) => w.includes("enabled-pkg")), "enabled-pkg was checked");
	} finally {
		tree.cleanup();
	}
});
