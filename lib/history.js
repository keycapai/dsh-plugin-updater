import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HISTORY_FILE_NAME = ".plugin-updater-history.json";
const MAX_HISTORY_ENTRIES = 50;

/**
 * Resolve the history file path for a profile directory.
 * @param {string|null} profileDir
 * @returns {string|null}
 */
export function historyFilePath(profileDir) {
  if (typeof profileDir !== "string" || profileDir.trim() === "") return null;
  return join(profileDir, HISTORY_FILE_NAME);
}

/**
 * Read the update history list for a profile.
 * @param {string|null} profileDir
 * @returns {Array<{target:string,fromVersion?:string|null,toVersion?:string|null,status:"success"|"failed",error?:string,timestamp:number,trigger:"manual"|"auto"}>}
 */
export function readUpdateHistory(profileDir) {
  const file = historyFilePath(profileDir);
  if (!file || !existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Append one update record to the history file.
 * @param {string|null} profileDir
 * @param {{target:string,fromVersion?:string|null,toVersion?:string|null,status:"success"|"failed",error?:string,timestamp?:number,trigger?:"manual"|"auto"}} entry
 */
export function recordUpdateHistory(profileDir, entry) {
  const file = historyFilePath(profileDir);
  if (!file) return;
  try {
    const history = readUpdateHistory(profileDir);
    const item = {
      target: entry.target,
      fromVersion: entry.fromVersion ?? null,
      toVersion: entry.toVersion ?? null,
      status: entry.status,
      error: entry.error,
      timestamp: entry.timestamp ?? Date.now(),
      trigger: entry.trigger ?? "manual",
    };
    history.unshift(item);
    if (history.length > MAX_HISTORY_ENTRIES) {
      history.length = MAX_HISTORY_ENTRIES;
    }
    writeFileSync(file, JSON.stringify(history, null, 2), "utf8");
  } catch {
    /* ignore write failures defensively */
  }
}
