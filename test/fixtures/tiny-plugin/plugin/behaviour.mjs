/** Behaviour v1 — the test rewrites this file to change what the plugin does. */
export const LABEL = "v1";

export const ARRIVAL = 1;

export function greet(name) {
	return [LABEL + ":" + name];
}
