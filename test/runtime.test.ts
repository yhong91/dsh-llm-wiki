import assert from "node:assert/strict";
import { test } from "node:test";

const { DshRuntime } = await import("../lib/dsh/runtime.js");

test("ensureConfig replaces config instead of leaking keys across cwd changes", () => {
  const config: Record<string, unknown> = { notices: false, autoRecall: true };
  const runtime = new DshRuntime({
    config: config as never,
    report: () => {},
    cwd: () => "/tmp",
    reload: () => ({ autoRecall: false }),
  });

  runtime.ensureConfig("/tmp/next");
  assert.equal(config.autoRecall, false);
  assert.equal(Object.hasOwn(config, "notices"), false, "old project key cleared");
});

test("launchTask reports indexing work through an optional job registry", async () => {
  let spec: Record<string, unknown> | undefined;
  const jobs = {
    start(value: Record<string, unknown>) {
      spec = value;
      const run = value.run as (job: unknown) => { done: Promise<{ status: string }> };
      void run({ updateProgress: () => {} }).done;
      return "llm-wiki-index-1";
    },
  };
  const runtime = new DshRuntime({
    config: {} as never,
    report: () => {},
    cwd: () => "/tmp",
    jobs: jobs as never,
  });
  await runtime.launchTask(
    { hasUI: false, agent: { id: "session-1" } } as never,
    "index:test",
    async () => {},
  );
  assert.ok(spec, "job spec captured");
  assert.equal(spec.kind, "llm-wiki-index");
  assert.equal(spec.label, "index:test");
  assert.equal(spec.owner, "session-1");
});
