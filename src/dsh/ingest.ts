import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  INGEST_SYSTEM,
  commitSynthesis,
  type SynthesisData,
} from "../engine/ingest-worker.js";
import { rebuildMetadataLight } from "../engine/metadata.js";
import type { TaskConfig } from "../engine/task-config.js";
import type { VaultPaths } from "../engine/utils.js";

/**
 * DSH-native background ingest lane.
 *
 * DSH exposes a managed subagent service:
 * `ctx.subagents.startActivation({ delivery: 'caller', outputSchema })`
 * publishes a child, returns a structured result, and suppresses the parent
 * notification. This module bridges that service to the deterministic
 * `commitSynthesis` function — the child only produces structured data; all
 * vault writes stay in the main process and remain testable without an LLM.
 *
 * The optional `ctx.jobs` half makes the work visible/cancellable through the
 * Host job registry. When jobs is absent, the same promise runs detached and
 * reports completion via `agent.inject`; when subagents is absent the caller
 * falls back to the upstream synchronous "synthesize it yourself" flow.
 */

export interface SubagentResultLike {
  readonly stopReason: string;
  readonly structured?: unknown;
  readonly diagnostic?: string;
}

export interface SubagentActivationLike {
  readonly result: Promise<SubagentResultLike>;
  dispose(): Promise<void>;
}

export interface SubagentActivationSpecLike {
  readonly provider: string;
  readonly label: string;
  readonly request: {
    readonly cwd?: string;
    readonly prompt: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
    readonly parent: unknown;
    readonly agentOptions?: {
      readonly provider?: string;
      readonly model?: string;
      readonly maxTokens?: number;
    };
    readonly outputSchema?: unknown;
  };
  readonly signal: AbortSignal;
  readonly delivery: "caller" | "parent";
}

export interface SubagentsServiceLike {
  list(): string[];
  startActivation(spec: SubagentActivationSpecLike): Promise<SubagentActivationLike>;
}

export interface JobHandleLike {
  append?(text: string, options?: { channel?: string }): void;
  updateProgress?(line: string): void;
}

export interface JobOutcomeLike {
  readonly status: "completed" | "failed" | "killed";
  readonly detail?: string;
  readonly result?: string;
}

export interface JobsServiceLike {
  start(spec: {
    readonly kind: string;
    readonly label: string;
    readonly owner?: string;
    run(job: JobHandleLike): {
      done: Promise<JobOutcomeLike>;
      cancel(reason?: string): void;
    };
  }): string;
}

export interface IngestDeps {
  readonly config: TaskConfig;
  readonly subagents?: SubagentsServiceLike;
  readonly jobs?: JobsServiceLike;
  /** Effective session directory for the parent agent, with a process fallback. */
  cwd(): string;
  /** Optional per-agent directory resolver (DSH workingDirectory service). */
  cwdFor?(agent?: unknown): string;
}

export interface StartIngestArgs {
  readonly paths: VaultPaths;
  readonly sourceId: string;
  readonly manifest: Record<string, unknown>;
  readonly extracted: string;
  readonly parent?: unknown;
  /** Per-call `provider/id` override, else configured taskModel, else parent model. */
  readonly model?: { provider: string; id: string };
}

export type StartIngestResult =
  | { readonly ok: true; readonly provider: string; readonly jobId?: string }
  | { readonly ok: false; readonly reason: string };

const MAX_EXTRACTED_CHARS = 24_000;

/**
 * DSH's structured-output schema subset is smaller than TypeBox's JSON
 * Schema: `minLength`, `$id`, and symbol-keyed TypeBox metadata are rejected
 * by `assertObjectJsonSchema`. Keep the wire schema explicit and plain here;
 * `SynthesisData` remains the compile-time mirror of this shape.
 */
const COMMIT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "key_takeaways", "entities", "concepts"],
  properties: {
    summary: {
      type: "string",
      description: "2-3 paragraph summary of the source's key content.",
    },
    key_takeaways: {
      type: "array",
      items: { type: "string" },
      description: "The most important points, one per item.",
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description"],
        properties: {
          title: { type: "string", description: "Entity name." },
          description: { type: "string", description: "One-line entity description." },
        },
      },
      description: "Named entities mentioned in the source.",
    },
    concepts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "definition"],
        properties: {
          title: { type: "string", description: "Concept name." },
          definition: { type: "string", description: "One-line concept definition." },
        },
      },
      description: "Concepts discussed in the source.",
    },
    quotes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string" },
          attribution: { type: "string" },
        },
      },
      description: "Notable verbatim quotes.",
    },
    contradictions: {
      type: "array",
      items: { type: "string" },
      description: "Tensions/contradictions with existing wiki content, if any.",
    },
  },
} as const;

function agentId(agent: unknown): string | undefined {
  if (!agent || typeof agent !== "object") return undefined;
  const id = (agent as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function deliver(agent: unknown, text: string): void {
  const inject = (agent as { inject?: (message: unknown) => void } | undefined)?.inject;
  if (typeof inject !== "function") return;
  try {
    inject.call(agent, createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "dsh-llm-wiki" },
    }));
  } catch {
    // The owning agent may have been disposed while the job was running.
  }
}

function modelOptions(
  deps: IngestDeps,
  override: { provider: string; id: string } | undefined,
): { provider: string; model: string; maxTokens: number } | undefined {
  const selected = override ?? deps.config.taskModel;
  if (!selected) return undefined;
  return {
    provider: selected.provider,
    model: selected.id,
    maxTokens: deps.config.synthesisMaxTokens ?? 16_384,
  };
}

