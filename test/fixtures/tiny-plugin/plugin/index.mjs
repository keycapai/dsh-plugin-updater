/**
 * The plugin entry a loader entry imports.
 *
 * It deliberately knows nothing about being reloaded: it is an ordinary Cordis
 * plugin that reads its behaviour from a SIBLING module, which is what the test
 * rewrites to prove the reload invalidates a whole subtree.
 *
 * Two different things are published so a reload can be proved from both sides:
 *
 *  - `__tinyHotPlugins[name]` is the CURRENT instance. A reload replaces it, so
 *    it only ever describes the newest code.
 *  - `__tinyHotPluginDisposals` is a process-level counter of cleanups that have
 *    actually run. It lives outside the plugin object precisely because a
 *    per-instance counter would be reset by the very reload under test — and
 *    "the old instance's ctx.effect cleanup really ran" can only be observed
 *    from somewhere the old instance does not own.
 */
import { LABEL, greet } from "./behaviour.mjs";

export const name = "tiny-hot-plugin";

export function apply(ctx, config) {
	const record = {
		label: LABEL,
		greet,
		config,
		pid: process.pid,
		appliedAt: Date.now(),
	};
	// One well-known slot per process, so the test can read the RUNNING plugin
	// without holding a reference that a reload would invalidate.
	const board = (globalThis.__tinyHotPlugins ??= {});
	board["tiny-hot-plugin"] = record;
	ctx.effect(() => () => {
		globalThis.__tinyHotPluginDisposals = (globalThis.__tinyHotPluginDisposals ?? 0) + 1;
	});
}
