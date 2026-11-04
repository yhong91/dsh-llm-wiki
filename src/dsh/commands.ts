import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { loadTaskConfig, persistTrajectoriesEnabled, trajectoriesEnabled } from "../engine/task-config.js";

/**
 * The 12 user-facing wiki commands, ported from pi-llm-wiki's prompts/*.md
 * (upstream v0.6.3, mirrored byte-identically to commands/*.md for omp).
 *
 * dsh commands execute in the UI command plane: no model turn is created
 * automatically, so each handler owns the model-visible effect by steering
 * the rendered template into the receiving agent. This is the verified
 * pattern from @deepseek-ai/dsh-plan-mode: `agent.steer(createUserMessage({
 * content: [{type:'text',text}], source:{kind:'user'} }))` — steering wakes an
 * idle driver or lands at the next step boundary of a running one.
 *
 * The `commands` service is optional in the mount tree (headless profiles may
 * lack it), so registration goes through `ctx.inject(["commands"], ...)`
 * rather than the plugin-level inject array — the plugin boots cleanly with
 * or without the command surface.
 */

/** Minimal shape of a command registration, matching dsh-commands 0.2.1-rc.5. */
export interface CommandDefinition {
  name: string;
  description: string;
  input?: { hint: string; attachments?: boolean };
  recordInput?: boolean;
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}

/** Invocation payload delivered to a command handler by the commands service. */
export interface CommandInvocation {
  commandId: string;
  agent: AgentLike;
  rawInput: string;
  attachments: readonly unknown[];
  signal: AbortSignal;
}

/** The Agent surface command handlers need (subset of @deepseek-ai/dsh-agent). */
export interface AgentLike {
  steer(message: unknown): void;
}

/** Settled result a handler returns to the commands adapter. */
export type CommandResult =
  | { kind: "success"; text?: string; sourceEventSeq?: number }
  | { kind: "error"; text: string };

/** The `commands` service surface `registerCommands` consumes. */
export interface CommandsService {
  register(definition: CommandDefinition): unknown;
}

/**
 * Dependencies the command registrations close over. `ctx` is captured
 * directly so the `commands` service can be resolved lazily inside
 * `ctx.inject` — the service may mount after this plugin's `apply` runs.
 */
export interface CommandDeps {
  /** Log a diagnostic when a command cannot reach the model (no agent, etc.). */
  warn?(message: string): void;
  /** Working directory for project-scoped settings (the invoking agent's cwd). */
  cwd?(agent?: unknown): string;
}

/** The rendered template delivered to the model for one command. */
export interface CommandTemplate {
  name: string;
  description: string;
  /** Argument hint shown by command discovery; empty string when the command takes no input. */
  hint: string;
  /** Prompt body with `$ARGUMENTS` where the raw input lands. */
  body: string;
}

/**
 * Render a template for dispatch: substitute `$ARGUMENTS` with the raw
 * command input (or "(none)" when empty), and point skill references at the
 * bundled dsh skill rather than pi's `.pi/skills/` path.
 */
export function renderTemplate(template: CommandTemplate, rawInput: string): string {
  const args = rawInput.trim() || "(none provided)";
  const text = template.body.split("$ARGUMENTS").join(args);
  return [
    `The user invoked /${template.name}${args === "(none provided)" ? "" : ` ${args}`}.`,
    "Carry out these instructions using the registered wiki_* tools.",
    "",
    text,
  ].join("\n");
}

/**
 * Build the message handed to `agent.steer`. Uses `createUserMessage` so the
 * routed message carries a stable identity and survives the session log the
 * same way a real user prompt does (the plan-mode producer pattern).
 */
export function buildSteerMessage(text: string): unknown {
  return createUserMessage({
    content: [{ type: "text" as const, text }],
    source: { kind: "user" },
  });
}

/**
 * The command registry: name → template. Descriptions mirror the pi
 * `description:` frontmatter verbatim; hints mirror `argument-hint:`.
 * Bodies are the prompt markdown with the pi-only frontmatter stripped and
 * the `.pi/skills/` read path rewritten to the bundled dsh skill.
 */
