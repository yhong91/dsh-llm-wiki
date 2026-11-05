import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
process.env.LLM_WIKI_HOST ??= "dsh";

const { appendCall, readCalls } = await import("../lib/engine/call-log.js");
const { getVaultPaths } = await import("../lib/engine/utils.js");

test("appendCall writes entries newest-last; readCalls returns newest-first", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-wiki-call-log-"));
  try {
    const paths = getVaultPaths(root);
    assert.deepEqual(readCalls(paths), []);

    appendCall(paths, { tool: "search", query: "alpha", hits: 2, ms: 5 });
    appendCall(paths, { tool: "auto-recall", query: "beta", hits: 0, ms: 9 });

    const calls = readCalls(paths);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].query, "beta", "newest first");
    assert.equal(calls[0].tool, "auto-recall");
    assert.ok(calls[0].timestamp, "timestamp stamped");
    assert.equal(calls[1].query, "alpha");

    // limit is honored
    assert.equal(readCalls(paths, 1).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendCall never throws and caps long queries", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-wiki-call-log-cap-"));
  try {
    const paths = getVaultPaths(root);
    // A read-only meta directory must not break the caller's search.
    const long = "x".repeat(500);
    appendCall(paths, { tool: "recall", query: long.slice(0, 200), hits: 1, ms: 1 });
    assert.ok(existsSync(join(paths.meta, "calls.jsonl")));
    const line = JSON.parse(readFileSync(join(paths.meta, "calls.jsonl"), "utf-8"));
    assert.ok(line.query.length <= 200);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
