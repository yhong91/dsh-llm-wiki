import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  captureTrajectory,
  distilledTrajectoryIds,
  type TrajectoryStep,
} from "../engine/trajectory.js";
import { searchWikiLayered } from "../engine/recall.js";
import { readJson, resolveVaultPaths, type VaultPaths } from "../engine/utils.js";
import { inspectWritableVault } from "../engine/vault-format.js";

/**
 * Agent-trajectory working memory (opt-in, upstream issue #80) for dsh.
 *
 * Three tools mirror upstream's trajectory.ts: capture what the agent *did*
 * (wiki_capture_trajectory), hand back undistilled packets for synthesis
 * (wiki_distill_skills), and recall distilled skills/cases
 * (wiki_recall_skill). Upstream reads pi's `sessionManager`; dsh reads the
 * calling agent's own Session event log instead.
 */

export interface TrajectoryToolDeps {
  cwd(): string;
  cwdFor?(agent?: unknown): string;
}

const TOOL_PREVIEW_LIMIT = 600;
const TEXT_PREVIEW_LIMIT = 1200;

type EventLike = { type?: string; data?: unknown };

function textOf(content: unknown, limit: number): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim().slice(0, limit);
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw.slice(0, TOOL_PREVIEW_LIMIT) };
  }
}

/**
 * Flatten a dsh Session event log into normalized trajectory steps.
 *
 * Only genuine user prompts count (`source.kind === "user"`); injected
 * context such as recall blocks and reminders is skipped so it never
 * becomes the "task". Tool names for results come from the matching
 * `tool/call` event.
 */
export function extractTrajectoryFromEvents(events: readonly unknown[]): {
  steps: TrajectoryStep[];
  model?: string;
  prompt: string;
} {
  const steps: TrajectoryStep[] = [];
  const names = new Map<string, string>();
  let model: string | undefined;
  let prompt = "";

  for (const raw of events) {
    const event = raw as EventLike;
    const data = event?.data as Record<string, unknown> | undefined;
    if (!event?.type || !data) continue;

    if (event.type === "user/message") {
      const source = (data.source as { kind?: string } | undefined)?.kind;
      if (source !== "user") continue;
      const text = textOf(data.content, TEXT_PREVIEW_LIMIT);
      if (!text) continue;
      if (!prompt) prompt = text;
      steps.push({ role: "user", text });
    } else if (event.type === "assistant/message") {
      const message = data.message as
        | { content?: unknown; source?: { model?: string } }
        | undefined;
      if (!message) continue;
      if (!model && typeof message.source?.model === "string") model = message.source.model;
      const toolCalls: NonNullable<TrajectoryStep["tool_calls"]> = [];
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const b = block as { type?: string; id?: unknown; name?: unknown; arguments?: unknown };
          if (b?.type !== "tool-call") continue;
          const id = String(b.id ?? "");
          const name = String(b.name ?? "unknown");
          if (id) names.set(id, name);
          toolCalls.push({ id, name, arguments: parseArguments(b.arguments) });
        }
      }
      const text = textOf(message.content, TEXT_PREVIEW_LIMIT);
      const step: TrajectoryStep = { role: "assistant" };
      if (text) step.text = text;
      if (toolCalls.length > 0) step.tool_calls = toolCalls;
      if (step.text || step.tool_calls) steps.push(step);
    } else if (event.type === "tool/call") {
      const id = String(data.callId ?? "");
      if (id && typeof data.name === "string") names.set(id, data.name);
    } else if (event.type === "tool/result") {
      const message = data.message as
        | { toolCallId?: unknown; isError?: boolean; content?: unknown }
        | undefined;
      if (!message) continue;
      const id = message.toolCallId ? String(message.toolCallId) : undefined;
      steps.push({
        role: "tool",
        ...(id ? { tool_call_id: id } : {}),
        ...(id && names.get(id) ? { tool_name: names.get(id) } : {}),
        text: textOf(message.content, TOOL_PREVIEW_LIMIT),
        is_error: Boolean(message.isError),
      });
    }
  }

  return { steps, ...(model ? { model } : {}), prompt };
}

function sessionEvents(agent: unknown): readonly unknown[] {
  const session = (agent as { session?: { snapshotEvents?: () => readonly unknown[] } } | undefined)
    ?.session;
  if (typeof session?.snapshotEvents !== "function") return [];
  try {
    return session.snapshotEvents();
  } catch {
    return [];
  }
}

const OUT = { type: "object" as const, additionalProperties: true as const };

