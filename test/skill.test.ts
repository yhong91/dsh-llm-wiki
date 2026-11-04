import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSkill } from "../lib/dsh/skill.js";

test("registerSkill exposes the packaged llm-wiki skill through an optional skills service", async () => {
  let requested: string[] | undefined;
  let provider: {
    name: string;
    list(): Promise<readonly Record<string, unknown>[]>;
    get(candidate: unknown): Promise<Record<string, unknown> | undefined>;
  } | undefined;

  const ctx = {
    inject(services: string[], callback: (child: unknown) => void) {
      requested = services;
      callback({
        skills: {
          registerProvider(create: () => typeof provider) {
            provider = create();
            return () => true;
          },
        },
      });
      return () => true;
    },
  };

  registerSkill(ctx as never);
  assert.deepEqual(requested, ["skills"]);
  assert.ok(provider, "provider registered");
  assert.equal(provider.name, "llm-wiki");

  const candidates = await provider.list();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, "llm-wiki");
  assert.equal(candidates[0].source, "bundled");
  assert.equal(candidates[0].rank, 600);
  assert.match(String(candidates[0].description), /persistent, interlinked/);

  const definition = await provider.get(candidates[0]);
  assert.ok(definition);
  assert.match(String(definition.content), /# LLM Wiki for dsh/);
  assert.equal((definition.resourceBase as { kind: string }).kind, "directory");
  assert.match(String((definition.resourceBase as { path: string }).path), /skills\/llm-wiki\/?$/);
});
