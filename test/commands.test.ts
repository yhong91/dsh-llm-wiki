import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const {
  buildCommandDefinitions,
  COMMAND_TEMPLATES,
  renderTemplate,
} = await import("../lib/dsh/commands.js");

const EXPECTED_COMMANDS = [
  "wiki-init",
  "wiki-status",
  "wiki-query",
  "wiki-ingest",
  "wiki-discover",
  "wiki-lint",
  "wiki-run",
  "wiki-retro",
  "wiki-record",
  "wiki-skills",
  "wiki-req",
  "wiki-digest",
];

/** Commands that carry an argument-hint in upstream prompts/*.md frontmatter. */
const EXPECTED_HINTS: Record<string, string> = {
  "wiki-init": "<topic> [--mode personal|company]",
  "wiki-query": "<question>",
  "wiki-ingest": "[source_id]",
  "wiki-discover": "[--topic <topic>]",
  "wiki-lint": "[--fix]",
  "wiki-run": "[--schedule daily|weekly]",
  "wiki-retro": "<title> [--category <category>]",
  "wiki-record": "<title> [--outcome success|failure|partial]",
  "wiki-skills": "[query] [--kind skill|case]",
  "wiki-req": "<concept description>",
  "wiki-digest": "[--period daily|weekly]",
};

const definitions = buildCommandDefinitions({});
const byName = new Map(definitions.map((d) => [d.name, d]));

function makeInvocation(rawInput: string) {
  const steered: unknown[] = [];
  return {
    invocation: {
      commandId: "cmd-test",
      agent: { steer: (m: unknown) => steered.push(m) },
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    },
    steered,
  };
}

test("exactly the 12 expected commands are defined, no duplicates", () => {
  assert.equal(definitions.length, EXPECTED_COMMANDS.length);
  assert.deepEqual(
    definitions.map((d) => d.name).sort(),
    [...EXPECTED_COMMANDS].sort(),
  );
  assert.equal(new Set(definitions.map((d) => d.name)).size, EXPECTED_COMMANDS.length);
});

test("every definition has a non-empty description, correct hint, and a handler", () => {
  for (const def of definitions) {
    assert.ok(def.description.trim().length > 20, `${def.name} description is substantive`);
    assert.equal(typeof def.handler, "function", `${def.name} handler`);
    const hint = EXPECTED_HINTS[def.name];
    if (hint) {
      assert.equal(def.input?.hint, hint, `${def.name} input hint`);
    } else {
      assert.equal(def.input, undefined, `${def.name} takes no input`);
    }
  }
});

test("COMMAND_TEMPLATES covers the same 12 names with bodies", () => {
  assert.equal(COMMAND_TEMPLATES.length, 12);
  for (const t of COMMAND_TEMPLATES) {
    assert.ok(EXPECTED_COMMANDS.includes(t.name), `unexpected template ${t.name}`);
    assert.ok(t.body.includes(`# /${t.name}`), `${t.name} body carries its heading`);
    assert.ok(!t.body.includes("description:"), `${t.name} body stripped frontmatter`);
    assert.ok(!t.body.includes(".pi/skills"), `${t.name} body has no pi-only skill path`);
  }
});

test("handler steers the rendered template into the agent and returns success", async () => {
  const def = byName.get("wiki-query");
  assert.ok(def);
  const { invocation, steered } = makeInvocation("  what is RAG?  ");
  const result = await def.handler(invocation);
  assert.equal(result.kind, "success");
  assert.equal(steered.length, 1, "one message steered");
  const message = steered[0] as {
    role: string;
    content: Array<{ type: string; text: string }>;
    source: { kind: string };
    id: string;
  };
  assert.equal(message.role, "user");
  assert.equal(message.source.kind, "user");
  assert.ok(typeof message.id === "string" && message.id.length > 0, "createUserMessage minted an id");
  assert.equal(message.content[0].type, "text");
  assert.ok(message.content[0].text.includes("what is RAG?"), "raw input substituted into $ARGUMENTS");
  assert.ok(message.content[0].text.includes("wiki_recall"), "template body reached the model");
});

test("handler with empty input substitutes a placeholder and still dispatches", async () => {
  const def = byName.get("wiki-status");
  assert.ok(def);
  const { invocation, steered } = makeInvocation("");
  const result = await def.handler(invocation);
  assert.equal(result.kind, "success");
  assert.equal(steered.length, 1);
});

test("handler never throws — a missing agent returns a structured error", async () => {
  const def = byName.get("wiki-init");
  assert.ok(def);
  const { invocation } = makeInvocation("my topic");
  const result = await def.handler({ ...invocation, agent: undefined as never });
  assert.equal(result.kind, "error");
  assert.match((result as { text: string }).text, /agent/i);
});

test("renderTemplate substitutes $ARGUMENTS everywhere", () => {
  const template = COMMAND_TEMPLATES.find((t) => t.name === "wiki-query");
  assert.ok(template);
  const rendered = renderTemplate(template, "RAG vs wiki?");
  assert.ok(rendered.includes("RAG vs wiki?"));
  assert.ok(!rendered.includes("$ARGUMENTS"), "no unsubstituted markers");
});

test("skill file parses with the dsh frontmatter shape", () => {
  const text = readFileSync(
    join(import.meta.dirname, "..", "skills", "llm-wiki", "SKILL.md"),
    "utf8",
  );
  assert.ok(text.startsWith("---\n"), "frontmatter opens");
  const end = text.indexOf("\n---", 4);
  assert.ok(end > 0, "frontmatter closes");
  const fm = text.slice(4, end);
  assert.match(fm, /^name: llm-wiki$/m, "kebab-case name");
  assert.match(fm, /^description: .{50,}/m, "catalog description");
  assert.match(fm, /^whenToUse: /m, "whenToUse present");
  const body = text.slice(end + 4);
  for (const tool of ["wiki_recall", "wiki_retro", "wiki_capture_source", "wiki_ensure_page", "wiki_observe"]) {
    assert.ok(body.includes(tool), `skill body names ${tool}`);
  }
  assert.ok(!body.includes(".pi/skills"), "no pi skill path in body");
  assert.ok(!body.includes("/wiki-model"), "pi-only command removed");
});