export const COMMAND_TEMPLATES: CommandTemplate[] = [
  {
    name: "wiki-init",
    description:
      "Initialize a new LLM Wiki in the current directory. Creates the full directory structure, config, and template files.",
    hint: "<topic> [--mode personal|company]",
    body: `# /wiki-init

Initialize a new LLM Wiki vault using the \`wiki_bootstrap\` tool.

## User Arguments

$ARGUMENTS

## Steps

1. If the user provided a topic in \`$ARGUMENTS\`, use it. Otherwise, ask the user for the wiki **topic**.
2. Determine mode: default to \`personal\`; use \`company\` if the user specifies \`--mode company\` or requests it.
3. Call \`wiki_bootstrap(topic=<topic>, mode=<mode>)\` to create the vault.
4. Report the result and suggest next steps:
   - "Use \`wiki_capture_source\` to add your first source (URL, file, or text)."
   - "Run \`/wiki-ingest\` after capturing sources to synthesize them into knowledge pages."

**Do NOT manually create directories or files.** The \`wiki_bootstrap\` tool handles all scaffolding including:
- \`.llm-wiki/raw/sources/\` — immutable source packets
- \`.llm-wiki/wiki/\` — editable knowledge pages
- \`.llm-wiki/meta/\` — auto-generated metadata
- \`.llm-wiki/config.json\` — vault configuration
- \`.llm-wiki/WIKI_SCHEMA.md\` — operating rules`,
  },
  {
    name: "wiki-status",
    description:
      "Show wiki health overview — source count, page stats, orphan count, last activity dates.",
    hint: "",
    body: `# /wiki-status

Show a quick overview of wiki health and statistics.

## Steps

1. Call \`wiki_status()\` to get the current wiki health report.
2. Present the results to the user.
3. If health shows warnings (orphans > 5, many gaps), suggest running \`/wiki-lint\` for a detailed analysis.`,
  },
  {
    name: "wiki-query",
    description:
      "Ask questions against the wiki. Synthesizes answers from wiki pages with cross-reference citations.",
    hint: "<question>",
    body: `# /wiki-query

Ask a question and get an answer synthesized from wiki content.

## User Question

$ARGUMENTS

## Steps

1. Call \`wiki_recall(query=<question>)\` to find relevant wiki pages.
2. Read the full content of each matching page using the \`read\` tool.
3. Synthesize an answer with \`[[wikilink]]\` citations to specific wiki pages.
4. If the answer reveals a new connection or analysis worth preserving:
   - Call \`wiki_ensure_page(type=synthesis, title=<title>, content=<content>)\` to save it
5. Call \`wiki_log_event(kind=query, details={question: <question>})\` to log the query.

**Rules:**
- Answer ONLY from wiki content, not from general knowledge.
- If the wiki lacks information, say so clearly and suggest what sources would help fill the gap.

**Example:**

\`\`\`
/wiki-query What are the key differences between RAG and LLM Wiki?
→ Calls wiki_recall(query="RAG LLM Wiki differences")
→ Reads matching pages
→ Synthesizes a comparison with [[wikilink]] citations
→ Saves as synthesis page via wiki_ensure_page(type=synthesis, ...)
\`\`\``,
  },
  {
    name: "wiki-ingest",
    description:
      "Process new source packets and synthesize them into wiki knowledge pages.",
    hint: "[source_id]",
    body: `# /wiki-ingest

Process uningested source packets and synthesize them into wiki knowledge pages.

## User Arguments

$ARGUMENTS

## Steps

1. Call \`wiki_ingest(source_id=<id if provided>, batch_size=3)\`.
2. If the tool reports "All sources ingested", inform the user and stop.
3. **If the tool reports it is ingesting in the background**, the synthesis sub-agent is handling those sources on the configured task model. Do NOT synthesize them yourself — just report which sources were dispatched and stop. (You'll be notified as each completes.)
4. **Otherwise** (the tool returned extracted content — background unavailable or \`background=false\`), for each source in the returned batch:
   a. Read the extracted text from \`.llm-wiki/raw/sources/<SOURCE_ID>/extracted.md\`
   b. Update the skeleton source page in \`wiki/sources/\` with a proper summary, key entities, and concepts
   c. Use \`wiki_ensure_page(type=entity, title=<name>)\` for each new entity (people, orgs, tools, products)
   d. Use \`wiki_ensure_page(type=concept, title=<name>)\` for each new concept (ideas, patterns, frameworks)
   e. Add \`[[wikilinks]]\` cross-references between related pages
   f. Flag any contradictions with existing wiki content using \`⚠️ **Contradiction**\` markers
5. After processing a synchronous batch, call \`wiki_rebuild_meta\` to update metadata.
6. Report: "Ingested [N] sources → [M] pages created/updated. [X] contradictions flagged."

> **Background vs synchronous:** ingestion runs in the background by default (non-blocking) when a task model is available, so the main agent is never stalled. It falls back to the synchronous main-agent flow above when no model/API key is configured, or when called with \`background=false\`.

**Rules:**
- Never modify files in \`raw/\` — source packets are immutable after capture.
- Never fabricate information — always cite sources with \`[[sources/SRC-...]]\`.
- Inside Markdown table cells, write aliased wikilinks as \`[[target\\|alias]]\`, never \`[[target|alias]]\`.
- The extension auto-updates metadata — you do NOT need to manually edit \`meta/\` files.`,
  },
  {
    name: "wiki-discover",
    description:
      "Auto-discover new sources from the web. Searches based on config topics and known knowledge gaps.",
    hint: "[--topic <topic>]",
    body: `# /wiki-discover

Find new source material for the wiki by searching the web and capturing them as source packets.

## User Arguments

$ARGUMENTS

## Steps

1. Call \`wiki_status()\` to get the current topic and mode from the wiki config.
2. Use \`wiki_search(query=<topic>)\` to find existing pages and identify what's already covered.
3. Search the web for new sources:
   - If \`--topic\` is specified in \`$ARGUMENTS\`, focus on that topic
   - Otherwise, search for the wiki's main topic + "latest", "news", "update"
4. For each promising result (max 5-10):
   a. Call \`wiki_capture_source(url=<url>)\` to capture it as an immutable source packet
   b. Skip ads, listicles, and duplicates — prefer in-depth analysis
5. Report: "Discovered [N] new sources captured as packets. Run \`/wiki-ingest\` to synthesize them into knowledge pages."

**Rules:**
- Do NOT manually save files to \`raw/\` — always use \`wiki_capture_source\`.
- The extension handles manifest, extraction, and skeleton page creation automatically.`,
  },
  {
    name: "wiki-lint",
    description:
      "Health check the wiki. Detects contradictions, orphans, missing pages, stale claims, and knowledge gaps.",
    hint: "[--fix]",
    body: `# /wiki-lint

Run a comprehensive health check on the wiki.

## User Arguments

$ARGUMENTS

## Steps

1. Determine if auto-fix is requested: set \`auto_fix=true\` if \`$ARGUMENTS\` contains \`--fix\`, otherwise \`false\`.
2. Call \`wiki_lint(auto_fix=<true/false>)\` to run the health check.
3. Present the lint report to the user, including:
   - Page count, orphans, missing pages, contradictions
   - Knowledge gaps found
   - Any auto-fixes applied
4. If contradictions are found, flag them for human review — do NOT auto-resolve contradictions.
5. If knowledge gaps are identified, suggest creating pages for frequently-mentioned topics.`,
  },
  {
    name: "wiki-run",
    description:
      "Run the full wiki cycle: discover → ingest → lint. Optionally schedule for auto-updates.",
    hint: "[--schedule daily|weekly]",
    body: `# /wiki-run

Run the complete wiki maintenance cycle: discover new sources, ingest them, and lint for health.

## User Arguments

$ARGUMENTS

## Steps

1. **Discover:** Use web search to find new sources on the wiki's topic, then capture each with \`wiki_capture_source(url=<url>)\` (max 5-10).
2. **Ingest:** Call \`wiki_ingest(batch_size=3)\` and process returned sources — read extracted.md, update source pages, create entity/concept pages, add cross-references.
3. **Lint:** Call \`wiki_lint(auto_fix=false)\` to run a health check.
4. If critical gaps found → optionally run one more discover+ingest cycle.
5. Save summary to \`.llm-wiki/outputs/run-YYYY-MM-DD.md\` using the \`write\` tool.
6. Report final summary.

### Scheduling

If \`--schedule\` is provided, call \`wiki_watch(interval=<daily|weekly|hourly>)\`.

**Important:** \`wiki_watch\` does NOT install a schedule. It only prints a \`crontab\` line.
Report the printed line to the user verbatim and tell them to install it themselves with
\`crontab -e\`. Do not claim the schedule is active until they confirm they have done so.`,
  },
  {
    name: "wiki-retro",
    description:
      "Save an atomic insight from the current task into the wiki. Creates a single markdown file that layered recall surfaces in future sessions.",
    hint: "<title> [--category <category>]",
    body: `# /wiki-retro

Save an atomic insight from a completed task into the wiki.

Captures what you learned as a single markdown file so that layered recall surfaces it in future sessions.

## User Arguments

$ARGUMENTS

Read the bundled \`llm-wiki\` skill (invoke the \`skill\` tool with name \`llm-wiki\`) first to understand the wiki conventions.

## Steps

1. Identify the key insight(s) from the current task — non-obvious learnings, patterns, or decisions worth preserving
2. For each insight, call \`wiki_retro\` with:
   - \`slug\`: unique kebab-case identifier (e.g., \`jwt-revocation-pattern\`)
   - \`title\`: short descriptive phrase, ≤60 chars, noun phrase not a sentence
   - \`body\`: markdown explanation with \`[[wikilinks]]\` to related wiki pages
   - \`category\`: optional (frontend, architecture, devops, bugfix, design, etc.)
3. Confirm the insight was saved and will be surfaced by layered recall in future sessions
4. If the insight relates to existing wiki pages, update those pages with cross-references

**Rules:**
- One atomic insight per \`wiki_retro\` call. Use multiple calls for multiple insights.
- Don't save obvious things. Save non-obvious patterns, tradeoffs, and design decisions.
- Always add \`[[wikilinks]]\` to connect the new insight with existing wiki knowledge.
- Inside Markdown table cells, write aliased wikilinks as \`[[target\\|alias]]\`, never \`[[target|alias]]\`.`,
  },
  {
    name: "wiki-record",
    description:
      "Capture the just-completed task's tool-call trajectory into the wiki as agent working-memory, then optionally distill it into a reusable skill.",
    hint: "<title> [--outcome success|failure|partial]",
    body: `# /wiki-record

Capture the trajectory of the task you just completed — the sequence of tool calls that solved it — into the wiki's working-memory layer.

This is the counterpart to source capture: instead of recording what you *read*, it records what you *did*, so the wiki compounds over your own work.

## User Arguments

$ARGUMENTS

Read the bundled \`llm-wiki\` skill (invoke the \`skill\` tool with name \`llm-wiki\`) first to understand the wiki conventions.

## Steps

1. Call \`wiki_capture_trajectory\` with:
   - \`title\`: short descriptive phrase for the task (≤60 chars, noun phrase)
   - \`outcome\`: optional — \`success\` (default), \`failure\`, or \`partial\`
   - The extension auto-extracts the tool-call trajectory from the live session, so you usually do **not** pass \`steps\` manually.
2. Open the generated skeleton case page in \`wiki/cases/\` and flesh out:
   - **Task** — what was requested
   - **Approach** — the key steps and decisions (not every tool call, just the meaningful ones)
   - **Outcome** — the result, and anything worth reusing or avoiding next time
3. If the task taught a reusable pattern, run \`wiki_distill_skills\` and create a \`skill\` page via \`wiki_ensure_page(type="skill")\` that cites \`[[trajectories/TRJ-...]]\`.
4. Confirm the case (and any skill) will be surfaced by \`wiki_recall\` / \`wiki_recall_skill\` in future sessions.

**Rules:**
- Only record tasks worth learning from — non-trivial debugging, refactors, integrations, multi-step workflows. Skip trivial one-shot answers.
- The raw trajectory packet under \`raw/trajectories/\` is immutable. Edit the \`case\`/\`skill\` pages, never the packet.
- One trajectory per \`wiki_capture_trajectory\` call.

> **Note (dsh port):** the trajectory tools are opt-in. If \`wiki_capture_trajectory\` is unavailable, run \`/wiki-trajectories on\` and restart DSH. Capture writes an immutable packet plus a self-contained summary and no skeleton case page; write the case page yourself with \`wiki_ensure_page(type="case")\` if wanted.`,
  },
  {
    name: "wiki-skills",
    description:
      "Search the wiki's distilled skills and past cases for patterns relevant to the current task — \"have I done something like this before?\".",
    hint: "[query] [--kind skill|case]",
    body: `# /wiki-skills

Search the agent working-memory layer of the wiki: reusable **skills** distilled from past trajectories, and specific past **cases**.

## User Arguments

$ARGUMENTS

## Steps

1. Call \`wiki_recall_skill\` with:
   - \`query\`: the current task description or key terms (defaults to \`$ARGUMENTS\`)
   - \`kind\`: optional — \`skill\`, \`case\`, or \`any\` (default)
   - \`max_results\`: optional (default 5)
2. Read the most relevant skill/case pages with \`read\`.
3. Apply the recalled pattern to the current task, citing the source page with \`[[skills/...]]\` or \`[[cases/...]]\` where helpful.
4. If no relevant skill/case exists, proceed with the task and consider running \`/wiki-record\` afterward so the next attempt benefits.

**Tip:** Skills generalize across many trajectories ("how I do X"); cases are concrete past runs ("the time I did X for project Y"). Search \`any\` first, then narrow.

> **Note (dsh port):** \`wiki_recall_skill\` is an opt-in trajectory tool. If it is unavailable, run \`/wiki-trajectories on\` and restart DSH, or fall back to \`wiki_search\` over the \`skills\` and \`cases\` page types.`,
  },
  {
    name: "wiki-req",
    description:
      "Capture and decompose a concept into atomic, traceable wiki requirements. Clarifies ambiguous requirements, splits them into atomic pieces, and persists them as wiki/requirements/ pages with status tracking.",
    hint: "<concept description>",
    body: `# /wiki-req

Capture a concept and decompose it into atomic, traceable requirements in the wiki.

Transforms natural language descriptions into structured \`wiki/requirements/\` pages, preserving the original clarified concept as an immutable source packet in \`raw/sources/\`.

## User Arguments

$ARGUMENTS

Read the bundled \`llm-wiki\` skill (invoke the \`skill\` tool with name \`llm-wiki\`) first to understand the wiki conventions, architecture, and page type rules.

## Steps

1. **Clarify the concept**
   - Discuss with the user: unpack ambiguous terms, surfaces implicit assumptions, identify scope boundaries
   - Ask targeted questions to resolve unknowns (e.g., "Which providers?", "What's the fallback behavior?", "Who are the actors?")
   - Reach mutual clarity before proceeding

2. **Capture the clarified concept**
   - Call \`wiki_capture_source(text=...)\` with the clarified conversation as markdown
   - This creates an immutable record in \`raw/sources/SRC-YYYY-MM-DD-NNN/\`
   - The source captures the original intent verbatim — no interpretation, no decomposition

3. **Decompose into atomic requirements**
   - Break the clarified concept into the smallest meaningful units of functionality
   - Each requirement should represent one independently verifiable behavior
   - For each atomic requirement, call \`wiki_ensure_page(type="requirement", title="...", content="...")\` where content includes:
     - \`type: requirement\` and \`status: draft\` in frontmatter
     - A clear \`## Description\` section
     - \`## Acceptance Criteria\` as a checkbox list (the threshold for "done")
     - \`source_id\` linking back to the source capture
     - \`depends_on\` linking to any prerequisite requirements
     - \`[[wikilinks]]\` to relevant entities, concepts, and other wiki pages
   - Set priority based on user input: \`p0\` (blocking), \`p1\` (critical), \`p2\` (important), \`p3\` (nice-to-have)

4. **Cross-link and finalize**
   - Ensure each requirement page has bidirectional wikilinks to related pages
   - Update any existing entity or concept pages that these requirements reference
   - Report the results: how many requirements created, their priorities, and the source capture ID

**Rules:**
- One atomic requirement per \`wiki_ensure_page\` call — each must be independently testable
- Always capture the clarified concept first via \`wiki_capture_source\` before decomposing
- Requirements live in \`wiki/requirements/\` — they are editable wiki pages, not immutable sources
- Use status values: \`draft\` → \`clarified\` → \`active\` → \`implemented\` → \`deferred\` → \`rejected\`
- Use priority values: \`p0\` (blocking), \`p1\` (critical), \`p2\` (important), \`p3\` (nice-to-have)
- Do not create requirements in \`raw/\` — that layer is for external source artifacts only
- Inside Markdown table cells, write aliased wikilinks as \`[[target\\|alias]]\`, never \`[[target|alias]]\`.`,
  },
  {
    name: "wiki-digest",
    description:
      "Generate a daily or weekly digest of wiki changes — new sources, pages, insights, and gaps.",
    hint: "[--period daily|weekly]",
    body: `# /wiki-digest

Generate a digest of recent wiki activity.

## User Arguments

$ARGUMENTS

## Steps

1. Call \`wiki_status()\` to get current stats (page count, orphans, gaps, health).
2. Read \`.llm-wiki/meta/log.md\` for recent events since the last digest period.
3. Summarize:
   - New sources captured
   - New pages created or updated
   - Key insights or connections made
   - Knowledge gaps identified
   - Health trends (improving, stable, declining)
4. Save the digest to \`.llm-wiki/outputs/digest-YYYY-MM-DD.md\` using the \`write\` tool.
5. Call \`wiki_log_event(kind=digest)\` to record this digest was generated.
6. Report a concise digest to the user.`,
  },
];