function buildPrompt(
  deps: IngestDeps,
  args: StartIngestArgs,
): string | undefined {
  const content = args.extracted.slice(0, MAX_EXTRACTED_CHARS);
  if (!content.trim()) return undefined;
  const languageInstruction = deps.config.synthesisLanguage
    ? `\n\nWrite all generated content in ${deps.config.synthesisLanguage}, including titles, headings, summaries, descriptions, and concept/entity names. Only preserve code, API names, file paths, commands, exact technical identifiers, and verbatim quotations in their original form.`
    : "";
  const title = String(args.manifest.title || args.sourceId);
  return [
    INGEST_SYSTEM + languageInstruction,
    `Synthesize this captured source into wiki knowledge by calling commit_synthesis once.`,
    `SOURCE: ${title} (${args.sourceId})`,
    `EXTRACTED CONTENT:\n${content}`,
  ].join("\n\n");
}

function summarize(outcome: Extract<Awaited<ReturnType<typeof commitSynthesis>>, { ok: true }>): string {
  const parts = [
    `✅ Wiki ingest ${outcome.sourceId} complete`,
    `${outcome.entitiesCreated.length} new entities`,
    `${outcome.conceptsCreated.length} new concepts`,
    `${outcome.contradictions} contradiction(s)`,
  ];
  return parts.join(" — ");
}

async function finishIngest(
  activationPromise: Promise<SubagentActivationLike>,
  deps: IngestDeps,
  args: StartIngestArgs,
): Promise<JobOutcomeLike> {
  let activation: SubagentActivationLike | undefined;
  try {
    activation = await activationPromise;
    const result = await activation.result;
    if (result.stopReason !== "completed" || result.structured === undefined) {
      const detail = result.diagnostic ?? `synthesis stopped with ${result.stopReason}`;
      deliver(args.parent, `⚠️ Wiki ingest ${args.sourceId} failed: ${detail}`);
      return { status: "failed", detail };
    }

    const outcome = commitSynthesis(
      args.paths,
      args.sourceId,
      args.manifest,
      result.structured as SynthesisData,
      undefined,
      deps.config.synthesisLanguage,
      deps.config.wikilinkValidation,
    );
    if (!outcome.ok) {
      const detail = outcome.diagnostics[0]?.message ?? "commit failed";
      deliver(args.parent, `⚠️ Wiki ingest ${args.sourceId} failed: ${detail}`);
      return { status: "failed", detail };
    }

    rebuildMetadataLight(args.paths);
    const summary = summarize(outcome);
    deliver(args.parent, summary);
    return { status: "completed", result: summary };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deliver(args.parent, `⚠️ Wiki ingest ${args.sourceId} failed: ${detail}`);
    return { status: "failed", detail };
  } finally {
    try {
      await activation?.dispose();
    } catch {
      // Child teardown is best-effort; the result is already committed/reported.
    }
  }
}

/**
 * Start one source's synthesis child and return as soon as it is published.
 * The returned promise is fully handled: a missing subagent provider returns
 * `ok:false`; a child/provider failure is reported to the parent and reflected
 * in the job outcome.
 */
export async function startIngestSynthesis(
  deps: IngestDeps,
  args: StartIngestArgs,
): Promise<StartIngestResult> {
  const subagents = deps.subagents;
  if (!subagents) return { ok: false, reason: "subagents service unavailable" };

  const prompt = buildPrompt(deps, args);
  if (!prompt) return { ok: false, reason: "empty extracted content" };

  let providers: string[];
  try {
    providers = subagents.list();
  } catch (error) {
    return { ok: false, reason: `subagent providers unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const provider = providers.includes("spawn")
    ? "spawn"
    : providers.find((name) => name === "fork") ?? providers[0];
  if (!provider) return { ok: false, reason: "no subagent provider registered" };

  const controller = new AbortController();
  const parent = args.parent;
  const agentOptions = modelOptions(deps, args.model);
  let activationPromise: Promise<SubagentActivationLike>;
  try {
    activationPromise = subagents.startActivation({
      provider,
      label: `LLM Wiki ingest ${args.sourceId}`,
      request: {
        cwd: deps.cwdFor?.(args.parent) ?? deps.cwd(),
        prompt: [{ type: "text", text: prompt }],
        parent,
        ...(agentOptions ? { agentOptions } : {}),
        outputSchema: COMMIT_OUTPUT_SCHEMA,
      },
      signal: controller.signal,
      delivery: "caller",
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const completion = finishIngest(activationPromise, deps, args);
  let jobId: string | undefined;
  if (deps.jobs) {
    try {
      jobId = deps.jobs.start({
        // JobKindMap is intentionally small in the current Host; the registry
        // itself treats kind as an opaque label, so this extension point stays
        // readable in the job list without changing the engine.
        kind: "llm-wiki-ingest",
        label: `LLM Wiki ingest ${args.sourceId}`,
        owner: agentId(parent),
        run: (job) => {
          void completion.then((outcome) => {
            job.updateProgress?.(outcome.status);
          });
          return {
            done: completion,
            cancel: (reason) => {
              controller.abort(reason);
              void activationPromise.then((activation) => activation.dispose()).catch(() => {});
            },
          };
        },
      });
    } catch {
      // Jobs is optional; the detached promise above still runs and reports.
    }
  }

  return { ok: true, provider, ...(jobId ? { jobId } : {}) };
}
