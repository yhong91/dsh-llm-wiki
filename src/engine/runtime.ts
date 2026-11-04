import type { ExtensionAPI } from "./pi.js";
import type { TaskConfig } from "./task-config.js";

/**
 * Type-only shim for upstream `./runtime.js`: only the declarations the
 * vendored engine imports, with their original signatures. The launch/report
 * implementation ships with the dsh background lane.
 */

export type ResolveResult =
  | {
      ok: true;
      model: unknown;
      apiKey: string;
      headers?: Record<string, string | null>;
      /**
       * Stream function for the model's API (issue #222): the provider's own
       * `streamSimple` when the model belongs to an extension-registered
       * provider whose api the host SDK's default stream path cannot resolve.
       */
      streamFn?: unknown;
      /** Provider-scoped env from auth resolution (pi >= 0.85). */
      env?: Record<string, string>;
    }
  | { ok: false; reason: string };

type NotifyLevel = "info" | "warning" | "error";
type Notify = (message: string, type?: NotifyLevel) => void;

export interface ResolveCtx {
  /** Current session model (may be undefined when the session has no model). */
  model: unknown;
  modelRegistry: {
    find(provider: string, id: string): unknown;
    getApiKeyAndHeaders(model: unknown): Promise<{
      ok: boolean;
      apiKey?: string;
      headers?: Record<string, string | null>;
      /** Auth-provided endpoint redirect (pi >= 0.85); beats the catalogue baseUrl. */
      baseUrl?: string;
      /** Provider-scoped env values (pi >= 0.85); must reach the stream options. */
      env?: Record<string, string>;
    }>;
    /**
     * Registered extension provider config (issue #222). Optional: older pi
     * has no such method (it registers provider streamSimples directly into
     * the model SDK's registry instead), in which case the default stream path
     * is used.
     */
    getRegisteredProviderConfig?(
      provider: string,
    ): { api?: string; streamSimple?: unknown } | undefined;
  };
  hasUI: boolean;
  ui?: { notify: Notify };
}

export interface LaunchCtx {
  hasUI: boolean;
  ui?: { notify: Notify };
}

export declare class Runtime {
  config: TaskConfig;

  /**
   * Extension API handle, attached at registration. Used by `report()` to emit
   * visible completion messages for background actions (issue #77). Optional so
   * the Runtime stays unit-testable without a live `pi`.
   */
  pi?: ExtensionAPI;

  /** Whether we've already surfaced a model-resolution failure (avoid spam). */
  resolveFailureNotified: boolean;

  ensureConfig(cwd: string): void;

  /** True if a task with this label is currently running. */
  isInFlight(label: string): boolean;

  /** Number of background tasks currently running. */
  get pendingCount(): number;

  /**
   * Resolve the model + auth for background work.
   *
   * Precedence (issue #69): per-call `override` → configured `taskModel` →
   * session model. Each configured layer is applied only when the model is
   * found in the registry; a missing layer warns (when UI is available) and
   * falls through to the next. Returns { ok: false } when nothing resolves or
   * no API key exists, so callers can fall back to the synchronous
   * main-agent path.
   */
  resolveModel(
    ctx: ResolveCtx,
    override?: { provider: string; id: string },
  ): Promise<ResolveResult>;

  /**
   * Fire-and-forget a background task.
   *
   * The work runs in a detached promise so the caller (an agent hook/tool)
   * is never blocked. Errors are caught and surfaced via the UI (when
   * available) instead of crashing the agent. Single-flight per label: if a
   * task with the same label is already running, the new request is dropped
   * and the existing promise is returned.
   *
   * The returned promise resolves when the work completes; hold onto it (or
   * call awaitAll) to drain background work before compaction/exit.
   */
  launchTask(ctx: LaunchCtx, label: string, work: () => Promise<void>): Promise<void>;

  /**
   * Report a completed background action to the user (issue #77).
   *
   * Every mutating wiki action runs off the agent's critical path; this is how
   * the work becomes visible. Emits a `wiki-action-report` custom message,
   * shown in the UI when notices are enabled (the `notices` config, default
   * on) and otherwise injected silently. Delivered as `nextTurn` so it never
   * interrupts or triggers a turn. Never throws — reporting must not crash the
   * background task that called it.
   */
  report(summary: string, opts?: { display?: boolean }): void;

  /**
   * Run a mutating action in the background and report its result (issue #77).
   *
   * Thin wrapper over `launchTask`: `work` performs the off-thread mutation and
   * returns a one-line human summary (or null to stay silent). On success the
   * summary is surfaced via `report()`. Single-flight, error-isolated, and
   * awaited-at-exit exactly like `launchTask`.
   */
  launchReported(ctx: LaunchCtx, label: string, work: () => Promise<string | null>): Promise<void>;

  /**
   * Await all in-flight background tasks. Call at compaction / session exit so
   * background work is not lost. Never rejects — task errors are already
   * isolated inside launchTask.
   */
  awaitAll(): Promise<void>;
}
