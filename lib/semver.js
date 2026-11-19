/**
 * Dependency-free semver: parse, compare, range test.
 *
 * Only `node:` builtins are used (in fact none at all). Every exported function
 * is total: `satisfiesVersion` / `isNewer` / `versionDistance` never throw, they
 * return a "no" answer (`false` / `'unknown'`) for input they cannot parse.
 * `compareVersions` is the one deliberate exception documented by the contract:
 * it throws `TypeError` when either side is unparseable, because "compare these
 * two things I could not read" has no honest answer to return.
 *
 * Supported range syntax (the subset npm ranges need for "is there a newer version"):
 *   - exact              1.2.3
 *   - operators          =  >  >=  <  <=        1.2.3, >=1.2.3, >= 1.2.3
 *   - caret / tilde      ^1.2.3  ^0.2.3  ^0.0.3  ~1.2.3  ~1.2  ~1
 *   - x-ranges           *  x  X  1.x  1.2.x  1.*  1.2.*  ""  (empty = any)
 *   - hyphen ranges      1.2.3 - 2.3.4
 *   - tags               latest  next  beta            (as a whole range, per contract)
 *   - OR                 a || b
 *   - AND                a b  /  a, b
 *   - prerelease tags    1.2.3-beta.1, 1.2.3-rc.2+build.7
 *   - partial versions   1  /  1.2  (treated as x-ranges inside a range, as pinned inside compare)
 */

const NUM = "0|[1-9]\\d*";
const IDENT = "[0-9A-Za-z-]+";

/** A tolerant version grammar: leading `v`/`=` and surrounding space allowed. */
const VERSION_RE = new RegExp(`^[\\s=v]*(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+(${IDENT}(?:\\.${IDENT})*))?[\\s]*$`);
/** A partial version: any of the three numeric parts may be missing (or be x/*). */
const PARTIAL_RE = /^[\s=v]*([0-9]+|x|X|\*)?(?:\.([0-9]+|x|X|\*))?(?:\.([0-9]+|x|X|\*))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?[\s]*$/;

/** Whole-range tags that mean "whatever the registry calls newest". */
const TAGS = new Set(["latest", "next", "beta", "alpha", "rc", "canary", "stable", "current", "newest"]);

/** Compare two prerelease identifier lists per semver §11. */
function comparePrerelease(a, b) {
  // No prerelease outranks any prerelease.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareParsed(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Parse a complete semantic version.
 * @param {unknown} text
 * @returns {{major:number,minor:number,patch:number,prerelease:string[],build:string[],raw:string}|null}
 *   `null` when `text` is not a full `major.minor.patch[-pre][+build]` version.
 */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const raw = text;
  const m = VERSION_RE.exec(text);
  if (m === null) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return {
    major,
    minor,
    patch,
    prerelease: m[4] === undefined ? [] : m[4].split("."),
    build: m[5] === undefined ? [] : m[5].split("."),
    raw,
  };
}

/**
 * Parse a version, or a partial version completed with zeros (`1.2` -> 1.2.0).
 *
 * Blank text is deliberately NOT a version: "no version written" must never be read
 * as 0.0.0, or every `undefined`-ish value would silently compare as the oldest release.
 * At least the major component has to be present as a number.
 */
