import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDashboardPayload, registerDashboardRoute } from "../lib/dsh/dashboard.js";

test("dashboard payload surfaces recent pages and activity without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-wiki-dashboard-"));
  try {
    await mkdir(join(root, ".llm-wiki", "wiki", "concepts"), { recursive: true });
    await mkdir(join(root, ".llm-wiki", "meta"), { recursive: true });
    await mkdir(join(root, ".llm-wiki", "raw", "sources"), { recursive: true });
    await writeFile(join(root, ".llm-wiki", "wiki", "concepts", "alpha.md"), "# Alpha\n\nA durable idea.\n");
    await writeFile(
      join(root, ".llm-wiki", "meta", "registry.json"),
      JSON.stringify({
        pages: {
          "concepts/alpha": {
            type: "concept",
            title: "Alpha",
            created: "2026-01-01",
            updated: "2026-01-02",
          },
        },
      }),
    );
    await writeFile(
      join(root, ".llm-wiki", "meta", "events.jsonl"),
      `${JSON.stringify({ kind: "observe", title: "First", timestamp: "2026-01-02T00:00:00Z" })}\n`,
    );

    const payload = await collectDashboardPayload(root);
    assert.equal(payload.stats.pageCount, 1);
    assert.equal(payload.stats.byType.concept, 1);
    assert.equal(payload.recentPages[0]?.title, "Alpha");
    assert.equal(payload.recentPages[0]?.excerpt, "A durable idea.");
    assert.equal(payload.recentEvents[0]?.kind, "observe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard route is a read-only POST endpoint returning the payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-wiki-dashboard-route-"));
  try {
    await mkdir(join(root, ".llm-wiki", "wiki"), { recursive: true });
    await mkdir(join(root, ".llm-wiki", "meta"), { recursive: true });
    await mkdir(join(root, ".llm-wiki", "raw", "sources"), { recursive: true });
    await writeFile(join(root, ".llm-wiki", "wiki", "index.md"), "# pending\n");

    let spec: { path: string; fetch: (request: Request) => Promise<Response> } | undefined;
    const connection = {
      fetch: { register(value: typeof spec) { spec = value; return () => {}; } },
    };
    const child = {
      get(name: string) { return name === "connection" ? connection : undefined; },
      effect(fn: () => () => void) { fn(); return () => {}; },
    };
    const ctx = {
      inject(_services: string[], callback: (value: unknown) => void) { callback(child); },
    };

    registerDashboardRoute(ctx as never);
    assert.ok(spec);
    assert.equal(spec.path, "/api/llm-wiki/dashboard");
    const response = await spec.fetch(new Request("http://localhost/api/llm-wiki/dashboard", {
      method: "POST",
      body: JSON.stringify({ cwd: root }),
    }));
    const payload = await response.json() as { ok: boolean; value: { stats: { root: string } } };
    assert.equal(payload.ok, true);
    assert.equal(payload.value.stats.root, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
