/**
 * dsh-llm-wiki — Karpathy-style LLM Wiki for DeepSeek Harness.
 *
 * The knowledge engine under src/engine/ is vendored from
 * @zosmaai/pi-llm-wiki (MIT) and reads/writes the same .llm-wiki (okf-0.2)
 * vaults as the pi and Claude Code plugins. This phase registers the full
 * interactive surface over a shared background runtime: the 15 request-driven
 * wiki tools, ambient recall (static status footer + session notice +
 * per-turn recall), vault-ownership guardrails, the 12 wiki-* commands with the
 * bundled skill, and the background ingest synthesis lane over DSH subagents
 * and jobs.
 */

import type { Context } from "@deepseek-ai/cordis";
import { registerAmbient } from "./dsh/ambient.js";
import { buildTrajectoryToolDefinitions } from "./dsh/trajectory.js";
import { Config, mergeTaskConfig } from "./dsh/config.js";
import { registerCommands } from "./dsh/commands.js";
import { registerDashboardRoute } from "./dsh/dashboard.js";
import { createExecApi } from "./dsh/exec.js";
import { registerGuardrails } from "./dsh/guardrails.js";
import { DshRuntime } from "./dsh/runtime.js";
import type { JobsServiceLike, SubagentsServiceLike } from "./dsh/ingest.js";
import { registerSkill } from "./dsh/skill.js";
import type { ReminderStates, SessionReminderState } from "./dsh/reminder.js";
import { buildWikiToolDefinitions } from "./dsh/tools.js";
import { loadTaskConfig, trajectoriesEnabled } from "./engine/task-config.js";

// Export the Schemastery schema so the Host can validate a patch row's
// `config:` before activation and surface it through Config.listConfigs.
// The same identifier remains available locally for default materialization.
export { Config } from "./dsh/config.js";

export const name = "@yhong91/dsh-llm-wiki";

// systemPrompt joined for the ambient status footer section; commands self-defer
// through ctx.inject(["commands"], ...) because that service is optional in
// some mount trees, and agent events need no service injection.
export const inject = ["tools", "systemPrompt"];

export function apply(ctx: Context, config: Partial<Config> | undefined) {
  // The engine's host detection prefers a ~/.pi agent dir when one exists on
  // the machine; pin the dsh host so settings resolution reads .dsh/ rows and
  // ambient defaults resolve correctly. Only set when unset so tests and
  // exotic embeddings can still override.
  process.env.LLM_WIKI_HOST ??= "dsh";

  // DSH owns one effective directory per Session. process.cwd() is only the
  // Host process directory and does not follow working_directory changes, so
  // every per-agent path starts from ctx.workingDirectory. The service is
  // optional; minimal profiles/dev tests fall back to the process directory.
  const serviceLookup = ctx as Context & { get(name: string): unknown };
  const workingDirectory = () =>
    serviceLookup.get("workingDirectory") as
      | { get(session: unknown): string; defaultDirectory?: string }
      | undefined;
  const cwdFor = (agent?: unknown): string => {
    try {
      const session = (agent as { session?: unknown } | undefined)?.session;
      const service = workingDirectory();
      if (session && service) {
        const dir = service.get(session);
        if (typeof dir === "string" && dir.trim()) return dir;
      }
      const headerCwd = (session as { header?: { cwd?: string } } | undefined)?.header?.cwd;
      if (typeof headerCwd === "string" && headerCwd.trim()) return headerCwd;
      return service?.defaultDirectory ?? process.cwd();
    } catch {
      return process.cwd();
    }
  };
  const cwd = () => cwdFor();

  // The host hands an omitted row config through WITHOUT materializing the
  // Schemastery defaults (verified on 0.2.1-rc.5: an inserted row with no
  // config yields undefined fields), so validate through the schema first —
  // that is where the defaults live, including the personal-ambient-ON
  // decision. Invalid config fails the plugin loudly instead of silently
  // downgrading the gates. Keep the raw row object too: mergeTaskConfig must
  // only let explicitly supplied keys win over the .pi/.omp compat read.
  const rawConfig = (config ?? {}) as Partial<Config>;
  const merged = mergeTaskConfig(
    Config(rawConfig),
    loadTaskConfig(cwd()),
    rawConfig,
  );

  // Generic background-runtime reports have no agent handle at apply() time;
  // the ingest lane reports to its calling agent directly via agent.inject.
  const report = (summary: string, _opts?: { display?: boolean }) => {
    void summary;
  };

  // Optional phase-3 services. Both are self-deferred: a minimal profile
  // without them keeps the synchronous fallback documented by wiki_ingest.
  const subagents = serviceLookup.get("subagents") as SubagentsServiceLike | undefined;
  const jobs = serviceLookup.get("jobs") as JobsServiceLike | undefined;

  const runtime = new DshRuntime({
    config: merged,
    report,
    cwd,
    reload: (nextCwd) =>
      mergeTaskConfig(Config(rawConfig), loadTaskConfig(nextCwd), rawConfig),
    jobs,
  });
  const execApi = createExecApi(
    serviceLookup.get("subprocess") as Parameters<typeof createExecApi>[0] | undefined,
  );

  const reminderStates: ReminderStates = new Map<string, SessionReminderState>();

  const deps = {
    cwd,
    cwdFor,
    config: merged,
    runtime,
    execApi,
    report,
    subagents,
    jobs,
    reminderStates,
  };

  for (const tool of buildWikiToolDefinitions(deps)) {
    ctx.tools.register(tool);
  }

  // Opt-in agent-trajectory working memory (upstream issue #80): the three
  // trajectory tools exist only when `trajectories: true`, matching Pi where
  // they are never registered while the flag is off.
  if (trajectoriesEnabled(merged)) {
    for (const tool of buildTrajectoryToolDefinitions({ cwd, cwdFor })) {
      ctx.tools.register(tool);
    }
  }

  // Expose the packaged `llm-wiki` skill through the optional skills service.
  // This is a self-deferred registration, so profiles without `skills` still
  // load the tools and ambient surfaces.
  registerSkill(ctx);

  // Read-only Web dashboard data route; the client half registers the panel.
  registerDashboardRoute(ctx);

  // Ambient surfaces: static wiki-status footer (systemPrompt section),
  // session-start notice/auto-bootstrap (agent/created), and per-turn recall
  // (agent/pre-step admission). Fail-silent by construction; see ambient.ts.
  registerAmbient(ctx, deps);

  // Drain in-flight background work (index rebuilds, embeddings) when the
  // plugin unloads, bounded so teardown stays prompt. Mirrors upstream's
  // session_shutdown drain; disposers may be async and unload awaits them.
  ctx.effect(
    () => async () => {
      await Promise.race([
        runtime.awaitAll(),
        new Promise<void>((resolve) => setTimeout(resolve, 1_900).unref?.()),
      ]).catch(() => undefined);
    },
    "llm-wiki: drain background work",
  );

  // Vault-ownership guardrails: monotonic deny over write/edit/bash/pwsh
  // targets inside any resolved vault's protected paths, plus the dirty-track
  // reindex drain over the shared runtime. See guardrails.ts.
  registerGuardrails(ctx, { cwd, cwdFor, runtime });

  // The 12 wiki-* prompt-template commands, self-deferred onto the optional
  // `commands` service; handlers steer the rendered template into the agent.
  registerCommands(ctx, {
    cwd: (agent) => cwdFor(agent),
    warn: (message) =>
      (ctx as Context & { logger?: { warn(text: string, ...args: unknown[]): void } }).logger?.warn(
        "@yhong91/dsh-llm-wiki: %s",
        message,
      ),
  });
}