function lenient(text) {
  const exact = parseVersion(text);
  if (exact !== null) return exact;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const m = PARTIAL_RE.exec(trimmed);
  if (m === null) return null;
  // `PARTIAL_RE` lets every component be absent; require a real numeric major.
  const majS = m[1];
  if (majS === undefined || majS === "" || majS === "x" || majS === "X" || majS === "*") return null;
  const num = (v) => (v === undefined || v === "" ? 0 : Number(v));
  const major = Number(majS);
  const minor = num(m[2]);
  const patch = num(m[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: m[4] === undefined ? [] : m[4].split("."), build: [], raw: text };
}

/**
 * Compare two versions by semver precedence.
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 * @throws {TypeError} when either side is not parseable.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a) ?? lenient(a);
  const pb = parseVersion(b) ?? lenient(b);
  if (pa === null) throw new TypeError(`compareVersions: not a version: ${String(a)}`);
  if (pb === null) throw new TypeError(`compareVersions: not a version: ${String(b)}`);
  return compareParsed(pa, pb);
}


/** Comparison node: {op, version} where op is one of >, >=, <, <=, =. */
function testNode(node, candidate) {
  const d = compareParsed(candidate, node.version);
  switch (node.op) {
    case ">": return d > 0;
    case ">=": return d >= 0;
    case "<": return d < 0;
    case "<=": return d <= 0;
    case "=": return d === 0;
    default: return false;
  }
}

/**
 * Compile one range token (no spaces, no `||`) into comparator nodes.
 * Leading operator text is handled by the caller; here `token` is already split.
 */
function parseComparatorToken(op, token) {
  if (token === "" || token === "*" || token === "x" || token === "X") {
    // "any version" -> the always-true low bound.
    return [{ op: ">=", version: { major: 0, minor: 0, patch: 0, prerelease: [] } }];
  }
  const m = PARTIAL_RE.exec(token);
  if (m === null) return null;
  const part = (v) => (v === undefined || v === "" ? null : v);
  const isWild = (v) => v !== null && (v === "x" || v === "X" || v === "*");
  let [majS, minS, patS] = [part(m[1]), part(m[2]), part(m[3])];
  const pre = m[4] === undefined ? [] : m[4].split(".");

  const majorWild = majS === null || isWild(majS);
  const minorWild = majorWild || minS === null || isWild(minS);
  const patchWild = minorWild || patS === null || isWild(patS);

  if (majorWild) {
    if (op === "<" || op === ">") return [{ op: ">=", version: { major: 0, minor: 0, patch: 0, prerelease: [] } }];
    return [{ op: ">=", version: { major: 0, minor: 0, patch: 0, prerelease: [] } }];
  }
  const major = Number(majS);
  const minor = minorWild ? 0 : Number(minS);
  const patch = patchWild ? 0 : Number(patS);
  const version = { major, minor, patch, prerelease: patchWild ? [] : pre };

  // Wildcards with an operator: npm treats `^1.x` / `~2.x` as the range itself
  // and `>=1.x` as `>=1.0.0`; a wildcard bound cannot express an exclusion, so
  // the most useful reading is the inclusive floor.
  switch (op) {
    case "":
    case "=": {
      if (patchWild) {
        if (minorWild) return [{ op: ">=", version }, { op: "<", version: { major: major + 1, minor: 0, patch: 0, prerelease: [] } }];
        return [{ op: ">=", version }, { op: "<", version: { major, minor: minor + 1, patch: 0, prerelease: [] } }];
      }
      return [{ op: "=", version }];
    }
    case ">":
      if (minorWild) return [{ op: ">=", version: { major: major + 1, minor: 0, patch: 0, prerelease: [] } }];
      if (patchWild) return [{ op: ">=", version: { major, minor: minor + 1, patch: 0, prerelease: [] } }];
      return [{ op: ">", version }];
    case ">=":
      return [{ op: ">=", version }];
    case "<":
      return [{ op: "<", version }];
    case "<=":
      if (minorWild) return [{ op: "<", version: { major: major + 1, minor: 0, patch: 0, prerelease: [] } }];
      if (patchWild) return [{ op: "<", version: { major, minor: minor + 1, patch: 0, prerelease: [] } }];
      return [{ op: "<=", version }];
    case "^": {
      // npm caret: bump the leftmost non-zero part; wildcards bump the part
      // before them (`^1.x` -> <2.0.0, `^0.x` -> <1.0.0, `^0.0.x` -> <0.1.0).
      const lower = { major, minor, patch, prerelease: version.prerelease };
      if (minorWild) return [{ op: ">=", version: lower }, { op: "<", version: { major: major + 1, minor: 0, patch: 0, prerelease: [] } }];
      if (patchWild) {
        const upper = major === 0
          ? { major: 0, minor: minor + 1, patch: 0, prerelease: [] }
          : { major: major + 1, minor: 0, patch: 0, prerelease: [] };
        return [{ op: ">=", version: lower }, { op: "<", version: upper }];
      }
      let upper;
      if (major !== 0) upper = { major: major + 1, minor: 0, patch: 0, prerelease: [] };
      else if (minor !== 0) upper = { major: 0, minor: minor + 1, patch: 0, prerelease: [] };
      else upper = { major: 0, minor: 0, patch: patch + 1, prerelease: [] };
      return [{ op: ">=", version: lower }, { op: "<", version: upper }];
    }
    case "~": {
      const upper = minorWild
        ? { major: major + 1, minor: 0, patch: 0, prerelease: [] }
        : { major, minor: minor + 1, patch: 0, prerelease: [] };
      return [{ op: ">=", version: { major, minor, patch, prerelease: version.prerelease } }, { op: "<", version: upper }];
    }
    default:
      return null;
  }
}

/** Split an OR-set into AND tokens, honouring the `a - b` hyphen range. */
function splitAnd(group) {
  const spaced = group.trim().replace(/\s+/g, " ");
  if (spaced === "") return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(spaced);
  if (hyphen !== null) return [{ op: ">=", token: hyphen[1] }, { op: "<=", token: hyphen[2] }];
  const tokens = [];
  // `>=1.2.3 <2.0.0` and `>= 1.2.3` (operator detached from its version) both appear.
  const words = spaced.split(" ").filter((w) => w !== "");
  for (const word of words) {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*(.*)$/.exec(word);
    if (m === null) return null;
    tokens.push({ op: m[1] ?? "", token: m[2] });
  }
  // Merge `< 2.0.0` (operator detached from its version) into `<2.0.0`.
  const merged = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.token === "" && i + 1 < tokens.length && tokens[i + 1].op === "") {
      merged.push({ op: t.op, token: tokens[i + 1].token });
      i += 1;
    } else {
      merged.push(t);
    }
  }
  return merged;
}

