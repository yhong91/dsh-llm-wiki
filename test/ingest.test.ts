import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LLM_WIKI_HOST ??= "dsh";

const { startIngestSynthesis } = await import("../lib/dsh/ingest.js");
const { getVaultPaths } = await import("../lib/engine/utils.js");

const tmp = mkdtempSync(join(tmpdir(), "dsh-wiki-ingest-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function makeVault(root: string): ReturnType<typeof getVaultPaths> {
  const paths = getVaultPaths(root);
  mkdirSync(paths.meta, { recursive: true });
  mkdirSync(paths.wiki, { recursive: true });
  mkdirSync(paths.rawSources, { recursive: true });
  writeFileSync(
    join(paths.dotWiki, "config.json"),
    JSON.stringify({
      vault_id: "00000000-0000-0000-0000-000000000000",
      knowledge_format: "okf-0.2",
      mode: "personal",
      topic: "test",
      created: "2026-01-01",
      version: "1.0",
    }),
  );
  writeFileSync(
    join(paths.wiki, "index.md"),
    '---\nokf_version: "0.2"\ntitle: idx\ntype: source\ncreated: 2026-01-01\nupdated: 2026-01-01\nslug: index\n---\n# idx\n',
  );
  writeFileSync(
    join(paths.meta, "registry.json"),
    JSON.stringify({ version: "1.0", last_updated: "", pages: {} }),
  );
  const sourceId = "SRC-2026-01-01-001";
  const packet = join(paths.rawSources, sourceId);
  mkdirSync(packet, { recursive: true });
  writeFileSync(
    join(packet, "manifest.json"),
    JSON.stringify({ title: "Test source", format: "text", captured: "2026-01-01" }),
  );
  writeFileSync(join(packet, "extracted.md"), "The source says alpha is a concept.");
  return paths;
}

test("startIngestSynthesis starts a DSH child, commits structured data, and tracks a job", async () => {
  const root = join(tmp, "vault");
  const paths = makeVault(root);
  let capturedSpec: Record<string, unknown> | undefined;
  let capturedJob: Record<string, unknown> | undefined;
  let disposed = 0;

  const subagents = {
    list: () => ["spawn", "fork"],
    startActivation: async (spec: Record<string, unknown>) => {
      capturedSpec = spec;
      return {
        result: Promise.resolve({
          stopReason: "completed",
          structured: {
            summary: "Alpha is a concept in the test source.",
            key_takeaways: ["Alpha matters."],
            entities: [],
            concepts: [{ title: "Alpha", definition: "A test concept." }],
          },
        }),
        dispose: async () => {
          disposed += 1;
        },
      };
    },
  };

  const jobs = {
    start(spec: Record<string, unknown>) {
      capturedJob = spec;
      const run = spec.run as (job: unknown) => { done: Promise<unknown> };
      const handle = { append: () => {}, updateProgress: () => {} };
      const hooks = run(handle);
      void hooks.done;
      return "llm-wiki-ingest-1";
    },
  };

  const result = await startIngestSynthesis(
    {
      config: {
        taskModel: { provider: "magpie", id: "group/test" },
        synthesisMaxTokens: 2048,
        synthesisLanguage: "en",
        wikilinkValidation: "warn",
      },
      subagents: subagents as never,
      jobs: jobs as never,
      cwd: () => root,
    },
    {
      paths,
      sourceId: "SRC-2026-01-01-001",
      manifest: { title: "Test source", format: "text", captured: "2026-01-01" },
      extracted: "The source says alpha is a concept.",
      parent: { id: "session-1", inject: () => {} },
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.provider, "spawn");
  assert.equal(result.jobId, "llm-wiki-ingest-1");
  assert.ok(capturedSpec, "activation spec captured");
  const request = capturedSpec.request as Record<string, unknown>;
  assert.equal((request.agentOptions as Record<string, unknown>).provider, "magpie");
  assert.equal((request.agentOptions as Record<string, unknown>).model, "group/test");
  assert.ok(request.outputSchema, "structured output schema passed");
  assert.ok(capturedJob, "job spec captured");

  const run = capturedJob.run as (job: unknown) => { done: Promise<{ status: string }> };
  const done = await run({ append: () => {}, updateProgress: () => {} }).done;
  assert.equal(done.status, "completed");
  assert.equal(disposed, 1);

  const page = readFileSync(join(paths.wiki, "sources", "SRC-2026-01-01-001.md"), "utf8");
  assert.match(page, /status: ingested/);
  assert.ok(readFileSync(join(paths.wiki, "concepts", "alpha.md"), "utf8").includes("Alpha"));
});

test("startIngestSynthesis falls back cleanly without a subagent service", async () => {
  const result = await startIngestSynthesis(
    {
      config: {},
      cwd: () => tmp,
    },
    {
      paths: getVaultPaths(join(tmp, "missing")),
      sourceId: "SRC-2026-01-01-002",
      manifest: {},
      extracted: "content",
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /subagents service unavailable/);
});
