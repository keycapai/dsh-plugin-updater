import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateHistory, recordUpdateHistory } from "../lib/history.js";

test("history: record and read update history", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-history-test-"));
  try {
    assert.deepEqual(readUpdateHistory(dir), []);

    recordUpdateHistory(dir, {
      target: "dsh-context",
      fromVersion: "0.68.0",
      toVersion: "0.74.0",
      status: "success",
      trigger: "manual",
    });

    const list = readUpdateHistory(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].target, "dsh-context");
    assert.equal(list[0].fromVersion, "0.68.0");
    assert.equal(list[0].toVersion, "0.74.0");
    assert.equal(list[0].status, "success");

    recordUpdateHistory(dir, {
      target: "billion-context",
      status: "failed",
      error: "policy violation",
    });

    const list2 = readUpdateHistory(dir);
    assert.equal(list2.length, 2);
    assert.equal(list2[0].target, "billion-context");
    assert.equal(list2[0].status, "failed");
    assert.equal(list2[1].target, "dsh-context");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
