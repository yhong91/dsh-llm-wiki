import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
process.env.LLM_WIKI_HOST ??= "dsh";

const { bootstrapVault } = await import("../lib/engine/bootstrap.js");
const { getVaultPaths } = await import("../lib/engine/utils.js");
const { buildTrajectoryToolDefinitions, extractTrajectoryFromEvents } = await import(
  "../lib/dsh/trajectory.js"
);
const { buildTrajectoriesCommand, COMMAND_TEMPLATES } = await import("../lib/dsh/commands.js");

const ev = (type: string, data: unknown) => ({ type, data });

const EVENTS = [
  ev("user/message", { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "修复分页 bug" }] }),
  ev("user/message", { role: "user", source: { kind: "dsh-llm-wiki" }, content: [{ type: "text", text: "<wiki-recall-context>x</wiki-recall-context>" }] }),
  ev("assistant/message", {
    message: {
      role: "assistant",
      source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
      content: [
        { type: "text", text: "先读文件" },
        { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"a.ts"}' },
      ],
    },
  }),
  ev("tool/call", { callId: "c1", name: "read", arguments: "{}" }),
  ev("tool/result", { message: { role: "tool", toolCallId: "c1", isError: false, content: [{ type: "text", text: "文件内容" }] } }),
];

test("extractTrajectoryFromEvents keeps real prompts, tool calls and named results", () => {
  const out = extractTrajectoryFromEvents(EVENTS);
  assert.equal(out.prompt, "修复分页 bug");
  assert.equal(out.model, "deepseek-v4");
  assert.deepEqual(out.steps.map((s) => s.role), ["user", "assistant", "tool"]);
  assert.equal(out.steps[1]!.tool_calls![0]!.name, "read");
  assert.deepEqual(out.steps[1]!.tool_calls![0]!.arguments, { file_path: "a.ts" });
  assert.equal(out.steps[2]!.tool_name, "read");
  assert.equal(out.steps[2]!.text, "文件内容");
});

test("trajectory tools capture, distill and recall in a temp vault", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-trajectory-"));
  try {
    const paths = getVaultPaths(root);
    assert.equal(bootstrapVault(paths, { topic: "audit", mode: "personal" }).ok, true);
    const tools = new Map(
      buildTrajectoryToolDefinitions({ cwd: () => root }).map((t) => [t.name, t]),
    );
    assert.deepEqual([...tools.keys()].sort(), [
      "wiki_capture_trajectory",
      "wiki_distill_skills",
      "wiki_recall_skill",
    ]);
    const agent = { session: { snapshotEvents: () => EVENTS } };
    const run = (name: string, args: Record<string, unknown>) =>
      (tools.get(name)!.execute as (a: unknown, e: unknown) => Promise<Record<string, any>>)(args, { agent });

    const captured = await run("wiki_capture_trajectory", { title: "修复分页", outcome: "success" });
    assert.equal(captured.ok, true);
    assert.match(captured.trajectoryId, /^TRJ-/);
    assert.ok(existsSync(join(captured.packetPath, "packet.json")));
    assert.match(readFileSync(join(captured.packetPath, "extracted.md"), "utf8"), /`read`/);
    const manifest = JSON.parse(readFileSync(join(captured.packetPath, "manifest.json"), "utf8"));
    assert.equal(manifest.format, "trajectory");
    assert.equal(manifest.tool_call_count, 1);

    const distill = await run("wiki_distill_skills", {});
    assert.equal(distill.ok, true);
    assert.deepEqual(distill.batch, [captured.trajectoryId]);

    const recall = await run("wiki_recall_skill", { query: "分页" });
    assert.equal(recall.ok, true);
    assert.deepEqual(recall.matches, []);

    const empty = await (tools.get("wiki_capture_trajectory")!.execute as any)({}, { agent: { session: { snapshotEvents: () => [] } } });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, "empty_trajectory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/wiki-trajectories reports, enables and disables via project settings", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-trajectory-cmd-"));
  const home = mkdtempSync(join(tmpdir(), "dsh-trajectory-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const cmd = buildTrajectoriesCommand({ cwd: () => root });
    const call = (rawInput: string) =>
      cmd.handler({ commandId: "x", agent: {}, rawInput, attachments: [], signal: new AbortController().signal }) as { kind: string; text: string };
    assert.match(call("").text, /OFF/);
    assert.match(call("on").text, /enabled/);
    assert.match(call("").text, /ON/);
    assert.match(call("on").text, /already ON/);
    assert.match(call("off").text, /disabled/);
    assert.match(call("").text, /OFF/);
    assert.equal(call("maybe").kind, "error");
  } finally {
    process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("wiki-record and wiki-skills notes no longer claim the tools are unregistered", () => {
  for (const name of ["wiki-record", "wiki-skills"]) {
    const body = COMMAND_TEMPLATES.find((t) => t.name === name)!.body;
    assert.doesNotMatch(body, /not yet registered/);
  }
});
