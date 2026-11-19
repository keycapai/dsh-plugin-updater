/**
 * Package-manager and registry helpers for the updater.
 *
 * Two jobs:
 *   1. Find a usable package manager (`readPackageManager`) — preferably the one
 *      the running Host already uses (`ctx.profileContext.packageManager`).
 *   2. Ask the registry what versions exist (`viewPackage`, `viewVersions`) by
 *      running `<pm> view <name> … --json` in the profile directory.
 *
 * No dependencies: `node:child_process`, `node:fs`, `node:path`, `node:url` only.
 * Nothing here throws to the caller; failures come back as `{ok:false,error}`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The pnpm entry point shipped inside the desktop app bundle (verified on this machine). */
const BUNDLED_PNPM = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs";

/** Registries asked when nothing is configured, mirror first (fast from CN, same content). */
const DEFAULT_REGISTRIES = ["https://registry.npmmirror.com/", "https://registry.npmjs.org/"];

/** Default wall-clock budget for one `pnpm view`. Metadata lookups are usually < 1.5 s. */
const DEFAULT_TIMEOUT_MS = 20000;

/** Cap the captured output so a pathological manifest cannot eat memory. */
const MAX_OUTPUT = 4 * 1024 * 1024;

function errorText(error) {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Normalize a registry URL into the form pnpm compares registries in:
 * lower-case host, explicit path, and a trailing slash.
 * Never throws. Non-http(s) input returns `""`, so a stray value can never be
 * handed to pnpm as a `--registry` argument.
 * @param {unknown} url
 * @returns {string} `""` when `url` is not an http(s) URL
 */
export function normalizeRegistry(url) {
  if (typeof url !== "string" || url.trim() === "") return "";
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
    return parsed.href;
  } catch {
    return "";
  }
}

