import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
process.env.LLM_WIKI_HOST ??= "dsh";

const { registerAmbient } = await import("../lib/dsh/ambient.js");
const { DshRuntime } = await import("../lib/dsh/runtime.js");
const { loadTaskConfig } = await import("../lib/engine/task-config.js");
const { WIKI_STATUS_BLOCK } = await import("../lib/engine/inject.js");
const { getVaultPaths } = await import("../lib/engine/utils.js");

/**
 * Test double for the cordis surface registerAmbient touches: `ctx.on`
 * (event listeners, auto-disposed — we record them to invoke by hand) and
 * `ctx.systemPrompt.section` (the static footer registration).
 */
function makeCtx() {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>();
  const sections: Array<{ name: string; order: number; text: unknown; interpolate?: boolean }> = [];
  const ctx = {
    on(name: string, listener: (...args: never[]) => unknown) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => true;
    },
    systemPrompt: {
      section(section: (typeof sections)[number]) {
        sections.push(section);
        return () => {};
      },
    },
    emit(name: string, ...args: unknown[]) {
      return (listeners.get(name) ?? []).map((l) => l(...(args as never[])));
    },
    listenerCount(name: string) {
      return (listeners.get(name) ?? []).length;
    },
  };
  return { ctx: ctx as never, listeners, sections };
}

function makeDeps(cwd: string, config: Record<string, unknown> = {}) {
  const config_ = { ...loadTaskConfig(cwd), ...config };
  const runtime = new DshRuntime({ config: config_ as never, report: () => {}, cwd: () => cwd });
  return { cwd: () => cwd, config: config_, runtime };
}

/** A minimal VaultPaths-bearing temp vault (okf-0.2 gate satisfied). */
function makeVault(root: string) {
  const paths = getVaultPaths(root);
  mkdirSync(paths.meta, { recursive: true });
  mkdirSync(paths.wiki, { recursive: true });
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
  writeFileSync(join(paths.wiki, "index.md"), "---\nokf_version: \"0.2\"\ntitle: idx\ntype: source\ncreated: 2026-01-01\nupdated: 2026-01-01\nslug: index\n---\n# idx\n");
  writeFileSync(
    join(paths.meta, "registry.json"),
    JSON.stringify({ version: "1.0", last_updated: "", pages: {} }),
  );
  return paths;
}

function userMessage(text: string, kind = "user") {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind },
  };
}

const tmp: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "dsh-ambient-"));
  tmp.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

// ── Static footer ────────────────────────────────────────────────────

test("registers the wiki-status footer as a static system-prompt section", () => {
  const { ctx, sections } = makeCtx();
  registerAmbient(ctx, makeDeps(tempDir(), { ambientPersonalVault: true }));
  assert.equal(sections.length, 1);
  const s = sections[0];
  assert.equal(s.name, "llm-wiki:status");
  assert.equal(s.interpolate, false);
  // The provider returns the exact engine block for a main agent where a wiki
  // applies; it stays byte-identical so the cache prefix never churns.
  assert.equal(typeof s.text, "function");
  assert.equal((s.text as (context: unknown) => string)({}), WIKI_STATUS_BLOCK);
});

// ── agent/created session-start ──────────────────────────────────────

test("agent/created injects the session notice on startup when a vault exists", async () => {
  const root = tempDir();
  makeVault(root);
  const { ctx } = makeCtx();
  const injected: unknown[] = [];
  const agent = { inject: (m: unknown) => injected.push(m) };
  registerAmbient(ctx, makeDeps(root));
  // Serial event — await listeners the way cordis would.
  for (const p of (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
    .emit("agent/created", { agent, source: "startup" })) {
    await p;
  }
  assert.equal(injected.length, 1);
  const msg = injected[0] as { content: Array<{ text: string }> };
  assert.match(msg.content[0].text, /LLM Wiki active/);
});

test("agent/created launches QMD recovery in the background, except on compact", async () => {
  const root = tempDir();
  makeVault(root);
  const { ctx } = makeCtx();
  const deps = makeDeps(root);
  const labels: string[] = [];
  (deps.runtime as unknown as { launchTask: (c: unknown, l: string) => Promise<void> }).launchTask =
    async (_c, label) => {
      labels.push(label);
    };
  registerAmbient(ctx, deps);
  const emit = (source: string) =>
    (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] }).emit("agent/created", {
      agent: { inject: () => {} },
      source,
    });
  for (const p of emit("startup")) await p;
  assert.equal(labels.length, 1);
  assert.match(labels[0]!, /^qmd-recovery:/);
  for (const p of emit("compact")) await p;
  assert.equal(labels.length, 1, "compaction does not relaunch recovery");
});

