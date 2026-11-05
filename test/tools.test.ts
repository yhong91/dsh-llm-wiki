import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
process.env.LLM_WIKI_HOST ??= "dsh";

const { buildWikiToolDefinitions } = await import("../lib/dsh/tools.js");
const { validateArgs } = await import("@deepseek-ai/dsh-tools");
const { DshRuntime } = await import("../lib/dsh/runtime.js");
const { createExecApi } = await import("../lib/dsh/exec.js");
const { loadTaskConfig } = await import("../lib/engine/task-config.js");
const { bootstrapVault } = await import("../lib/engine/bootstrap.js");
const { rebuildMetadata } = await import("../lib/engine/metadata.js");
const { readCalls } = await import("../lib/engine/call-log.js");
const { getVaultPaths } = await import("../lib/engine/utils.js");

// A self-contained fixture vault: the suite must pass on any machine (CI
// included) and never depend on, or touch, a real ~/.llm-wiki.
const FIXTURE_PAGES = 12;
const root = mkdtempSync(join(tmpdir(), "dsh-tools-test-"));
const fixturePaths = getVaultPaths(root);
assert.equal(bootstrapVault(fixturePaths, { topic: "fixture", mode: "personal" }).ok, true);
for (let i = 0; i < FIXTURE_PAGES; i += 1) {
  writeFileSync(
    join(fixturePaths.wiki, "sources", `chaoxing-note-${i}.md`),
    [
      "---",
      "type: source",
      `title: "超星题库笔记 ${i}"`,
      "status: insight",
      "created: 2026-01-01",
      "updated: 2026-01-01",
      `slug: chaoxing-note-${i}`,
      "---",
      "",
      `# 超星题库笔记 ${i}`,
      "",
      "超星题库分页参数是 pageNum。",
      "",
    ].join("\n"),
    "utf-8",
  );
}
rebuildMetadata(fixturePaths);

const EXPECTED_TOOLS = [
  "wiki_bootstrap",
  "wiki_capture_source",
  "wiki_ingest",
  "wiki_ensure_page",
  "wiki_search",
  "wiki_lint",
  "wiki_status",
  "wiki_rebuild_meta",
  "wiki_reindex",
  "wiki_reindex_embeddings",
  "wiki_log_event",
  "wiki_watch",
  "wiki_recall",
  "wiki_retro",
  "wiki_observe",
];

function makeDeps() {
  const cwd = () => root;
  const config = loadTaskConfig(cwd());
  const runtime = new DshRuntime({ config, report: () => {}, cwd });
  return {
    cwd,
    config,
    runtime,
    execApi: createExecApi(undefined),
    report: () => {},
  };
}

const deps = makeDeps();
const tools = buildWikiToolDefinitions(deps);
const byName = new Map(tools.map((t) => [t.name, t]));

const registryStat = () => {
  const path = join(fixturePaths.meta, "registry.json");
  const s = statSync(path);
  return { mtimeMs: s.mtimeMs, size: s.size };
};

const beforeRegistry = registryStat();

test("exactly the 15 expected tools are defined, no duplicates", () => {
  assert.equal(tools.length, EXPECTED_TOOLS.length);
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...EXPECTED_TOOLS].sort(),
  );
  assert.equal(new Set(tools.map((t) => t.name)).size, EXPECTED_TOOLS.length);
});

test("every definition declares the full tool contract", () => {
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string", "name");
    assert.equal(typeof tool.description, "string", `${tool.name} description`);
    assert.ok(tool.description.length > 20, `${tool.name} description is substantive`);
    assert.ok(tool.parameters && typeof tool.parameters === "object", `${tool.name} parameters`);
    assert.ok(tool.output, `${tool.name} output`);
    assert.ok(tool.output.schema, `${tool.name} output.schema`);
    assert.equal(typeof tool.output.render, "function", `${tool.name} output.render`);
    assert.equal(typeof tool.execute, "function", `${tool.name} execute`);
  }
});

test("wiki_status returns the fixture vault counts read-only", async () => {
  const tool = byName.get("wiki_status");
  assert.ok(tool);
  const value = (await tool.execute(
    {},
    { signal: new AbortController().signal },
  )) as Record<string, unknown>;
  assert.equal(value.ok, true);
  assert.equal(value.knowledgeFormat, "okf-0.2");
  assert.ok((value.totalPages as number) >= FIXTURE_PAGES, `totalPages ${value.totalPages}`);
  assert.ok((value.byType as Record<string, number>).source >= FIXTURE_PAGES);
});

test("wiki_recall returns hits for 超星", async () => {
  const tool = byName.get("wiki_recall");
  assert.ok(tool);
  const value = (await tool.execute(
    { query: "超星" },
    { signal: new AbortController().signal },
  )) as Record<string, unknown>;
  assert.equal(value.ok, true);
  assert.ok((value.count as number) > 0, "recall returned hits");
  const matches = value.matches as Array<{ id: string; title: string }>;
  assert.ok(matches.length > 0);
});

test("read tools log their calls to meta/calls.jsonl", async () => {
  const search = byName.get("wiki_search");
  const recall = byName.get("wiki_recall");
  assert.ok(search && recall);
  await search.execute({ query: "超星" }, { signal: new AbortController().signal });
  await recall.execute({ query: "分页" }, { signal: new AbortController().signal });
  const calls = readCalls(fixturePaths, 10);
  assert.equal(calls.length >= 2, true);
  assert.equal(calls[0].tool, "recall", "newest first");
  assert.equal(calls[1].tool, "search");
  assert.ok(calls[1].hits >= 1, "search logged its hit count");
  assert.ok(calls[1].query.includes("超星"));
});

test("validateArgs rejects a wiki_recall call missing query", () => {
  const tool = byName.get("wiki_recall");
  assert.ok(tool);
  // tool.parameters is the compiled ParameterJsonSchema; fold it back into the
  // author-facing spec (property nodes + per-key required flags) that
  // validateArgs consumes.
  const compiled = tool.parameters as {
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const required = new Set(compiled.required ?? []);
  const spec = Object.fromEntries(
    Object.entries(compiled.properties).map(([key, node]) => [
      key,
      required.has(key) ? { ...node, required: true as const } : node,
    ]),
  );
  const violations = validateArgs(spec, {});
  assert.ok(violations.length > 0, "missing required query is rejected");
});

test("the test run wrote nothing to the vault", () => {
  const afterRegistry = registryStat();
  assert.equal(afterRegistry.mtimeMs, beforeRegistry.mtimeMs, "registry mtime unchanged");
  assert.equal(afterRegistry.size, beforeRegistry.size, "registry size unchanged");
});

test("fixture vault is cleaned up", () => {
  rmSync(root, { recursive: true, force: true });
});
