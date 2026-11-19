#!/bin/bash
#
# dsh-plugin-updater test entry point.
#
#   ./test/run.sh              # everything, human summary
#
# Two details are load-bearing:
#
#   --expose-internals      lib/reload.js evicts module cache entries from
#                           Node's INTERNAL ESM loader. Without the flag it
#                           correctly reports "unsupported", which would make
#                           the reload tests pass vacuously.
#
#   --test-isolation=none   `node --test` otherwise runs every test file in a
#                           WORKER process, and worker processes do NOT inherit
#                           `--expose-internals`. The reload proof would skip
#                           itself and the suite would look green while proving
#                           nothing.
#
# NODE_OPTIONS cannot carry the flag here (this environment strips it), which is
# why both flags are passed explicitly on the command line.
#
# Every test file is run exactly ONCE, in one Node process. Do not "re-run a
# file to get its counts": a second concurrent pass over the same temp
# directories makes the watch tests observe edits owned by the other pass.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

NODE="${NODE:-node}"
if ! command -v "$NODE" >/dev/null 2>&1; then
	echo "FATAL: no node on PATH" >&2
	exit 1
fi

TEST_FILES=(
	test/semver.test.mjs
	test/inventory.test.mjs
	test/watch.test.mjs
	test/reload.test.mjs
)

# --test-isolation=none landed in Node 24; on 20 and 22 it is an unknown option
# and node exits before running a single test. Probe for it instead of assuming,
# and let the run continue without it on older Node: the reload proof then
# reports itself unsupported (the preflight says so out loud) while the other
# suites still run for real.
NODE_MAJOR="$("$NODE" -p "process.versions.node.split('.')[0]")"
TEST_FLAGS=(--expose-internals --test --test-reporter=spec)
if [[ "${NODE_MAJOR:-0}" -ge 24 ]]; then
	TEST_FLAGS+=(--test-isolation=none)
fi

echo "════════════════════════════════════════════════════════════════"
echo " dsh-plugin-updater test suite"
echo " node             : $("$NODE" --version)"
echo " cwd              : $(pwd)"
echo " flags            : ${TEST_FLAGS[*]}"
echo "════════════════════════════════════════════════════════════════"
echo

# Which lib modules are on disk? This distinguishes "not built yet" from
# "built and broken", which are very different things to report.
echo "── lib modules ─────────────────────────────────────────────────"
for module in semver registry inventory reload watch index; do
	if [[ -f "lib/$module.js" ]]; then
		printf '   present  lib/%s.js\n' "$module"
	else
		printf '   MISSING  lib/%s.js\n' "$module"
	fi
done
echo

echo "── test files ──────────────────────────────────────────────────"
for file in "${TEST_FILES[@]}"; do
	if [[ -f "$file" ]]; then
		printf '   %s\n' "$file"
	else
		printf '   MISSING  %s\n' "$file"
	fi
done
echo

echo "── preflight ───────────────────────────────────────────────────"
"$NODE" --expose-internals --input-type=module -e '
import { internalLoader } from "./test/harness.mjs";
const internal = await internalLoader();
if (!internal) {
	console.log("   internal ESM loader : UNAVAILABLE");
	console.log("   The reload proof CANNOT run. Re-run with --expose-internals.");
	process.exit(1);
}
const shape = typeof internal.getOrCreateModuleJob === "function" ? "v2"
	: typeof internal.getModuleJobForImport === "function" ? "v1" : "unknown";
console.log(`   internal ESM loader : ${shape}`);
console.log(`   loadCache shape     : ${internal.loadCache?.constructor?.name} (instanceof Map = ${internal.loadCache instanceof Map})`);
' || echo "   (preflight failed — reload tests will report unsupported)"
echo

# A bare `-t NAME` is a BSD extension; GNU mktemp insists on a template with
# XXXXXX. An explicit template works on both.
OUTPUT="$(mktemp -t dsh-plugin-updater-tests.XXXXXX)"
trap 'rm -f "$OUTPUT"' EXIT

# ── the run ────────────────────────────────────────────────────────────────
"$NODE" "${TEST_FLAGS[@]}" "${TEST_FILES[@]}" 2>&1 | tee "$OUTPUT"
STATUS=${PIPESTATUS[0]}

# ── summary ────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════"
echo " SUMMARY"
echo "════════════════════════════════════════════════════════════════"

TOTALS="$(grep -E "^ℹ (tests|pass|fail|skipped|todo|cancelled) " "$OUTPUT" | tail -20)"
if [[ -z "$TOTALS" ]]; then
	# A reporter that summarises differently; count the marks instead.
	PASSED=$(grep -cE "^✔|^  ✔" "$OUTPUT")
	FAILED=$(grep -cE "^✖|^  ✖" "$OUTPUT")
	SKIPPED=$(grep -cE "^﹣" "$OUTPUT")
	TOTALS="ℹ pass ${PASSED:-0}
ℹ fail ${FAILED:-0}
ℹ skipped ${SKIPPED:-0}"
fi
echo "$TOTALS" | sed 's/^ℹ/  /'
echo

# Anything skipped because a contract module is not on disk yet.
MISSING="$(grep -oE "MISSING lib/[A-Za-z]+\.js" "$OUTPUT" | sed 's/MISSING /  /' | sort -u)"
if [[ -n "$MISSING" ]]; then
	echo "── not on disk yet (those tests skipped) ───────────────────────"
	echo "$MISSING"
	echo
fi

# Named failures, so a red run is actionable without scrolling.
if grep -qE "^(✖|  ✖)" "$OUTPUT"; then
	echo "── failures ────────────────────────────────────────────────────"
	grep -E "^(✖|  ✖)" "$OUTPUT" | grep -v "failing tests:" | sed 's/^/  /' | sort -u | head -40
	echo
fi

echo "════════════════════════════════════════════════════════════════"
if [[ $STATUS -eq 0 ]]; then
	echo " RESULT: PASS"
	echo "════════════════════════════════════════════════════════════════"
	exit 0
fi

echo " RESULT: FAIL (node --test exit $STATUS)"
echo "════════════════════════════════════════════════════════════════"
exit "$STATUS"
