import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// MessageSourceMap is merge-extensible: each producer declares its own kind
// in its own module (notes/dsh-plugin-capabilities.md "Message injection" —
// session format V4 rejects the legacy `{kind:'plugin', plugin}` wrapper, so
// the plugin names itself directly). Session-start notices and per-turn
// recall context both carry this kind.
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "dsh-llm-wiki": {
      kind: "dsh-llm-wiki";
    };
  }
}
import { bootstrapVault } from "../engine/bootstrap.js";
import { appendCall } from "../engine/call-log.js";
import { WIKI_STATUS_BLOCK } from "../engine/inject.js";
import { buildReminderText, buildSessionNotice } from "../engine/observation.js";
import {
  formatRecallContext,
  searchWikiHybrid,
  shouldUseLinksFirst,
  vaultPageCount,
} from "../engine/recall.js";
import { recoverQmdIndex } from "../engine/qmd-indexing.js";
import type { Runtime } from "../engine/runtime.js";
import {
  autoRecallEnabled,
  noticesEnabled,
  personalVaultIsAmbient,
} from "../engine/task-config.js";
import {
  migrateDoubledPersonalVault,
  resolveProjectVaultRoot,
  resolveVaultPaths,
} from "../engine/utils.js";
import { inspectWritableVault } from "../engine/vault-format.js";
import {
  reminderStateFor,
  sessionKeyOf,
  type ReminderStates,
} from "./reminder.js";

/**
 * Ambient recall — the dsh port of upstream pi-llm-wiki's two ambient surfaces
 * (`session_start` + `before_agent_start` in reference/pi-llm-wiki
 * extensions/llm-wiki/index.ts).
 *
 * The cache-safety contract (upstream issues #87/#92, see
 * notes/pi-llm-wiki-architecture.md "Cache-safe injection"):
 *
 *  - STATIC wiki-status footer → the system prompt. Registered once as a
 *    `ctx.systemPrompt.section` — the direct dsh equivalent per
 *    notes/dsh-plugin-capabilities.md's mapping table row "static
 *    <wiki_status> footer in system prompt → ctx.systemPrompt.section". A
 *    registered section renders exactly once per assembly, so the #87
 *    stacking bug (naive re-append on retried turns) is unrepresentable:
 *    there is no string to append to twice.
 *  - VOLATILE per-turn recall → never the system prompt. It rides the
 *    `agent/pre-step` waterfall's message admission: the payload's
 *    `messages` are the inbox batch about to enter this step, so we read the
 *    user's prompt from it, run the engine's layered recall, and admit the
 *    batch plus one appended context `UserMessage`. The mapping table's row
 *    "before_agent_start prompt read + recall → agent/pre-step (waterfall
 *    over admitted messages)" is this path.
 *
 *    `agent.inject` was considered and rejected as the primary channel: it
 *    queues context for the NEXT step boundary, so recall keyed on the
 *    user's prompt would reach the model one step late — and never at all
 *    when the user message is the last thing the turn needed. pre-step
 *    admission lands the recall block in the same request that reads the
 *    prompt it was computed from, matching pi's tail-message semantics.
 *    (Inject stays the right channel for the session-start notice, which is
 *    turn-independent and only needs "before the next model request".)
 *
 * Everything here is fail-silent in both directions: a pre-step listener
 * that throws would break the agent loop, and an agent/created throw fails
 * creation — so every handler catches its own work and admits the step
 * unchanged. No-vault is a quiet no-op, identical to tools.ts's fail-closed
 * posture.
 */

/** The dsh-side contract registerAmbient needs from index.ts. */
export interface AmbientDeps {
  /**
   * Resolve the working directory ambient surfaces apply to. Upstream reads
   * `process.cwd()` per turn because the session can move; the deps indirection
   * keeps tests off the real cwd and lets index.ts later swap in the agent's
   * `workingDirectory` service without touching this module.
   */
  cwd(): string;
  /** Optional per-agent session directory resolver (DSH workingDirectory). */
  cwdFor?(agent?: unknown): string;
  /** Merged llm-wiki config (same object the tools share). */
  config: Runtime["config"];
  /** Shared background runtime (config source for recall/search). */
  runtime: Runtime;
  /** Per-Session observe/retro reminder state (optional in tests). */
  reminderStates?: ReminderStates;
}

