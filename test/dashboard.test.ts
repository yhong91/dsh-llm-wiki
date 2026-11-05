import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDashboardPayload, registerDashboardRoute, registerModelRoute } from "../lib/dsh/dashboard.js";

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

test("model route lists, sets, and clears the background task model", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-wiki-model-route-"));
  try {
    let spec: { path: string; fetch: (request: Request) => Promise<Response> } | undefined;
    const connection = {
      fetch: { register(value: typeof spec) { spec = value; return () => {}; } },
    };
    const child = {
      get(name: string) {
        if (name === "connection") return connection;
        if (name === "llm") {
          return {
            listProviders: () => [{ id: "prov-a", name: "Provider A" }],
            listModels: async () => [{ provider: "prov-a", id: "model-x", name: "Model X" }],
          };
        }
        return undefined;
      },
      effect(fn: () => () => void) { fn(); return () => {}; },
    };
    const ctx = {
      inject(_services: string[], callback: (value: unknown) => void) { callback(child); },
    };
    let refreshed = 0;
    registerModelRoute(ctx as never, {
      cwd: () => root,
      onModelChange: () => { refreshed += 1; },
    });
    assert.ok(spec);
    assert.equal(spec.path, "/api/llm-wiki/model");

    const post = async (body: Record<string, unknown>) => {
      const response = await spec!.fetch(new Request("http://localhost/api/llm-wiki/model", {
        method: "POST",
        body: JSON.stringify(body),
      }));
      return { status: response.status, payload: await response.json() as Record<string, unknown> };
    };

    // Initial state: no override, catalog from the llm service.
    const first = await post({ cwd: root });
    assert.equal(first.status, 200);
    const value = first.payload.value as { taskModel?: unknown; catalog: { provider: string; id: string }[] };
    assert.equal(value.taskModel, undefined);
    assert.deepEqual(value.catalog, [{ provider: "prov-a", id: "model-x", name: "Model X" }]);

    // Set persists to the project settings file and refreshes the runtime.
    const set = await post({ cwd: root, action: "set", model: "prov-a/model-x" });
    assert.equal(set.status, 200);
    assert.equal((set.payload.value as { taskModel: { provider: string; id: string } }).taskModel.id, "model-x");
    assert.equal(refreshed, 1);
    const raw = JSON.parse(
      (await readFile(join(root, ".dsh", "settings.json"), "utf-8")) as string,
    ) as Record<string, unknown>;
    assert.ok(raw["llm-wiki"], "settings written under the llm-wiki key");

    // Invalid refs are rejected without writing.
    const bad = await post({ cwd: root, action: "set", model: "nope" });
    assert.equal(bad.status, 400);
    assert.equal(refreshed, 1);

    // Clear reverts to the session model.
    const cleared = await post({ cwd: root, action: "clear" });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.payload.value as { taskModel?: unknown }).taskModel, undefined);
    assert.equal(refreshed, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
