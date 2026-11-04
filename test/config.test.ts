import assert from "node:assert/strict";
import { test } from "node:test";

const plugin = await import("../lib/index.js");
const { Config, mergeTaskConfig } = await import("../lib/dsh/config.js");

test("the plugin entry exports a callable Config schema", () => {
  assert.equal(typeof plugin.Config, "function");
  const config = plugin.Config({}) as Record<string, unknown>;
  assert.equal(config.notices, true);
  assert.equal(config.autoRecall, true);
});

test("mergeTaskConfig keeps compat settings unless the row explicitly sets them", () => {
  const defaults = Config({}) as Parameters<typeof mergeTaskConfig>[0];
  const compat = {
    notices: false,
    autoRecall: false,
    ambientPersonalVault: false,
    semanticWeight: 0.2,
  };

  const untouched = mergeTaskConfig(defaults, compat, {});
  assert.equal(untouched.notices, false);
  assert.equal(untouched.autoRecall, false);
  assert.equal(untouched.ambientPersonalVault, false);
  assert.equal(untouched.semanticWeight, 0.2);

  const explicit = mergeTaskConfig(
    Config({ notices: true, semanticWeight: 0.8 }) as Parameters<typeof mergeTaskConfig>[0],
    compat,
    { notices: true, semanticWeight: 0.8 },
  );
  assert.equal(explicit.notices, true);
  assert.equal(explicit.autoRecall, false);
  assert.equal(explicit.ambientPersonalVault, false);
  assert.equal(explicit.semanticWeight, 0.8);
});