function textOut(render: (value: Record<string, unknown>) => string) {
  return {
    schema: OUT,
    render: (_args: unknown, value: Record<string, unknown>) => [
      { type: "text" as const, text: render(value) },
    ],
  };
}

function fail(code: string, message: string) {
  return { ok: false as const, error: code, message };
}

function vaultPaths(deps: TrajectoryToolDeps, exec?: { agent?: unknown }): VaultPaths {
  return resolveVaultPaths(deps.cwdFor?.(exec?.agent) ?? deps.cwd());
}

const STEP_SCHEMA = {
  type: "object" as const,
  additionalProperties: true as const,
  properties: {
    role: { type: "string" as const, enum: ["user", "assistant", "tool"], required: true as const },
    text: { type: "string" as const },
    tool_name: { type: "string" as const },
    tool_call_id: { type: "string" as const },
    is_error: { type: "boolean" as const },
  },
};

export function buildTrajectoryToolDefinitions(deps: TrajectoryToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "wiki_capture_trajectory",
      description:
        "Capture the just-completed task's tool-call trajectory into an immutable " +
        "packet plus a self-contained summary. By default the trajectory is extracted " +
        "automatically from the live session; pass `steps` to override. This is the " +
        "working-memory counterpart to wiki_capture_source.",
      parameters: {
        title: { type: "string", description: "Short descriptive title for the task (≤60 chars)." },
        task: {
          type: "string",
          description: "The task/prompt that started the work. Inferred from the session if omitted.",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure", "partial"],
          description: "Outcome of the task (default: success).",
        },
        steps: {
          type: "array",
          items: STEP_SCHEMA,
          description:
            "Explicit trajectory steps. Omit to auto-extract from the live session.",
        },
        model: { type: "string", description: "Model that ran the task." },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "capture failed");
        return [
          `🧭 **Trajectory captured**: ${v.trajectoryId}`,
          "",
          `- Packet: \`${v.packetPath}/packet.json\``,
          `- Summary: \`${v.packetPath}/extracted.md\``,
          `- Steps: ${v.stepCount}`,
          "",
          "**Next (optional):** run `wiki_distill_skills` to generalize captured trajectories into reusable skill pages.",
        ].join("\n");
      }),
      timeoutMs: 60_000,
      async execute(args, exec) {
        const p = vaultPaths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) {
          return fail(
            check.diagnostics[0]?.code ?? "vault_error",
            `Wiki vault error: ${check.diagnostics[0]?.message ?? "unknown"}`,
          );
        }
        let steps = (args.steps as TrajectoryStep[] | undefined) ?? [];
        let model = args.model as string | undefined;
        let task = args.task as string | undefined;
        if (steps.length === 0) {
          const extracted = extractTrajectoryFromEvents(sessionEvents(exec.agent));
          steps = extracted.steps;
          model = model || extracted.model;
          task = task || extracted.prompt;
        }
        if (steps.length === 0) {
          return fail(
            "empty_trajectory",
            "No trajectory could be extracted from the session. Pass `steps` explicitly to capture a trajectory.",
          );
        }
        let result: ReturnType<typeof captureTrajectory>;
        try {
          result = captureTrajectory(p, {
            title: args.title as string | undefined,
            task,
            steps,
            model,
            outcome: args.outcome as "success" | "failure" | "partial" | undefined,
          });
        } catch (error) {
          return fail("capture_failed", (error as Error).message);
        }
        return {
          ok: true,
          trajectoryId: result.trajectoryId,
          packetPath: result.packetPath,
          stepCount: result.stepCount,
        };
      },
    }),

    defineTool({
      name: "wiki_distill_skills",
      description:
        "Return a batch of captured trajectories (agent working-memory) that have not " +
        "yet been distilled into skill pages. Read each packet and synthesize reusable " +
        "skill pages (and/or refine case pages) that cite the trajectory IDs.",
      parameters: {
        trajectory_id: {
          type: "string",
          description: "Specific trajectory ID to distill. Omit for all undistilled.",
        },
        batch_size: { type: "number", description: "Max trajectories to return (default: 3, max: 5)" },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "distill failed");
        return String(v.message ?? "");
      }),
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(args, exec) {
        const p = vaultPaths(deps, exec);
        if (!existsSync(join(p.dotWiki, "config.json"))) {
          return fail("no_vault", "No wiki vault found at this location. Initialize one with wiki_bootstrap first.");
        }
        const batchSize = Math.max(1, Math.min(Number(args.batch_size ?? 3) || 3, 5));
        if (!existsSync(p.rawTrajectories)) {
          return fail(
            "no_trajectories",
            "No raw/trajectories/ directory. Capture trajectories first with wiki_capture_trajectory.",
          );
        }
        const packets = readdirSync(p.rawTrajectories)
          .filter((d) => d.startsWith("TRJ-"))
          .sort();
        const distilled = distilledTrajectoryIds(p);
        let toProcess = packets.filter((id) => !distilled.has(id));
        const wanted = args.trajectory_id as string | undefined;
        if (wanted) {
          if (!packets.includes(wanted)) return fail("not_found", `Trajectory ${wanted} not found.`);
          toProcess = [wanted];
        }
        const batch = toProcess.slice(0, batchSize);
        if (batch.length === 0) {
          return {
            ok: true,
            batch: [],
            remaining: 0,
            message: "✅ All trajectories distilled. Capture more with wiki_capture_trajectory.",
          };
        }
        const items = batch.map((id) => {
          const manifest = readJson<Record<string, unknown>>(
            join(p.rawTrajectories, id, "manifest.json"),
            {},
          );
          const summaryPath = join(p.rawTrajectories, id, "extracted.md");
          return { id, manifest, hasSummary: existsSync(summaryPath) && readFileSync(summaryPath, "utf-8").length > 0 };
        });
        const remaining = toProcess.length - batch.length;
        return {
          ok: true,
          batch: batch,
          remaining,
          message: [
            `🧪 **${batch.length} trajectory(ies) ready** (${remaining} remaining)`,
            "",
            ...items.map((t) =>
              [
                `- **${t.id}**: ${t.manifest.title || t.id}`,
                `  - Tool calls: ${t.manifest.tool_call_count ?? "?"}, steps: ${t.manifest.step_count ?? "?"}`,
                `  - Packet: \`raw/trajectories/${t.id}/packet.json\``,
                `  - Summary: \`raw/trajectories/${t.id}/extracted.md\``,
              ].join("\n"),
            ),
            "",
            "**Next steps for each trajectory:**",
            "1. Read packet.json (full tool-call sequence) and extracted.md (summary)",
            "2. Create/refine reusable skill pages via wiki_ensure_page(type='skill')",
            "3. Optionally write a case page (a specific past task) via wiki_ensure_page(type='case')",
            "4. Cite the trajectory with [trajectories/TRJ-...](/trajectories/TRJ-....md) in each skill's 'Distilled From'",
          ].join("\n"),
        };
      },
    }),

    defineTool({
      name: "wiki_recall_skill",
      description:
        "Search distilled skills and past cases (agent working-memory) for patterns " +
        "relevant to the current task — answers 'have I done something like this before?'. " +
        "Filters layered recall to skill and case pages.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "Search query — use the task description or key terms",
        },
        kind: {
          type: "string",
          enum: ["skill", "case", "any"],
          description: "Filter to skills, cases, or both (default: any).",
        },
        max_results: { type: "number", description: "Max results (default: 5, max: 10)" },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "recall failed");
        return String(v.message ?? "");
      }),
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(args, exec) {
        const p = vaultPaths(deps, exec);
        if (!existsSync(join(p.dotWiki, "config.json"))) {
          return fail("no_vault", "No wiki vault found at this location. Initialize one with wiki_bootstrap first.");
        }
        const maxResults = Math.max(1, Math.min(Number(args.max_results ?? 5) || 5, 10));
        const kind = (args.kind as "skill" | "case" | "any" | undefined) ?? "any";
        const raw = searchWikiLayered(p, args.query as string, maxResults * 4, 0);
        const wanted = kind === "any" ? ["skill", "case"] : [kind];
        const results = raw.filter((r) => wanted.includes(r.type)).slice(0, maxResults);
        const label = kind === "any" ? "skill/case" : kind;
        if (results.length === 0) {
          return {
            ok: true,
            matches: [],
            message: `No ${kind === "any" ? "skills or cases" : `${kind}s`} found matching "${args.query}". Capture work with wiki_capture_trajectory and distill it with wiki_distill_skills.`,
          };
        }
        return {
          ok: true,
          matches: results.map((r) => ({ id: r.id, title: r.title, type: r.type, path: r.path })),
          message: `Found ${results.length} ${label} page(s) matching "${args.query}":\n\n${results
            .map(
              (r) =>
                `## [[${r.id}]] — ${r.title}${r.vaultLabel ? ` ${r.vaultLabel}` : ""}\nType: ${r.type}\nPath: ${r.path}\n\n${r.preview}`,
            )
            .join("\n\n---\n\n")}`,
        };
      },
    }),
  ];
}