/**
 * One freshly admitted user message's text, or "" when the step's batch is
 * not a user turn worth recalling on (steering, tool follow-ups, injected
 * context). Only `source.kind === "user"` counts as the user's own prompt —
 * injected plugin context must never re-trigger recall or it would compound.
 */
function promptTextFrom(messages: readonly { role?: string; source?: { kind?: string }; content?: unknown }[]): string {
  for (const message of messages) {
    if (message?.source?.kind !== "user") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * The upstream ambient gate (index.ts:102): ambient surfaces speak only
 * where a wiki applies — a project vault resolved by walk-up, or the
 * personal vault when `ambientPersonalVault` allows it. Resolved per call,
 * not once at registration, because cwd changes within a session.
 */
function wikiAppliesTo(cwd: string, deps: AmbientDeps): boolean {
  return (
    resolveProjectVaultRoot(cwd) !== null ||
    personalVaultIsAmbient(deps.runtime.config)
  );
}

/** Ambient surfaces are for user-facing sessions, not delegated children. */
function isSubagent(agent: unknown): boolean {
  const header = (agent as { session?: { header?: { origin?: string; parentSession?: unknown } } } | undefined)
    ?.session?.header;
  return header?.origin === "subagent" || header?.parentSession !== undefined;
}

function sessionKey(agent: unknown): string | undefined {
  const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof id === "string" ? id : undefined;
}

export function registerAmbient(ctx: Context, deps: AmbientDeps): void {
  // ── 1. Static wiki-status footer (cache-safe; issues #87/#92) ────────
  // The footer is identical for every agent and every turn, so it belongs in
  // the system prompt — the provider's primary cache prefix — where it rides
  // the cached head instead of paying per-turn message churn. Order 9000 sits
  // after the tool guidance block range (TOOLS_SDK = 5000) and before the
  // deployment persona suffix range (~10200); the exact slot is cosmetic as
  // long as it is late and stable.
  //
  // `interpolate: false`: the footer text is literal; leaving interpolation on
  // would let a stray `{{…}}` in the block throw strict renderPrompt errors.
  // The provider receives the assembling Agent as `context.scope`, so omit the
  // footer for delegated children and for directories where no wiki applies.
  ctx.systemPrompt.section({
    name: "llm-wiki:status",
    order: 9000,
    text: (context) => {
      const agent = context.scope as unknown;
      if (isSubagent(agent)) return "";
      const cwd = deps.cwdFor?.(agent) ?? deps.cwd();
      return wikiAppliesTo(cwd, deps) ? WIKI_STATUS_BLOCK : "";
    },
    interpolate: false,
  });

  // ── 2. Session-start ambient setup (upstream session_start) ───────────
  // agent/created is the verified session-start signal (serial; 'compact'
  // doubles as the compaction signal). Everything upstream did that still
  // makes sense on dsh is ported; pi-only surfaces (ctx.ui.setStatus status
  // bar, QMD recovery) have no dsh counterpart in this phase.
  const needsTopicInference = new Set<string>();
  ctx.on("agent/disposed", ({ agent }) => {
    const key = sessionKey(agent);
    if (key) {
      needsTopicInference.delete(key);
      deps.reminderStates?.delete(key);
    }
  });
  ctx.on("agent/created", async ({ agent, source }) => {
    // Upstream's session_start has no source distinction: every session gets
    // the same migration → gate → bootstrap-or-notice path, and all of it is
    // idempotent. dsh splits the signal into startup/resume/clear/compact;
    // the only one worth handling differently is 'compact', where the vault
    // state mid-session is already established — re-announcing the session
    // notice after a compaction is still correct (it re-tells the model the
    // loop exists after context loss), but auto-BOOTSTRAPPING a fresh vault
    // on a compacted session would be surprising, so that one path is gated
    // on a non-compact source.
    const isCompact = source === "compact";

    // Delegated children inherit the task context, not the user's ambient
    // memory surface; skip notices/recall for them.
    if (isSubagent(agent)) return;

    // A new/clear/resume Session starts a fresh reminder cadence. Compaction
    // keeps the existing state, matching Pi's session_compact behavior.
    const reminderKey = sessionKeyOf(agent);
    if (reminderKey && source !== "compact" && deps.reminderStates) {
      const existing = deps.reminderStates.get(reminderKey);
      deps.reminderStates.set(reminderKey, {
        observeDone: existing?.observeDone ?? false,
        turns: 0,
      });
    }

    // The whole body is one boundary: agent/created is serial, so anything
    // that escapes fails agent creation. Gate the ambient work behind a
    // single guard that can only silence, never propagate.
    try {
      const cwd = deps.cwdFor?.(agent) ?? deps.cwd();

      // One-shot repair of the historical doubled ~/.llm-wiki/.llm-wiki
      // layout. Deliberately not silenced by notices (upstream:
      // data-integrity signal).
      try {
        migrateDoubledPersonalVault();
      } catch {
        // Non-fatal: a failed repair must not fail agent creation.
      }

      if (!wikiAppliesTo(cwd, deps)) return;

      const paths = resolveVaultPaths(cwd);
      if (!isCompact && !existsSync(join(paths.dotWiki, "config.json"))) {
        // Silent auto-bootstrap, mirroring upstream: topic/mode are inferred
        // from the user's first prompt (see the pre-step hook below) rather
        // than blocking session start on a UI question that doesn't exist
        // here.
        let result: ReturnType<typeof bootstrapVault>;
        try {
          result = bootstrapVault(paths, { topic: "pending", mode: "personal" });
        } catch {
          return; // fail-silent: a vault we couldn't create must not kill the agent
        }
        if (!result.ok || !result.projection.ok) return;
        const key = sessionKey(agent);
        if (key) needsTopicInference.add(key);
        return;
      }

      if (!inspectWritableVault(paths).ok) return;
    } catch {
      return;
    }

    // Fire-and-forget QMD index recovery (upstream session_start): repairs an
    // interrupted index swap only. It never blocks the first turn, and a
    // failure is swallowed so it cannot fail agent creation.
    if (!isCompact) {
      try {
        const recoveryRoot = resolveVaultPaths(deps.cwdFor?.(agent) ?? deps.cwd());
        void deps.runtime
          .launchTask({ hasUI: false }, `qmd-recovery:${recoveryRoot.root}`, async () => {
            await recoverQmdIndex(recoveryRoot);
          })
          .catch(() => {});
      } catch {
        // Recovery is best-effort.
      }
    }

    // One-time session notice announcing the wiki loop (upstream issue #77).
    // Delivered via agent.inject: persisted context admitted before the next
    // model request, not a wakeup — the dsh shape of pi's
    // sendMessage({display:true}, {deliverAs:"nextTurn"}). `notices` gates
    // user-visible chatter; inject carries no display flag because dsh
    // renders source kinds, not per-message visibility.
    if (noticesEnabled(deps.runtime.config)) {
      try {
        agent.inject(
          createUserMessage({
            content: [{ type: "text", text: buildSessionNotice() }],
            source: { kind: "dsh-llm-wiki" },
          }),
        );
      } catch {
        // A disposed or read-only agent must not propagate out of the hook.
      }
    }
  });

  // ── 3. Per-turn volatile recall (upstream before_agent_start) ─────────
  // The waterfall listener runs for EVERY proposed step — user turns, tool
  // follow-ups, steering. Only the step that admits a fresh user prompt gets
  // recall; everything else passes through untouched. The listener must never
  // throw: a rejected promise vetoes the step and stalls the agent loop.
  ctx.on("agent/pre-step", async (payload, next) => {
    // The waterfall contract allows exactly one next() call per listener.
    // Track its consumption so the failure path can distinguish "pass the
    // step through now" from "the chain already decided".
    let consumed = false;
    let decision: Awaited<ReturnType<typeof next>> | undefined;
    const admit = async () => {
      consumed = true;
      decision = await next();
      return decision;
    };
    try {
      if (isSubagent(payload.agent)) return await admit();
      const cwd = deps.cwdFor?.(payload.agent) ?? deps.cwd();
      if (!wikiAppliesTo(cwd, deps)) return await admit();

      const prompt = promptTextFrom(payload.messages as never[]);
      const blocks: string[] = [];

      // Pi's periodic observe/retro reminder: count user turns and surface a
      // capture prompt every fifth turn until wiki_observe has run. It rides
      // the same volatile admission lane as recall, never the system prompt.
      if (prompt && noticesEnabled(deps.runtime.config)) {
        const state = reminderStateFor(deps.reminderStates, payload.agent);
        if (state) {
          state.turns += 1;
          if (state.turns >= 5 && !state.observeDone) {
            blocks.push(buildReminderText());
            // Pi resets the interval after queueing; without it the count
            // stays >= 5 and the reminder repeats every turn.
            state.turns = 0;
          }
        }
      }

      // One-time topic-inference directive after a just-created vault
      // (upstream lines 277-308). Volatile — same message lane as recall.
      const topicKey = sessionKey(payload.agent);
      if (topicKey && needsTopicInference.has(topicKey) && prompt) {
        needsTopicInference.delete(topicKey);
        const dirName = basename(cwd);
        let hints = `Project directory: "${dirName}" (path: ${cwd})`;
        try {
          const pkg = JSON.parse(
            readFileSync(join(cwd, "package.json"), "utf-8"),
          ) as { name?: string; version?: string; description?: string };
          hints += `\nPackage: ${pkg.name || "unknown"} v${pkg.version || "?"}`;
          if (pkg.description) hints += `\nDescription: ${pkg.description}`;
        } catch {
          // No package.json or unreadable — directory name alone is the hint.
        }
        blocks.push(`## Wiki Setup Required
The LLM Wiki was just auto-created but needs its topic and mode configured. Before responding to the user, analyze their prompt and this project's context to infer:
- **topic**: What is this wiki about? (e.g. "React app", "personal notes", "startup finances")
- **mode**: "personal" or "company" based on whether this looks like work or personal use

Project context hints:
${hints}

Then call wiki_bootstrap with the inferred topic and mode to finalize the setup. This is a one-time step.`);
      }

      if (prompt && autoRecallEnabled(deps.runtime.config)) {
        const paths = resolveVaultPaths(cwd);
        if (existsSync(join(paths.dotWiki, "config.json"))) {
          // Upstream auto-injection scope: project vault only, minScore=5 to
          // kill body-only noise, hybrid (single cached query embedding).
          // includePersonal=false — the personal vault is cross-project and
          // would pollute unrelated sessions; explicit wiki_recall stays
          // layered. (See reference index.ts:310-326.)
          // Upstream calls runtime.ensureConfig(cwd) before the search so a
          // moved session re-reads project settings first. DshRuntime now
          // refreshes its shared config object from that cwd.
          deps.runtime.ensureConfig(cwd);
          const startedAt = Date.now();
          const results = await searchWikiHybrid(paths, prompt, 3, 5, false, {
            config: deps.runtime.config,
          });
          appendCall(paths, {
            tool: "auto-recall",
            query: prompt.slice(0, 200),
            hits: results.length,
            ms: Date.now() - startedAt,
          });
          if (results.length > 0) {
            // Two-stage gate (issue #68): large vaults inject ranked links.
            const linksOnly = shouldUseLinksFirst(
              vaultPageCount(paths, false),
              deps.runtime.config,
            );
            const recallContext = formatRecallContext(results, {
              linksOnly,
              skillInlineMax: deps.runtime.config?.recallSkillInlineMax,
            });
            if (recallContext) blocks.push(recallContext);
          }
        }
      }

      if (blocks.length === 0) return await admit();

      // Compute the volatile content BEFORE calling next(): the waterfall
      // contract allows exactly one next() call per listener, so anything
      // that can throw (vault I/O, recall) must finish first. Then a single
      // next() admits the batch plus one appended user-role message — the
      // dsh shape of upstream's {customType:"wiki-recall-context",
      // display:false} tail message: same tail position, same cache contract
      // (zero volatile bytes in the system prompt). `source.kind` declares
      // the producer per the merge-extensible MessageSourceMap contract;
      // `form:"recall"` marks it as lifted-from-elsewhere context for
      // consumers that render forms.
      const admitted = await admit();
      if (admitted.kind !== "enter") return admitted;
      return {
        kind: "enter",
        messages: [
          ...admitted.messages,
          createUserMessage({
            content: [
              {
                type: "text",
                text: `<wiki-recall-context>\n${blocks.join("\n\n")}\n</wiki-recall-context>`,
              },
            ],
            source: { kind: "dsh-llm-wiki", form: "recall" },
          }),
        ],
        ...(admitted.startsRequestSeries
          ? { startsRequestSeries: true as const }
          : {}),
      };
    } catch {
      // Fail-open for the loop (fail-closed for the vault): a broken recall
      // must never veto a user step. If the chain already produced a
      // decision, admit it unchanged; if next() was never consumed, consume
      // it now so the step passes through. Only a failing pass-through
      // itself falls back to the explicit reject as the last resort.
      if (decision !== undefined) return decision;
      if (!consumed) {
        try {
          return await admit();
        } catch {
          // The chain itself is broken; nothing better remains.
        }
      }
      return { kind: "reject" } as const;
    }
  });
}
