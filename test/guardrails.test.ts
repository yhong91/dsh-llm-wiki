import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.LLM_WIKI_HOST ??= "dsh";

const {
  mutationDenyReason,
  shellWriteTargets,
  structuredTarget,
  findEnclosingVault,
  registerGuardrails,
} = await import("../lib/dsh/guardrails.js");

// ── Fixture vaults ────────────────────────────────────────────────────────
// Temp-dir vaults in both layouts; no writes to any real vault anywhere.
const tmp = mkdtempSync(join(tmpdir(), "dsh-wiki-guard-"));

function makeOkfVault(root: string): void {
  const dot = join(root, ".llm-wiki");
  mkdirSync(join(dot, "raw", "sources"), { recursive: true });
  mkdirSync(join(dot, "meta"), { recursive: true });
  mkdirSync(join(dot, "wiki", "concepts"), { recursive: true });
  writeFileSync(
    join(dot, "config.json"),
    JSON.stringify({ vault_id: "test", knowledge_format: "okf-0.2", mode: "personal" }),
  );
  writeFileSync(
    join(dot, "wiki", "index.md"),
    "---\nokf_version: \"0.2\"\ntitle: test\n---\n\n# Index\n",
  );
  writeFileSync(join(dot, "wiki", "concepts", "alpha.md"), "---\ntype: concept\n---\n# A\n");
  writeFileSync(join(dot, "meta", "events.jsonl"), "{}\n");
}

function makeLegacyVault(root: string): void {
  mkdirSync(join(root, ".wiki"), { recursive: true });
  mkdirSync(join(root, "raw", "sources"), { recursive: true });
  mkdirSync(join(root, "meta"), { recursive: true });
  mkdirSync(join(root, "wiki"), { recursive: true });
  writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({ vault_id: "t" }));
}

function makeBrokenVault(root: string): void {
  // .llm-wiki exists but config.json is unreadable JSON → format blocking.
  const dot = join(root, ".llm-wiki");
  mkdirSync(join(dot, "wiki"), { recursive: true });
  writeFileSync(join(dot, "config.json"), "{ not json");
}

const okfRoot = join(tmp, "okf-vault");
const legacyRoot = join(tmp, "legacy-vault");
const brokenRoot = join(tmp, "broken-vault");
const plainRoot = join(tmp, "plain-project");

makeOkfVault(okfRoot);
makeLegacyVault(legacyRoot);
makeBrokenVault(brokenRoot);
mkdirSync(join(plainRoot, "raw"), { recursive: true });
mkdirSync(join(plainRoot, "meta"), { recursive: true });

const okf = (rel: string) => join(okfRoot, ".llm-wiki", rel);
const leg = (rel: string) => join(legacyRoot, rel);

// Fake ToolExecution shape — the guard only reads name + arguments.
const execOf = (name: string, args: unknown) => ({ name, arguments: args });

// ── mutationDenyReason: the ownership gates ────────────────────────────────

test("denies write into raw/** of an okf vault", () => {
  const reason = mutationDenyReason(okf("raw/sources/SRC-2026-01-01-001/extracted.md"));
  assert.ok(reason, "expected deny");
  assert.match(reason, /immutable/i);
});

test("denies write into meta/** of an okf vault", () => {
  const reason = mutationDenyReason(okf("meta/registry.json"));
  assert.ok(reason);
  assert.match(reason, /auto-generated/i);
});

test("denies write to meta/events.jsonl specifically", () => {
  const reason = mutationDenyReason(okf("meta/events.jsonl"));
  assert.ok(reason);
  assert.match(reason, /append-only/i);
});

test("allows write to an ordinary wiki/** page in a healthy vault", () => {
  assert.equal(mutationDenyReason(okf("wiki/concepts/new-page.md")), undefined);
});

test("denies write to generated index.md inside wiki/**", () => {
  const reason = mutationDenyReason(okf("wiki/index.md"));
  assert.ok(reason);
  assert.match(reason, /read-only|generated/i);
});

test("denies every write inside a vault whose format blocks", () => {
  const reason = mutationDenyReason(join(brokenRoot, ".llm-wiki", "wiki", "x.md"));
  assert.ok(reason);
  assert.match(reason, /invalid/i);
});

test("denies write into legacy-layout raw/** and meta/**", () => {
  assert.ok(mutationDenyReason(leg("raw/sources/x/extracted.md")));
  assert.ok(mutationDenyReason(leg("meta/events.jsonl")));
});

