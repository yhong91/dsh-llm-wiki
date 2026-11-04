import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { bootstrapVault } from "../lib/engine/bootstrap.js";
import { commitSynthesis } from "../lib/engine/ingest-worker.js";
import { saveObservation } from "../lib/engine/observation.js";
import { captureText } from "../lib/engine/source-packet.js";
import { getVaultPaths } from "../lib/engine/utils.js";

test("observation writes keep distinct Unicode slugs and valid frontmatter", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-wiki-write-format-"));
  try {
    const paths = getVaultPaths(root);
    assert.equal(bootstrapVault(paths, { topic: "audit", mode: "personal" }).ok, true);

    const first = saveObservation(paths, {
      title: "中文观察标题",
      content: "第一条内容。",
      relevance: "medium",
      tags: "audit 测试",
    });
    const second = saveObservation(paths, {
      title: "另一个中文观察",
      content: "第二条内容。",
      relevance: "high",
    });

    assert.notEqual(first.pagePath, second.pagePath, "two Chinese titles must not overwrite each other");
    assert.ok(!basename(first.pagePath).endsWith("-.md"), "slug must not be empty");
    const firstPage = await readFile(first.pagePath, "utf8");
    assert.match(firstPage, /^---\ntype: source\ntitle: "Observation: 中文观察标题"/m);
    assert.match(firstPage, /^slug: obs-\d{4}-\d{2}-\d{2}-中文观察标题$/m);

    const sameTitle = saveObservation(paths, {
      title: "中文观察标题",
      content: "同一标题的第二个条目。",
      relevance: "medium",
    });
    assert.notEqual(sameTitle.pagePath, first.pagePath, "same title must not overwrite an existing observation");
    assert.match(basename(sameTitle.pagePath), /-2\.md$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture and ingest produce the expected source packet/page format", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-wiki-write-ingest-"));
  try {
    const paths = getVaultPaths(root);
    assert.equal(bootstrapVault(paths, { topic: "audit", mode: "personal" }).ok, true);
    const captured = captureText(paths, "分页参数是 pageNum。", "测试来源");
    const skeleton = await readFile(captured.sourcePagePath, "utf8");
    assert.match(skeleton, /^type: source$/m);
    assert.match(skeleton, /^status: skeleton$/m);
    assert.match(skeleton, /^## Summary$/m);
    assert.match(skeleton, /\[LLM: /);

    const manifest = JSON.parse(await readFile(join(captured.packetPath, "manifest.json"), "utf8"));
    const committed = commitSynthesis(paths, captured.sourceId, manifest, {
      summary: "来源摘要。",
      key_takeaways: ["要点一"],
      entities: [{ title: "CPA", description: "一个工具" }],
      concepts: [{ title: "分页", definition: "一种参数机制" }],
      quotes: [],
      contradictions: [],
    });
    assert.equal(committed.ok, true);
    const ingested = await readFile(captured.sourcePagePath, "utf8");
    assert.match(ingested, /^status: ingested$/m);
    assert.match(ingested, /^## Summary$/m);
    assert.match(ingested, /\[CPA\]\(\/entities\/cpa.md\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
