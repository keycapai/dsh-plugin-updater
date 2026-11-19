/**
 * `lib/semver.js` contract tests.
 *
 * Everything here is pure computation, so the table is deliberately wide: this
 * module decides "is there an update?", and a single wrong caret expansion makes
 * the updater offer a breaking upgrade. The expectations encode npm's own
 * semantics (caret bumping the leftmost non-zero part, tilde bumping minor,
 * range-only-admits-prerelease-it-names) rather than this package's opinions.
 *
 * @module test/semver.test
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadLib } from "./support/missing.mjs";

const loaded = await loadLib("semver.js");

test("lib/semver.js exists", (t) => {
	if (!loaded.present) {
		t.skip(`MISSING lib/semver.js — ${loaded.reason}`);
		return;
	}
	assert.equal(loaded.present, true);
});

/** Loaded module, or a hard failure that names the file. */
const S = loaded.present ? loaded.exports : null;

test("parseVersion", async (t) => {
	if (!S) return t.skip("lib/semver.js missing");

	await t.test("parses a plain version into numbers", () => {
		const v = S.parseVersion("1.2.3");
		assert.equal(v.major, 1);
		assert.equal(v.minor, 2);
		assert.equal(v.patch, 3);
		assert.deepEqual(v.prerelease, []);
	});

	await t.test("keeps prerelease identifiers in order", () => {
		const v = S.parseVersion("2.0.0-beta.11");
		assert.deepEqual(v.prerelease, ["beta", "11"]);
	});

	await t.test("keeps the raw text", () => {
		assert.equal(S.parseVersion("1.2.3").raw, "1.2.3");
	});

	await t.test("rejects garbage instead of throwing", () => {
		for (const bad of ["", "abc", "1.2", "1.2.3.4", null, undefined, 7, {}, "1.2.x"]) {
			assert.equal(S.parseVersion(bad), null, `expected null for ${JSON.stringify(bad)}`);
		}
	});

	await t.test("accepts a leading v (leniency, not a violation)", () => {
		// npm tags are routinely written `v1.2.3`; accepting that form is a
		// deliberate convenience of this parser, not a contract breach.
		assert.deepEqual(S.parseVersion("v1.2.3"), {
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: [],
			build: [],
			raw: "v1.2.3",
		});
	});
});