/** Read JSON with a size guard; null on any failure. */
function readJson(path) {
  try {
    const text = readFileSync(path, "utf8");
    if (text.length > MAX_OUTPUT) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The node executable that can run a `.mjs` script: plain Node, or Electron in Node mode. */
function nodeForPnpm() {
  const execPath = process.execPath;
  const env = {};
  // Electron's own binary (the desktop host) needs ELECTRON_RUN_AS_NODE to behave as node.
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = "1";
  return { command: execPath, args: [], env };
}

/**
 * Locate the bundled pnpm entry point by walking outwards from this module's own
 * location. The packaged layout is
 *   /Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/
 *     dependencies/pnpm/bin/pnpm.mjs
 * so from any depth we look for `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`
 * and for a sibling `dependencies/pnpm/bin/pnpm.mjs` of an ancestor named `primary-runtime`.
 */
function findBundledPnpm() {
  if (isFile(BUNDLED_PNPM)) return BUNDLED_PNPM;
  const suffixes = [
    join("runtime", "primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs"),
    join("primary-runtime", "dependencies", "pnpm", "bin", "pnpm.mjs"),
    join("dependencies", "pnpm", "bin", "pnpm.mjs"),
  ];
  let here;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  const starts = [here, dirname(process.execPath), process.cwd()];
  for (const start of starts) {
    let dir = resolve(start);
    for (let depth = 0; depth < 14; depth += 1) {
      for (const suffix of suffixes) {
        const candidate = join(dir, suffix);
        if (isFile(candidate)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** A `packageManager` object from the Host, sanity-checked. */
function acceptPackageManager(candidate) {
  if (candidate === null || typeof candidate !== "object") return null;
  if (typeof candidate.command !== "string" || candidate.command.trim() === "") return null;
  const args = Array.isArray(candidate.args) ? candidate.args.filter((a) => typeof a === "string") : [];
  const env = candidate.env !== null && typeof candidate.env === "object" && !Array.isArray(candidate.env)
    ? Object.fromEntries(Object.entries(candidate.env).filter(([, v]) => typeof v === "string"))
    : {};
  return { command: candidate.command, args, env };
}

/** Build the recorded descriptor for a vetted pnpm binary, or null. */
function describePnpm(script) {
  if (typeof script !== "string" || script === "") return null;
  if (!isFile(script)) return null;
  const base = nodeForPnpm();
  return { command: base.command, args: [script], env: base.env, kind: "bundled-pnpm" };
}

/**
 * Discover how to run the package manager.
 * Order: `ctx.profileContext.packageManager` (the Host's own, always correct) ->
 * known bundled pnpm paths -> `pnpm` on PATH (with `kind` telling which one won).
 * @param {object} ctx Host context; a fake `{profileContext:{dir}}` also works.
 * @returns {Promise<{command:string,args:string[],env:object,kind?:string}|null>}
 */
export async function readPackageManager(ctx) {
  try {
    const profile = ctx !== null && typeof ctx === "object"
      ? (ctx.profileContext ?? ctx.get?.("profileContext"))
      : undefined;
    const fromHost = acceptPackageManager(profile?.packageManager);
    if (fromHost !== null) return { ...fromHost, kind: "host" };

    // Recorded on the context by an earlier probe, if a previous call put one there.
    const remembered = acceptPackageManager(ctx?.packageManager);
    if (remembered !== null) return { ...remembered, kind: "context" };

    const bundled = describePnpm(findBundledPnpm());
    if (bundled !== null) return bundled;

    // A pnpm next to the running runtime, e.g. <runtime>/bin/pnpm.cjs.
    try {
      const execDir = dirname(process.execPath);
      for (const guess of [join(execDir, "pnpm.cjs"), join(execDir, "..", "dependencies", "pnpm", "bin", "pnpm.mjs")]) {
        const found = describePnpm(guess);
        if (found !== null) return found;
      }
    } catch {
      /* ignore */
    }

    if (isFile(BUNDLED_PNPM)) return { command: process.execPath, args: [BUNDLED_PNPM], env: nodeForPnpm().env };
    return null;
  } catch {
    return null;
  }
}

/** Resolve `distTagsName`/`options.name` into a package name; never returns an empty string. */
function nameOf(options, distTagsName) {
  if (typeof distTagsName === "string" && distTagsName.trim() !== "") return distTagsName.trim();
  if (typeof options?.name === "string" && options.name.trim() !== "") return options.name.trim();
  return "";
}

/** Reject names that could be read as pnpm flags or paths. */
function isPlainName(name) {
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name);
}

/**
 * Run one command and capture its output.
 * @returns {Promise<{ok:boolean,code:number|null,stdout:string,stderr:string,error?:string,timedOut?:boolean,aborted?:boolean}>}
 */
function run(command, args, options) {
  return new Promise((resolveRun) => {
    const timeoutMs = Number.isFinite(options?.timeoutMs) ? Math.max(1000, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const signal = options?.signal;
    if (signal?.aborted === true) {
      resolveRun({ ok: false, code: null, stdout: "", stderr: "", error: "aborted", aborted: true });
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolveRun({ ok: false, code: null, stdout: "", stderr: "", error: errorText(error) });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort !== null) signal.removeEventListener("abort", onAbort);
      resolveRun(result);
    };
    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    let onAbort = null;
    if (signal !== undefined && signal !== null && typeof signal.addEventListener === "function") {
      onAbort = () => {
        aborted = true;
        kill();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= MAX_OUTPUT) out.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (outBytes + chunk.length <= MAX_OUTPUT) {
        outBytes += chunk.length;
        err.push(chunk);
      }
    });
    child.on("error", (error) => {
      finish({ ok: false, code: null, stdout: String(Buffer.concat(out)), stderr: String(Buffer.concat(err)), error: errorText(error) });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) {
        finish({ ok: false, code, stdout, stderr, error: `timed out after ${timeoutMs}ms`, timedOut: true });
        return;
      }
      if (aborted) {
        finish({ ok: false, code, stdout, stderr, error: "aborted", aborted: true });
        return;
      }
      if (code === 0) {
        finish({ ok: true, code, stdout, stderr });
        return;
      }
      const detail = describeFailure(stderr, stdout);
      finish({ ok: false, code, stdout, stderr, error: detail === "" ? `exited with code ${code}` : detail });
    });
  });
}

/** The one useful sentence out of a failed run: pnpm code, the JSON message, else the first real line. */
function describeFailure(stderr, stdout) {
  const text = `${stderr}\n${stdout}`;
  const code = /ERR_PNPM_[A-Z0-9_]+/.exec(text);
  const httpStatus = /The requested URL returned error: (\d+)/.exec(text);
  const bare = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (code !== null) return `${code[0]}${httpStatus === null ? "" : ` (${httpStatus[1]})`}`;
  if (bare !== null) {
    try {
      return JSON.parse(`"${bare[1]}"`);
    } catch {
      return bare[1];
    }
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^[[\]{},]"?$/.test(line) && !/^"?(error|code|detail)"?:/i.test(line));
  const status = /The requested URL returned error: (\d+)/.exec(lines.join(" "));
  if (status !== null) return `registry returned HTTP ${status[1]}`;
  return lines.slice(0, 2).join(" · ");
}

/** Parse `pnpm view <name> --json`: one object, or (for multi-selector views) an array. */
function parseViewJson(stdout) {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    // pnpm sometimes prefixes a warnings block; recover from the first JSON bracket.
    const first = text.search(/[[{]/);
    if (first < 0) return null;
    try {
      return JSON.parse(text.slice(first));
    } catch {
      return null;
    }
  }
}

/** Fully prepared invocation: pm descriptor, profile dir, env, args. */
async function prepare(options) {
  const pm = acceptPackageManager(options?.packageManager) ?? (await readPackageManager(options?.ctx));
  if (pm === null) return { ok: false, error: "no package manager found (pnpm not located)" };
  const profileDir = typeof options?.profileDir === "string" && options.profileDir !== "" ? resolve(options.profileDir) : process.cwd();
  const cwd = existsSync(profileDir) ? profileDir : process.cwd();
  const env = { ...process.env, ...pm.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  // Only override the registry when one was asked for; otherwise pnpm's own config wins.
  const asked = typeof options?.registry === "string" ? options.registry.trim() : "";
  if (asked !== "") {
    const registry = normalizeRegistry(asked);
    if (registry === "") return { ok: false, error: `not an http(s) registry: ${asked}` };
    return { ok: true, pm, profileDir, cwd, env, registry, args: [...pm.args] };
  }
  return { ok: true, pm, profileDir, cwd, env, registry: null, args: [...pm.args] };
}

/**
 * Ask the registry for one package.
 *
 * Runs `<pm> view <name> version dist-tags versions --json`.
 *
 * @param {string} distTagsName package name (also accepted as `options.name`)
 * @param {object} [options]
 * @param {string} [options.name] package name when `distTagsName` is not given
 * @param {string} [options.profileDir] cwd for the run (the profile directory)
 * @param {object} [options.packageManager] `{command,args,env}`; discovered when absent
 * @param {string} [options.registry] registry to ask (default: pnpm's own configuration)
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok:true,version:string|null,versions:string[],distTags:Record<string,string>,registry:string|null,raw?:object}|{ok:false,error:string,code?:number|null,timedOut?:boolean}>}
 */
export async function viewPackage(distTagsName, options) {
  try {
    const name = nameOf(options, distTagsName);
    if (name === "") return { ok: false, error: "viewPackage: no package name" };
    if (!isPlainName(name)) return { ok: false, error: `viewPackage: not a plain package name: ${name}` };
    const ready = await prepare(options);
    if (!ready.ok) return ready;

    const args = [...ready.args, "view", name, "version", "dist-tags", "versions", "--json"];
    if (ready.registry !== null) args.push("--registry", ready.registry);
    const result = await run(ready.pm.command, args, {
      cwd: ready.cwd,
      env: ready.env,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "pnpm view failed",
        code: result.code ?? null,
        ...(result.timedOut === true ? { timedOut: true } : {}),
      };
    }
    const parsed = parseViewJson(result.stdout);
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, error: "pnpm view returned no JSON" };
    }
    // `version` is a string, or an object (when pnpm was given several selectors).
    const version = typeof parsed.version === "string" ? parsed.version : null;
    const versions = Array.isArray(parsed.versions) ? parsed.versions.filter((v) => typeof v === "string") : [];
    const distTags = parsed["dist-tags"] !== null && typeof parsed["dist-tags"] === "object" && !Array.isArray(parsed["dist-tags"])
      ? Object.fromEntries(Object.entries(parsed["dist-tags"]).filter(([, v]) => typeof v === "string"))
      : {};
    const best = version ?? distTags.latest ?? (versions.length > 0 ? versions[versions.length - 1] : null);
    return { ok: true, name, version: best, versions, distTags, registry: ready.registry, raw: parsed };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

/**
 * Ask the registry for the version list and dist-tags of one package.
 * @param {object} options Same fields as {@link viewPackage}; `name` is required.
 * @returns {Promise<{ok:true,versions:string[],distTags:Record<string,string>,latest:string|null}|{ok:false,versions:[],distTags:{},error:string}>}
 */
export async function viewVersions(options) {
  try {
    const name = nameOf(options, options?.name);
    if (name === "") return { ok: false, versions: [], distTags: {}, error: "viewVersions: no package name" };
    const result = await viewPackage(name, options);
    if (!result.ok) return { ok: false, versions: [], distTags: {}, error: result.error };
    return {
      ok: true,
      versions: result.versions,
      distTags: result.distTags,
      latest: result.distTags.latest ?? result.version ?? null,
    };
  } catch (error) {
    return { ok: false, versions: [], distTags: {}, error: errorText(error) };
  }
}

/**
 * The registries to ask, in order (synchronous form).
 *
 * Prefers what the plugin manager reports, then `config.registries`, then the
 * built-in public pair. The real manager's `registries()` is async, so its value
 * is only used when it happens to be already-resolved; use {@link resolveRegistries}
 * for the authoritative ordering.
 *
 * @param {object} ctx Host context (`{get(name)}`) or a fake object.
 * @param {object} [config] optional `{registries: string[]|string}`
 * @returns {string[]} normalized URLs, never empty
 */
export function defaultRegistries(ctx, config) {
  const collected = [];
  const push = (url) => {
    const normalized = normalizeRegistry(url);
    if (normalized !== "" && !collected.includes(normalized)) collected.push(normalized);
  };
  const configured = config?.registries;
  if (Array.isArray(configured)) for (const url of configured) push(url);
  else if (typeof configured === "string") push(configured);

  try {
    const manager = typeof ctx?.get === "function" ? ctx.get("pluginManager") : ctx?.pluginManager;
    if (manager !== null && manager !== undefined && typeof manager.registries === "function") {
      const reported = manager.registries();
      if (reported !== null && typeof reported === "object" && typeof reported.then !== "function") {
        const urls = [reported.registry, ...(Array.isArray(reported.fallbackRegistries) ? reported.fallbackRegistries : [])]
          .filter((url) => typeof url === "string" && url !== "");
        for (const url of urls) push(url);
      }
    }
  } catch {
    /* a broken manager must not cost us the defaults */
  }
  for (const fallback of DEFAULT_REGISTRIES) push(fallback);
  return collected;
}

/**
 * Async variant of {@link defaultRegistries} that awaits the manager's promise.
 * Use this when you need the Host's real ordering; it never rejects.
 * @param {object} ctx
 * @param {object} [config]
 * @returns {Promise<{registries:string[],fromManager:boolean,managerError?:string}>}
 */
export async function resolveRegistries(ctx, config) {
  const collected = [];
  const push = (url) => {
    const normalized = normalizeRegistry(url);
    if (normalized !== "" && !collected.includes(normalized)) collected.push(normalized);
  };
  const configured = config?.registries;
  if (Array.isArray(configured)) for (const url of configured) push(url);
  else if (typeof configured === "string") push(configured);

  let fromManager = false;
  let managerError;
  try {
    const manager = typeof ctx?.get === "function" ? ctx.get("pluginManager") : ctx?.pluginManager;
    if (manager !== null && manager !== undefined && typeof manager.registries === "function") {
      const reported = await manager.registries();
      if (reported !== null && typeof reported === "object") {
        const urls = [reported.registry, ...(Array.isArray(reported.fallbackRegistries) ? reported.fallbackRegistries : [])]
          .filter((url) => typeof url === "string" && url !== "");
        for (const url of urls) push(url);
        fromManager = urls.length > 0;
      }
    }
  } catch (error) {
    managerError = errorText(error);
  }
  for (const fallback of DEFAULT_REGISTRIES) push(fallback);
  return { registries: collected, fromManager, ...(managerError === undefined ? {} : { managerError }) };
}

/** For diagnostics: where the package manager came from and whether it can run. */
export async function probePackageManager(ctx, options) {
  const pm = await readPackageManager(ctx);
  if (pm === null) return { ok: false, error: "no package manager found" };
  const result = await run(pm.command, [...pm.args, "--version"], {
    cwd: options?.profileDir,
    env: { ...process.env, ...pm.env, NO_COLOR: "1", CI: "1" },
    timeoutMs: options?.timeoutMs ?? 10000,
  });
  return {
    ok: result.ok,
    kind: pm.kind ?? (pm.args.some((a) => a.endsWith("pnpm.mjs")) ? "node-pnpm" : "command"),
    command: pm.command,
    args: pm.args,
    version: result.ok ? result.stdout.trim().split("\n").pop() ?? "" : null,
    ...(result.ok ? {} : { error: result.error }),
  };
}

export const __internal = { BUNDLED_PNPM, DEFAULT_REGISTRIES, findBundledPnpm, isPlainName };