/**
 * Build the 12 command definitions. Each handler renders its template with
 * the invocation's rawInput and steers it into the receiving agent — the
 * only verified path for a command to produce model-visible work (dsh
 * commands never create a model turn by themselves).
 */
export function buildCommandDefinitions(deps: CommandDeps): CommandDefinition[] {
  return COMMAND_TEMPLATES.map((template) => ({
    name: template.name,
    description: template.description,
    ...(template.hint ? { input: { hint: template.hint } } : {}),
    handler: (invocation: CommandInvocation): CommandResult => {
      try {
        const agent = invocation.agent;
        if (!agent || typeof agent.steer !== "function") {
          deps.warn?.(`/${template.name}: no agent handle on invocation — nothing dispatched`);
          return { kind: "error", text: "No agent is attached to this session." };
        }
        agent.steer(buildSteerMessage(renderTemplate(template, invocation.rawInput ?? "")));
        return {
          kind: "success",
          text: `Dispatched /${template.name} instructions to the agent.`,
        };
      } catch (error) {
        deps.warn?.(`/${template.name} handler failed: ${(error as Error).message}`);
        return {
          kind: "error",
          text: `/${template.name} failed: ${(error as Error).message}`,
        };
      }
    },
  }));
}

const ON_WORDS = new Set(["on", "true", "enable", "enabled", "yes", "1"]);
const OFF_WORDS = new Set(["off", "false", "disable", "disabled", "no", "0"]);

