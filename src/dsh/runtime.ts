import type {
  LaunchCtx,
  ResolveCtx,
  ResolveResult,
} from "../engine/runtime.js";
import type { ExtensionAPI } from "../engine/pi.js";
import { noticesEnabled, type TaskConfig } from "../engine/task-config.js";
import type { JobOutcomeLike, JobsServiceLike } from "./ingest.js";

export type { LaunchCtx, ResolveCtx, ResolveResult };

/**
 * What the dsh adapter hands the runtime at construction.
 *
 * `report` delivers one completed background summary to the user; in phase 2a
 * the index wires it to `agent.inject` for the calling agent (a `wiki-action-
 * report` equivalent). `cwd` resolves the working directory for compat config
 * reads. Both are called off the tool's critical path, so they must not throw.
 */
export interface DshRuntimeDeps {
  config: TaskConfig;
  report(summary: string, opts?: { display?: boolean }): void;
  cwd(): string;
  /** Re-read compat settings for a moved session without losing row config. */
  reload?(cwd: string): TaskConfig;
  /** Optional DSH job registry for indexing/embedding work. */
  jobs?: JobsServiceLike;
}

/**
 * The engine's `Runtime` type is a declared class in engine/runtime.ts; the
 * dsh adapter satisfies the same structural surface here — a real
 * implementation, not the shim's `declare`.
 *
 * Indexing/embedding work uses detached promises here (error-isolated,
 * single-flight per label); the ingest lane uses `ctx.jobs` and `ctx.subagents`.
 * Nothing drains `awaitAll()` yet — the same gap upstream covers with its
 * compaction/shutdown hooks.
 */
export class DshRuntime {
  config: TaskConfig;
  pi?: ExtensionAPI;
  resolveFailureNotified = false;

  private readonly deps: DshRuntimeDeps;
  private readonly inFlightLabels = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: DshRuntimeDeps) {
    this.deps = deps;
    this.config = deps.config;
  }

  ensureConfig(cwd: string): void {
    // The dsh adapter's row config is fixed at apply() time, but a session can
    // move between projects; re-read the compat settings for the new cwd and
    // mutate the shared object so tools and ambient surfaces see the update.
    // Clear first: a key absent in the new project must not inherit the old
    // project's value (e.g. notices:false leaking across a cwd switch).
    if (!this.deps.reload) return;
    try {
      const next = this.deps.reload(cwd);
      const target = this.config as Record<string, unknown>;
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, next);
    } catch {
      // A missing/corrupt settings file must not break a turn; keep last-good.
    }
  }

  isInFlight(label: string): boolean {
    return this.inFlightLabels.has(label);
  }

  get pendingCount(): number {
    return this.inFlight.size;
  }

  async resolveModel(
    ctx: ResolveCtx,
    override?: { provider: string; id: string },
  ): Promise<ResolveResult> {
    let model = ctx.model;

    const configured = this.config.taskModel;
    if (configured) {
      const found = ctx.modelRegistry.find(configured.provider, configured.id);
      if (found) model = found;
    }
    if (override) {
      const found = ctx.modelRegistry.find(override.provider, override.id);
      if (found) model = found;
    }

    if (!model) {
      return {
        ok: false,
        reason: "no model available (session has no model and no taskModel configured)",
      };
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const provider = (model as { provider?: string }).provider ?? "unknown";
      return { ok: false, reason: `no API key for provider "${provider}"` };
    }
    const modelProvider = (model as { provider?: string }).provider;
    const registered = modelProvider
      ? ctx.modelRegistry.getRegisteredProviderConfig?.(modelProvider)
      : undefined;
    const streamFn =
      registered?.streamSimple && registered.api === (model as { api?: string }).api
        ? registered.streamSimple
        : undefined;
    const authedModel = auth.baseUrl ? { ...(model as object), baseUrl: auth.baseUrl } : model;
    return {
      ok: true,
      model: authedModel,
      apiKey: auth.apiKey ?? "",
      headers: auth.headers,
      env: auth.env,
      streamFn,
    };
  }

  launchTask(ctx: LaunchCtx, label: string, work: () => Promise<void>): Promise<void> {
    const existing = this.inFlight.get(label);
    if (existing) return existing;

    const hasUI = ctx.hasUI;
    const ui = ctx.ui;
    const agent = (ctx as { agent?: { id?: string } }).agent;

    this.inFlightLabels.add(label);
    const completion: Promise<JobOutcomeLike> = (async () => {
      try {
        await work();
        return { status: "completed" as const };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (hasUI && ui) ui.notify(`LLM Wiki: ${label} failed: ${msg}`, "warning");
        return { status: "failed" as const, detail: msg };
      } finally {
        this.inFlightLabels.delete(label);
      }
    })();
    const promise = completion.then(() => undefined);
    if (this.deps.jobs) {
      try {
        this.deps.jobs.start({
          kind: "llm-wiki-index",
          label,
          owner: agent?.id,
          run: (job) => {
            job.updateProgress?.("running");
            return {
              done: completion,
              // The underlying engine work does not expose a cancellable
              // signal here; the job can still be marked stopping by the Host.
              cancel: () => {},
            };
          },
        });
      } catch {
        // Jobs is optional; keep the detached work path.
      }
    }
    this.inFlight.set(label, promise);
    void promise.finally(() => {
      if (this.inFlight.get(label) === promise) this.inFlight.delete(label);
    });
    return promise;
  }

  report(summary: string, opts?: { display?: boolean }): void {
    if (!summary) return;
    try {
      this.deps.report(summary, { display: opts?.display ?? noticesEnabled(this.config) });
    } catch {
      // Reporting is best-effort; a torn-down agent must not propagate.
    }
  }

  launchReported(
    ctx: LaunchCtx,
    label: string,
    work: () => Promise<string | null>,
  ): Promise<void> {
    return this.launchTask(ctx, label, async () => {
      const hasUI = ctx.hasUI;
      const ui = ctx.ui;
      const summary = await work();
      if (summary) {
        if (hasUI && ui) ui.notify(summary.split("\n")[0].replace(/\*\*/g, ""), "info");
        this.report(summary);
      }
    });
  }

  async awaitAll(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }
}