test("allows wiki/** write in a legacy vault", () => {
  assert.equal(mutationDenyReason(leg("wiki/page.md")), undefined);
});

test("fail-open for a raw/** path outside any vault", () => {
  assert.equal(mutationDenyReason(join(plainRoot, "raw", "notes.md")), undefined);
  assert.equal(mutationDenyReason(join(plainRoot, "meta", "x.json")), undefined);
});

test("findEnclosingVault returns paths for vault members and undefined outside", () => {
  const vault = findEnclosingVault(okf("raw/sources/x"));
  assert.ok(vault);
  assert.equal(vault.dotWiki, join(okfRoot, ".llm-wiki"));
  assert.equal(findEnclosingVault(join(plainRoot, "raw", "x")), undefined);
});

test("symlinked vault root still resolves protected paths", () => {
  const link = join(tmp, "vault-link");
  symlinkSync(okfRoot, link, "dir");
  const reason = mutationDenyReason(join(link, ".llm-wiki", "raw", "x.md"));
  assert.ok(reason, "symlinked path into raw must deny");
});

// ── structuredTarget: fs write/edit extraction ────────────────────────────

test("structuredTarget resolves file_path absolute and relative", () => {
  const cwd = plainRoot;
  assert.equal(
    structuredTarget(execOf("write", { file_path: "/tmp/x.md" }) as never, cwd),
    "/tmp/x.md",
  );
  assert.equal(
    structuredTarget(execOf("edit", { file_path: "sub/f.md" }) as never, cwd),
    join(cwd, "sub/f.md"),
  );
  assert.equal(structuredTarget(execOf("read", { file_path: "x" }) as never, cwd), undefined);
  assert.equal(structuredTarget(execOf("write", {}) as never, cwd), undefined);
});

// ── shellWriteTargets: conservative command scanning ──────────────────────

test("redirection operands are collected", () => {
  const targets = shellWriteTargets('echo hi > out.txt && cat x >> "a b.md"', plainRoot);
  assert.deepEqual(targets, [join(plainRoot, "out.txt"), join(plainRoot, "a b.md")]);
});

test("glued redirection operands are collected", () => {
  const targets = shellWriteTargets("echo hi >out.txt 2>err.log", plainRoot);
  assert.deepEqual(targets, [join(plainRoot, "out.txt"), join(plainRoot, "err.log")]);
});

test("mutating command operands are collected; readers are not", () => {
  const targets = shellWriteTargets("rm a.txt; cat raw/x; rm -rf dir", plainRoot);
  assert.deepEqual(targets, [join(plainRoot, "a.txt"), join(plainRoot, "dir")]);
});

test("flags and VAR=value operands are skipped", () => {
  // `tee` mid-list is an rm OPERAND to the scanner (and to a real shell —
  // `rm` would delete a file literally named `tee`); conservative scan keeps
  // it. Non-vault resolution is what makes the extra target harmless.
  const targets = shellWriteTargets("rm -rf --verbose x.md DD=1 tee f.md", plainRoot);
  assert.deepEqual(targets, [
    join(plainRoot, "x.md"),
    join(plainRoot, "tee"),
    join(plainRoot, "f.md"),
  ]);
});

test("sudo-prefixed writes still scan", () => {
  const targets = shellWriteTargets("sudo rm /abs/p.md", plainRoot);
  assert.deepEqual(targets, ["/abs/p.md"]);
});

test("cd retargets relative operands later in the line", () => {
  const targets = shellWriteTargets("cd sub && rm x.md", plainRoot);
  assert.deepEqual(targets, [join(plainRoot, "sub", "x.md")]);
});

test("tilde expands in operand paths", () => {
  const targets = shellWriteTargets("rm ~/dead.md", "/nonexistent-base");
  assert.equal(targets.length, 1);
  assert.ok(targets[0].endsWith("/dead.md"));
  assert.ok(!targets[0].startsWith("/nonexistent-base"));
});

test("pwsh verbs and redirection are collected", () => {
  // `x` after Set-Content's path operand is the -Value, but the scanner can't
  // distinguish values from paths — it lands in targets and is allowed by
  // the non-vault check downstream. Same conservative-over-collect contract.
  const targets = shellWriteTargets(
    "Set-Content vault/f.md x; Remove-Item old.md; 'hi' | Out-File o.md",
    plainRoot,
  );
  assert.deepEqual(targets, [
    join(plainRoot, "vault/f.md"),
    join(plainRoot, "x"),
    join(plainRoot, "old.md"),
    join(plainRoot, "o.md"),
  ]);
});

// ── End-to-end deny through the shell path ────────────────────────────────