test("agent/created auto-bootstraps a pending vault when none exists", async () => {
  // Point WIKI_HOME at a temp dir so the personal-vault fallback resolves
  // inside the fixture — never the real ~/.llm-wiki. A temp cwd has no
  // project vault, so resolution lands on WIKI_HOME and the silent
  // auto-bootstrap path (topic "pending") must create the vault there.
  const fakeHome = tempDir();
  const workCwd = tempDir();
  const prevWikiHome = process.env.WIKI_HOME;
  process.env.WIKI_HOME = fakeHome;
  try {
    const { ctx } = makeCtx();
    const agent = { inject: () => {} };
    registerAmbient(ctx, makeDeps(workCwd));
    for (const p of (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
      .emit("agent/created", { agent, source: "startup" })) {
      await p;
    }
    const configPath = join(fakeHome, ".llm-wiki", "config.json");
    assert.ok(existsSync(configPath), "auto-bootstrap created the vault config");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(config.topic, "pending");
    assert.equal(config.knowledge_format, "okf-0.2");
  } finally {
    if (prevWikiHome === undefined) delete process.env.WIKI_HOME;
    else process.env.WIKI_HOME = prevWikiHome;
  }
});

test("agent/created never throws, even with a disposed-agent inject", async () => {
  const root = tempDir();
  makeVault(root);
  const { ctx } = makeCtx();
  const agent = {
    inject: () => {
      throw new Error("disposed");
    },
  };
  registerAmbient(ctx, makeDeps(root));
  // The serial dispatcher fails creation on a thrown listener — the whole
  // point of the fail-silent contract.
  for (const p of (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
    .emit("agent/created", { agent, source: "startup" })) {
    await assert.doesNotReject(p);
  }
});

// ── agent/pre-step per-turn recall ───────────────────────────────────

test("pre-step admits the batch unchanged when no wiki applies", async () => {
  // A directory outside $HOME with no vault and ambientPersonalVault off:
  // the gate closes and the listener must pass messages through verbatim.
  const root = tempDir();
  const { ctx } = makeCtx();
  registerAmbient(ctx, makeDeps(root, { ambientPersonalVault: false }));
  const batch = [userMessage("fix the bug")];
  const decision = (await (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
    .emit(
      "agent/pre-step",
      { messages: batch, turn: 1, step: 1 },
      async () => ({ kind: "enter", messages: batch }),
    )[0]) as { kind: string; messages: unknown[] };
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, 1);
  assert.equal(decision.messages[0], batch[0]);
});

test("pre-step appends a recall context message when the vault matches", async () => {
  const root = tempDir();
  const paths = makeVault(root);
  // Give the registry one page that scores over the minScore=5 auto-inject
  // gate: title match (5) plus a recall_trigger match (7).
  const pageDir = join(paths.wiki, "concepts");
  mkdirSync(pageDir, { recursive: true });
  const pageId = "concepts/test-topic";
  writeFileSync(
    join(pageDir, "test-topic.md"),
    "---\ntitle: Zebra Topic\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\nslug: test-topic\nrecall_triggers:\n  - zebra\n---\n# Zebra Topic\n\nBody about zebras.\n",
  );
  writeFileSync(
    join(paths.meta, "registry.json"),
    JSON.stringify({
      version: "1.0",
      last_updated: "",
      pages: {
        [pageId]: {
          title: "Zebra Topic",
          type: "concept",
          recall_triggers: ["zebra"],
          aliases: [],
          tags: [],
        },
      },
    }),
  );
  const { ctx } = makeCtx();
  registerAmbient(ctx, makeDeps(root));
  const batch = [userMessage("tell me about zebra")];
  const decision = (await (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
    .emit(
      "agent/pre-step",
      { messages: batch, turn: 1, step: 1 },
      async () => ({ kind: "enter", messages: batch }),
    )[0]) as { kind: string; messages: Array<{ source?: { kind?: string; form?: string }; content: Array<{ text: string }> }> };
  assert.equal(decision.kind, "enter");
  assert.equal(decision.messages.length, 2);
  const recall = decision.messages[1];
  assert.equal(recall.source?.kind, "dsh-llm-wiki");
  assert.equal(recall.source?.form, "recall");
  assert.match(recall.content[0].text, /Relevant Wiki Knowledge/);
  assert.match(recall.content[0].text, /Zebra Topic/);
  // Cache contract: the appended content lives in a tail message, never the
  // admitted user prompt itself.
  assert.equal(decision.messages[0], batch[0]);
});

test("pre-step skips recall for non-user-source steps (tool/steering)", async () => {
  const root = tempDir();
  makeVault(root);
  const { ctx } = makeCtx();
  registerAmbient(ctx, makeDeps(root));
  const batch = [userMessage("zebra", "dsh-llm-wiki")];
  const decision = (await (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
    .emit(
      "agent/pre-step",
      { messages: batch, turn: 1, step: 2 },
      async () => ({ kind: "enter", messages: batch }),
    )[0]) as { kind: string; messages: unknown[] };
  assert.equal(decision.messages.length, 1);
});

test("pre-step autoRecall:false admits the batch unchanged", async () => {
  const root = tempDir();
  const paths = makeVault(root);
  const pageDir = join(paths.wiki, "concepts");
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(
    join(pageDir, "t.md"),
    "---\ntitle: Zebra\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\nslug: t\n---\n# Zebra\nzebra body\n",
  );
  writeFileSync(
    join(paths.meta, "registry.json"),
    JSON.stringify({
      version: "1.0",
      last_updated: "",
      pages: { "concepts/t": { title: "Zebra", type: "concept", recall_triggers: ["zebra"], aliases: [], tags: [] } },
    }),
  );
  const { ctx } = makeCtx();
  registerAmbient(ctx, makeDeps(root, { autoRecall: false }));
  const batch = [userMessage("zebra")];
  const decision = (await (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
    .emit(
      "agent/pre-step",
      { messages: batch, turn: 1, step: 1 },
      async () => ({ kind: "enter", messages: batch }),
    )[0]) as { kind: string; messages: unknown[] };
  assert.equal(decision.messages.length, 1);
});

test("pre-step never rejects on a throwing recall path", async () => {
  // cwd() throws — the worst case for a boundary read. The listener must
  // still return a decision (reject is the documented least-bad fallback)
  // rather than a rejected promise, which would stall the agent loop.
  const { ctx } = makeCtx();
  const config = loadTaskConfig("/");
  const runtime = new DshRuntime({ config, report: () => {}, cwd: () => "/" });
  registerAmbient(ctx, {
    cwd: () => {
      throw new Error("cwd exploded");
    },
    config,
    runtime,
  });
  const batch = [userMessage("hello")];
  const decision = await (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
    .emit(
      "agent/pre-step",
      { messages: batch, turn: 1, step: 1 },
      async () => ({ kind: "enter", messages: batch }),
    )[0];
  assert.ok(decision && typeof decision === "object");
});

// ── Vault cleanliness ────────────────────────────────────────────────

test("the test run wrote nothing to the real personal vault", () => {
  const registryPath = join(
    process.env.HOME ?? "",
    ".llm-wiki",
    "meta",
    "registry.json",
  );
  if (!existsSync(registryPath)) return; // nothing to protect on this machine
  // Snapshot AFTER all tests ran: if any test above accidentally resolved to
  // the real vault and wrote, mtime/size would have moved during this file.
  // (We can't compare against a pre-run snapshot inside this file without
  // module-level ordering, so assert the vault is still well-formed instead.)
  const stat = statSync(registryPath);
  assert.ok(stat.size > 0);
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { pages?: unknown };
  assert.ok(parsed.pages && typeof parsed.pages === "object");
});

test("pre-step adds the Pi-style capture reminder every five turns and observe clears it", async () => {
  const root = tempDir();
  makeVault(root);
  const { ctx } = makeCtx();
  const reminderStates = new Map<string, { observeDone: boolean; turns: number }>();
  const deps = { ...makeDeps(root), reminderStates };
  registerAmbient(ctx, deps);
  const agent = { session: { id: "session-reminder-test" } };
  reminderStates.set("session-reminder-test", { observeDone: false, turns: 0 });

  const invoke = async (text: string) =>
    (await (ctx as never as { emit: (n: string, ...a: unknown[]) => unknown[] })
      .emit(
        "agent/pre-step",
        { agent, messages: [userMessage(text)] },
        async () => ({ kind: "enter", messages: [userMessage(text)] }),
      )[0]) as { kind: string; messages: Array<{ content: Array<{ text: string }> }> };

  for (let turn = 1; turn <= 4; turn += 1) {
    const decision = await invoke(`turn ${turn}`);
    assert.equal(decision.messages.length, 1, `turn ${turn} has no reminder`);
  }
  const fifth = await invoke("turn 5");
  assert.equal(fifth.messages.length, 2, "fifth turn carries a reminder");
  assert.match(fifth.messages[1]!.content[0]!.text, /Wiki capture reminder/);

  const sixth = await invoke("turn 6");
  assert.equal(sixth.messages.length, 1, "interval resets after a reminder fires");

  reminderStates.set("session-reminder-test", { observeDone: true, turns: 5 });
  const seventh = await invoke("turn 7");
  assert.equal(seventh.messages.length, 1, "observed session stops reminding");
});