/**
 * `/wiki-trajectories [on|off]` — a direct handler (no model turn), ported
 * from upstream. It persists the flag in the project settings file. The tools
 * are registered at plugin startup, so a change needs a DSH restart; an
 * explicit `trajectories` value in the plugin Config row wins over the file.
 */
export function buildTrajectoriesCommand(deps: CommandDeps): CommandDefinition {
  return {
    name: "wiki-trajectories",
    description:
      "Enable or disable agent-trajectory working-memory (capture/distill/recall). Off by default.",
    input: { hint: "[on|off]" },
    handler: (invocation: CommandInvocation): CommandResult => {
      try {
        const cwd = deps.cwd?.(invocation.agent) ?? process.cwd();
        const arg = (invocation.rawInput ?? "").trim().toLowerCase();
        const current = trajectoriesEnabled(loadTaskConfig(cwd));
        if (!arg) {
          return {
            kind: "success",
            text: `LLM Wiki trajectories are ${current ? "ON" : "OFF"}. Use /wiki-trajectories on or off.`,
          };
        }
        let next: boolean;
        if (ON_WORDS.has(arg)) next = true;
        else if (OFF_WORDS.has(arg)) next = false;
        else return { kind: "error", text: `Could not parse "${arg}". Use on or off.` };
        if (next === current) {
          return { kind: "success", text: `LLM Wiki trajectories already ${current ? "ON" : "OFF"}.` };
        }
        persistTrajectoriesEnabled(cwd, next);
        return {
          kind: "success",
          text: `LLM Wiki: trajectory tools ${next ? "enabled" : "disabled"} in project settings. Restart DSH to apply.`,
        };
      } catch (error) {
        return { kind: "error", text: `/wiki-trajectories failed: ${(error as Error).message}` };
      }
    },
  };
}

/**
 * Register all wiki commands on the `commands` service.
 *
 * The service is optional in the dsh mount tree, so registration is deferred
 * through `ctx.inject(["commands"], ...)` — if the service never mounts the
 * plugin still loads; the command surface is simply absent (the same pattern
 * `dsh-plan-mode` uses for its `/plan` command).
 */
export function registerCommands(ctx: Context, deps: CommandDeps): void {
  const definitions = [...buildCommandDefinitions(deps), buildTrajectoriesCommand(deps)];
  (
    ctx as Context & {
      inject(inject: string[], callback: (child: Context) => void): unknown;
    }
  ).inject(["commands"], (commandCtx) => {
    const service = (commandCtx as Context & { commands: CommandsService }).commands;
    for (const definition of definitions) {
      service.register(definition);
    }
  });
}