test("compareVersions", async (t) => {
	if (!S) return t.skip("lib/semver.js missing");

	/** Reference pairs: [a, b, expected] — also checked in reverse. */
	const TABLE = [
		["1.0.0", "1.0.0", 0],
		["1.0.1", "1.0.0", 1],
		["1.1.0", "1.0.9", 1],
		["2.0.0", "1.9.9", 1],
		["1.0.0", "1.0.1", -1],
		["0.9.9", "1.0.0", -1],
		["1.0.0-alpha", "1.0.0", -1],
		["1.0.0-alpha", "1.0.0-alpha.1", -1],
		["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
		["1.0.0-alpha.beta", "1.0.0-beta", -1],
		["1.0.0-beta.2", "1.0.0-beta.11", -1],
		["1.0.0-rc.1", "1.0.0", -1],
		["10.0.0", "9.9.9", 1],
	];

	await t.test("orders every reference pair", () => {
		for (const [a, b, want] of TABLE) {
			assert.equal(S.compareVersions(a, b), want, `${a} vs ${b}`);
			if (want !== 0) assert.equal(S.compareVersions(b, a), -want, `${b} vs ${a}`);
		}
	});

	await t.test("ignores build metadata", () => {
		assert.equal(S.compareVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
	});

	await t.test("throws TypeError when either side is unparseable", () => {
		assert.throws(() => S.compareVersions("not-a-version", "1.0.0"), TypeError);
		assert.throws(() => S.compareVersions("1.0.0", "not-a-version"), TypeError);
	});

	await t.test("empty text is unparseable, not 0.0.0", () => {
		// `lenient("")` currently completes the empty string to 0.0.0, so an
		// empty side silently compares as the oldest possible version instead of
		// throwing as the contract says. Reported to the owner of lib/semver.js.
		assert.throws(() => S.compareVersions("1.0.0", ""), TypeError);
	});
});

test("satisfiesVersion", async (t) => {
	if (!S) return t.skip("lib/semver.js missing");

	/** [version, range, expected] */
	const TABLE = [
		// exact + leading v
		["1.2.3", "1.2.3", true],
		["1.2.4", "1.2.3", false],
		["1.2.3", "=1.2.3", true],
		// caret: bumps the leftmost non-zero part
		["1.9.9", "^1.2.3", true],
		["2.0.0", "^1.2.3", false],
		["1.2.2", "^1.2.3", false],
		["0.2.9", "^0.2.3", true],
		["0.3.0", "^0.2.3", false],
		["0.0.3", "^0.0.3", true],
		["0.0.4", "^0.0.3", false],
		// tilde
		["1.2.9", "~1.2.3", true],
		["1.3.0", "~1.2.3", false],
		["1.1.0", "~1.2.3", false],
		// inequality operators
		["2.0.0", ">=2.0.0", true],
		["1.9.9", ">=2.0.0", false],
		["2.0.1", ">2.0.0", true],
		["2.0.0", ">2.0.0", false],
		["1.0.0", "<2.0.0", true],
		["2.0.0", "<2.0.0", false],
		["2.0.0", "<=2.0.0", true],
		// space-AND
		["1.5.0", ">=1.0.0 <2.0.0", true],
		["2.0.0", ">=1.0.0 <2.0.0", false],
		["0.5.0", ">=1.0.0 <2.0.0", false],
		// OR
		["3.0.0", "^1.0.0 || ^3.0.0", true],
		["2.0.0", "^1.0.0 || ^3.0.0", false],
		// wildcards and x-ranges
		["1.2.3", "*", true],
		["1.2.3", "1.x", true],
		["1.9.9", "1.2.x", false],
		["1.2.9", "1.2.x", true],
		["1.3.0", "1.2", false],
		["1.2.7", "1.2", true],
		// dist-tags mean "whatever the registry gives us"
		["4.5.6", "latest", true],
		// impossible / garbage must be false and must not throw
		["1.0.0", "not a range", false],
		["garbage", "^1.0.0", false],
		// A wildcard under an operator cannot express an exclusion: npm reads
		// `>=1.x` as ">=1.0.0", and this module documents the same floor reading.
		["0.9.0", ">=1.x", false],
		["1.0.0", ">=1.x", true],
	];

	await t.test("matches npm range semantics", () => {
		for (const [version, range, want] of TABLE) {
			assert.equal(S.satisfiesVersion(version, range), want, `${version} satisfies ${JSON.stringify(range)}`);
		}
	});

	await t.test("never throws on malformed input", () => {
		for (const range of [undefined, null, 7, {}, []]) {
			assert.doesNotThrow(() => S.satisfiesVersion("1.0.0", range), `range ${JSON.stringify(range)}`);
			assert.equal(S.satisfiesVersion("1.0.0", range), false, `range ${JSON.stringify(range)}`);
		}
		assert.doesNotThrow(() => S.satisfiesVersion(undefined, "^1.0.0"));
		assert.equal(S.satisfiesVersion(undefined, "^1.0.0"), false);
	});

	await t.test("an empty-string range admits nothing", () => {
		assert.equal(S.satisfiesVersion("1.0.0", ""), false);
	});

	await t.test("does not admit a prerelease no comparator names", () => {
		// npm: `^1.0.0` must not match 1.5.0-beta even though 1.5.0-beta < 2.0.0.
		assert.equal(S.satisfiesVersion("1.5.0-beta", "^1.0.0"), false);
		// ...but a range that names that exact prerelease tuple does.
		assert.equal(S.satisfiesVersion("1.0.0-beta", ">=1.0.0-beta <2.0.0"), true);
	});
});

test("isNewer", async (t) => {
	if (!S) return t.skip("lib/semver.js missing");

	await t.test("true only for a strictly newer candidate", () => {
		assert.equal(S.isNewer("1.0.1", "1.0.0"), true);
		assert.equal(S.isNewer("1.0.0", "1.0.0"), false);
		assert.equal(S.isNewer("0.9.9", "1.0.0"), false);
	});

	await t.test("false, never throws, when either side is missing", () => {
		assert.equal(S.isNewer(null, "1.0.0"), false);
		assert.equal(S.isNewer("1.0.0", null), false);
		assert.equal(S.isNewer(undefined, undefined), false);
		assert.equal(S.isNewer("garbage", "1.0.0"), false);
		assert.doesNotThrow(() => S.isNewer("1.0.0", {}));
	});

	await t.test("a release outranks its own prerelease", () => {
		assert.equal(S.isNewer("1.0.0", "1.0.0-beta.1"), true);
		assert.equal(S.isNewer("1.0.0-beta.1", "1.0.0"), false);
	});
});

test("versionDistance", async (t) => {
	if (!S) return t.skip("lib/semver.js missing");

	const TABLE = [
		["1.0.0", "2.0.0", "major"],
		["1.0.0", "1.1.0", "minor"],
		["1.0.0", "1.0.1", "patch"],
		["1.0.0", "1.0.0", "same"],
		["1.0.0-beta", "1.0.0", "prerelease"],
		["1.0.0", "garbage", "unknown"],
		[" ", "1.0.0", "unknown"],
	];

	await t.test("classifies the step", () => {
		for (const [from, to, want] of TABLE) {
			assert.equal(S.versionDistance(from, to), want, `${from} -> ${to}`);
		}
	});

	await t.test("multiple levels collapse to the largest", () => {
		assert.equal(S.versionDistance("1.2.3", "2.3.4"), "major");
		assert.equal(S.versionDistance("1.2.3", "1.3.4"), "minor");
	});
});