test("bash command writing into vault raw is denied", () => {
  const targets = shellWriteTargets(`echo x > ${okf("raw/hijack.md")}`, plainRoot);
  assert.equal(targets.length, 1);
  assert.ok(mutationDenyReason(targets[0]));
});

test("bash rm of a vault meta file is denied", () => {
  const targets = shellWriteTargets(`rm ${okf("meta/registry.json")}`, plainRoot);
  assert.ok(targets[0] && mutationDenyReason(targets[0]));
});

test("bash cat of vault raw is allowed (read is not a write)", () => {
  const targets = shellWriteTargets(`cat ${okf("raw/sources/s/extracted.md")}`, plainRoot);
  assert.equal(targets.length, 0);
});

test("bash write inside an unrelated project's raw dir is allowed", () => {
  const targets = shellWriteTargets("echo x > raw/notes.md", plainRoot);
  assert.equal(targets.length, 1);
  assert.equal(mutationDenyReason(targets[0]), undefined);
});

test("cd into vault root then relative rm of raw file is denied", () => {
  const targets = shellWriteTargets(`cd ${okfRoot} && rm .llm-wiki/raw/x.md`, plainRoot);
  assert.equal(targets.length, 1);
  assert.ok(mutationDenyReason(targets[0]));
});

// ── registerGuardrails wiring ─────────────────────────────────────────────

test("registerGuardrails installs a guard without throwing", () => {
  const guards: Array<(e: never) => string | undefined> = [];
  const listeners: Record<string, Array<(...a: never[]) => void>> = {};
  const fakeCtx = {
    tools: {
      guard: (g: (e: never) => string | undefined) => {
        guards.push(g);
        return () => {};
      },
    },
    on: (name: string, l: (...a: never[]) => void) => {
      (listeners[name] ??= []).push(l);
      return () => true;
    },
  };
  const deps = { cwd: () => plainRoot };
  registerGuardrails(fakeCtx as never, deps);
  assert.equal(guards.length, 1);
  // No runtime dep → no observers installed.
  assert.equal(Object.keys(listeners).length, 0);

  const guard = guards[0];
  // Deny a write into vault raw through the fs tool shape.
  const deny = guard(execOf("write", { file_path: okf("raw/evil.md") }) as never);
  assert.ok(deny && deny.length > 0);
  // Allow a write into the plain project.
  const allow = guard(execOf("write", { file_path: join(plainRoot, "ok.md") }) as never);
  assert.equal(allow, undefined);
  // A malformed exec never throws.
  assert.equal(guard(execOf("write", 42) as never), undefined);
  assert.equal(guard({} as never), undefined);
});

test("registerGuardrails with runtime also observes tools/result and session/event", () => {
  const listeners: Record<string, Array<(...a: never[]) => void>> = {};
  let scheduled = 0;
  const fakeCtx = {
    tools: { guard: () => () => {} },
    on: (name: string, l: (...a: never[]) => void) => {
      (listeners[name] ??= []).push(l);
      return () => true;
    },
  };
  const runtime = {
    launchTask: (_c: unknown, _l: string, work: () => Promise<void>) => {
      scheduled += 1;
      return work().catch(() => {});
    },
  };
  registerGuardrails(fakeCtx as never, {
    cwd: () => plainRoot,
    runtime: runtime as never,
  });
  assert.ok(listeners["tools/result"], "tools/result listener installed");
  assert.ok(listeners["session/event"], "session/event listener installed");

  // A successful wiki/** write marks dirty; a step event drains it.
  for (const l of listeners["tools/result"]) {
    l(
      execOf("write", { file_path: okf("wiki/concepts/hand.md") }) as never,
      { isError: false } as never,
    );
  }
  for (const l of listeners["session/event"]) {
    l({} as never, { type: "step/done" } as never);
  }
  assert.equal(scheduled, 1, "one drain scheduled the reindex");

  // A non-wiki result marks nothing; another step event schedules nothing.
  for (const l of listeners["tools/result"]) {
    l(
      execOf("write", { file_path: join(plainRoot, "note.md") }) as never,
      { isError: false } as never,
    );
    l(execOf("write", { file_path: okf("wiki/concepts/hand.md") }) as never, {
      isError: true,
    } as never);
  }
  for (const l of listeners["session/event"]) {
    l({} as never, { type: "step/done" } as never);
  }
  assert.equal(scheduled, 1, "no extra drain");
});

// cleanup
test.after(() => {
  rmSync(tmp, { recursive: true, force: true });
});