/**
 * Whether `range` admits at least one version (i.e. it is not an impossible intersection).
 * Used only to reject garbage ranges instead of silently failing open.
 */
function rangeCompiles(range) {
  for (const group of String(range).split("||")) {
    const tokens = splitAnd(group);
    if (tokens === null) return false;
  }
  return true;
}

/**
 * Does `version` satisfy `range`?
 * @param {string} version
 * @param {string} range A semver range; `latest`/`next`/`*` mean "any version".
 * @returns {boolean} false for anything unparseable; never throws.
 */
export function satisfiesVersion(version, range) {
  try {
    if (typeof range !== "string") return false;
    const candidate = parseVersion(version) ?? lenient(version);
    if (candidate === null) return false;
    const trimmed = range.trim();
    // An empty range is not "any version": nothing was asked for, so nothing qualifies.
    if (trimmed === "") return false;
    // A bare dist-tag ("latest", "next", "beta") accepts whatever the registry
    // resolved to; we are comparing concrete versions, so it accepts everything.
    if (TAGS.has(trimmed.toLowerCase())) return true;

    for (const group of trimmed.split("||")) {
      const tokens = splitAnd(group);
      if (tokens === null) continue;
      let ok = true;
      const nodes = [];
      for (const t of tokens) {
        const compiled = parseComparatorToken(t.op ?? "", t.token ?? "");
        if (compiled === null) {
          ok = false;
          break;
        }
        nodes.push(...compiled);
      }
      if (!ok) continue;
      for (const node of nodes) {
        if (!testNode(node, candidate)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // npm's prerelease rule: a range only admits a prerelease when one of its
      // comparators names a prerelease with the same [major, minor, patch].
      if (candidate.prerelease.length > 0) {
        const allowed = nodes.some((node) => node.version.prerelease !== undefined && node.version.prerelease.length > 0 && node.version.major === candidate.major && node.version.minor === candidate.minor && node.version.patch === candidate.patch);
        if (!allowed) continue;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Is `candidate` a strictly newer version than `current`?
 * @param {string|null|undefined} candidate
 * @param {string|null|undefined} current
 * @returns {boolean} false if either side is missing/unparseable; never throws.
 */
export function isNewer(candidate, current) {
  try {
    const a = parseVersion(candidate) ?? lenient(candidate);
    const b = parseVersion(current) ?? lenient(current);
    if (a === null || b === null) return false;
    return compareParsed(a, b) > 0;
  } catch {
    return false;
  }
}

/**
 * How big is the step from `current` to `next`?
 * @param {string} current
 * @param {string} next
 * @returns {'major'|'minor'|'patch'|'prerelease'|'same'|'unknown'}
 */
export function versionDistance(current, next) {
  try {
    const a = parseVersion(current) ?? lenient(current);
    const b = parseVersion(next) ?? lenient(next);
    if (a === null || b === null) return "unknown";
    const d = compareParsed(b, a);
    if (d === 0) return "same";
    if (a.major !== b.major) return "major";
    if (a.minor !== b.minor) return "minor";
    if (a.patch !== b.patch) return "patch";
    // Same numeric core, different prerelease (or a downgrade inside one).
    return "prerelease";
  } catch {
    return "unknown";
  }
}

/** Internal: whether the range string is syntactically usable. Exported for tests/registry. */
export function isUsableRange(range) {
  if (typeof range !== "string") return false;
  const trimmed = range.trim();
  if (trimmed === "") return false;
  if (TAGS.has(trimmed.toLowerCase())) return true;
  return rangeCompiles(trimmed);
}
