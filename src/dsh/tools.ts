import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import { bootstrapVault } from "../engine/bootstrap.js";
import { reindexEmbeddings, resolveEmbedder } from "../engine/embeddings.js";
import { scheduleReindex } from "../engine/indexing.js";
import {
  createKnowledgeDocument,
  parseMarkdownFrontmatter,
  writeKnowledgeDocumentFile,
} from "../engine/knowledge-document.js";
import { applyWikilinkGate, buildWikilinkIndex } from "../engine/knowledge-links.js";
import { runWikiLint } from "../engine/lint.js";
import { appendEvent, rebuildMetadata } from "../engine/metadata.js";
import { saveObservation } from "../engine/observation.js";
import { reindexQmdVault } from "../engine/qmd-indexing.js";
import {
  searchWikiLayered,
  shouldUseLinksFirst,
  vaultPageCount,
} from "../engine/recall.js";
import type { Runtime } from "../engine/runtime.js";
import { saveInsight } from "../engine/retro.js";
import { captureFile, captureText, captureUrl } from "../engine/source-packet.js";
import {
  loadTaskConfig,
  parseModelRef,
  resolveWikilinkValidation,
} from "../engine/task-config.js";
import type { ExecApi } from "../engine/utils.js";
import {
  fmtDate,
  getVaultPaths,
  readJson,
  resolveVaultPaths,
  slugify,
  type VaultPaths,
} from "../engine/utils.js";
import { inspectWritableVault } from "../engine/vault-format.js";
import { getWikiStatus, reindexWiki, searchRegistry } from "../engine/wiki-service.js";
import { markObserved, type ReminderStates } from "./reminder.js";
import {
  startIngestSynthesis,
  type JobsServiceLike,
  type SubagentsServiceLike,
} from "./ingest.js";

/**
 * Links-first recall renders a one-line snippet beside each ranked link.
 * Mirrors the private `linkSnippet` in engine/recall.ts (80-char cap); the
 * engine does not export it, so the same shaping lives here.
 */
function linkSnippet(preview: string): string {
  const oneLine = preview.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/**
 * Frontmatter fields wiki_ensure_page generates or derives itself.
 * Model-supplied values for these are ignored rather than merged (issue #241).
 * Mirrors the constant in upstream tools.ts, which the vendored engine does
 * not carry because tools.ts is host-side registration code.
 */
const RESERVED_FRONTMATTER = new Set(["type", "title", "created", "updated", "sources", "id"]);

/** Per-type page body templates, mirrored from upstream tools.ts buildPageBody. */
function buildPageBody(type: string, title: string): string {
  const links = "\n\n## Links\n\n- [related-page](/concepts/related-page.md)";
  switch (type) {
    case "entity":
      return `# ${title}\n\nOne-line description.\n\n## Overview\n\n[Key facts]${links}`;
    case "concept":
      return `# ${title}\n\nOne-line definition.\n\n## Definition\n\n[Clear explanation]${links}`;
    case "synthesis":
      return `# ${title}\n\nCross-cutting analysis.\n\n## Question\n\n[What drove this?]${links}`;
    case "analysis":
      return `# ${title}\n\nDurable answer from a query.\n\n## Question\n\n[Original question]${links}`;
    case "skill":
      return `# ${title}\n\n_One-line summary of the reusable pattern this skill captures._\n\n## When to Use\n\n[Trigger conditions — when this pattern applies]\n\n## Procedure\n\n1. [Step 1]\n2. [Step 2]\n\n## Pitfalls\n\n- [Known failure mode or caveat]\n\n## Distilled From\n\n_Trajectories this skill was generalized from._\n\n- [trajectories/TRJ-...](/trajectories/TRJ-....md)`;
    case "case":
      return `# ${title}\n\n_One-line summary of the specific task this case records._\n\n## Task\n\n[What was requested]\n\n## Approach\n\n[How the agent solved it — key steps and decisions]\n\n## Outcome\n\n[Result, and anything worth reusing or avoiding next time]\n\n## Trajectory\n\n- [trajectories/TRJ-...](/trajectories/TRJ-....md) — captured tool-call run`;
    case "requirement":
      return `# ${title}\n\n## Description\n\n[Clear description of what this requirement entails]\n\n## Acceptance Criteria\n\n- [ ] [Criterion 1]\n- [ ] [Criterion 2]\n\n## Dependencies\n\n_Pages this requirement depends on._\n\n## Implementation Notes\n\n[Optional notes]\n\n## Sources\n\n- [sources/SRC-...](/sources/SRC-....md) — original concept capture`;
    default:
      return `# ${title}\n\n[Description to be filled]${links}`;
  }
}

/**
 * Dependencies the tool definitions close over. The cordis `ctx` is resolved
 * per call inside `execute`/`render`, not captured here, so tools keep working
 * across agent fibers and tests can inject a mock bundle.
 */
export interface WikiToolDeps {
  /** Resolve the working directory for vault resolution (agent cwd or fallback). */
  cwd(): string;
  /** Optional per-agent session directory; used when the Host provides workingDirectory. */
  cwdFor?(agent?: unknown): string;
  /** Merged llm-wiki config (Schemastery row over compat settings read). */
  config: ReturnType<typeof loadTaskConfig>;
  /** Shared background runtime (indexing, embeddings, reporting). */
  runtime: Runtime;
  /** Engine ExecApi over ctx.subprocess (URL/file capture). */
  execApi: ExecApi;
  /** Deliver a completed background summary to the owning agent. */
  report(summary: string, opts?: { display?: boolean }): void;
  /** Best-effort UI notify; absent under tests/headless. */
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  /** Optional DSH-managed subagent service for phase 3 ingest synthesis. */
  subagents?: SubagentsServiceLike;
  /** Optional DSH jobs registry for background ingest visibility/cancel. */
  jobs?: JobsServiceLike;
  /** Per-Session observe reminder state (shared with ambient). */
  reminderStates?: ReminderStates;
}

/** LaunchCtx the engine wants: UI surface for background notifications. */
function launchCtx(
  deps: WikiToolDeps,
  exec?: { agent?: unknown },
): { hasUI: boolean; ui?: { notify: (m: string, t?: "info" | "warning" | "error") => void }; agent?: unknown } {
  const base = deps.notify ? { hasUI: true, ui: { notify: deps.notify } } : { hasUI: false };
  return exec?.agent ? { ...base, agent: exec.agent } : base;
}

const NO_VAULT = "No wiki vault found at this location. Initialize one with wiki_bootstrap first.";

function noVaultResult() {
  return { ok: false as const, error: "no_vault", message: NO_VAULT };
}

/** Resolve the vault the same way the pi tool layer does: walk-up + personal fallback. */
function paths(deps: WikiToolDeps, exec?: { agent?: unknown }): VaultPaths {
  return resolveVaultPaths(deps.cwdFor?.(exec?.agent) ?? deps.cwd());
}

function vaultExists(p: VaultPaths): boolean {
  return existsSync(join(p.dotWiki, "config.json"));
}

/** Structured error value carried on the canonical output; render maps it to text. */
type WikiResult = Record<string, JsonValue>;

function diagList(
  diagnostics: Array<{ code: string; message: string }>,
): Array<{ code: string; message: string }> {
  return diagnostics.map((d) => ({ code: d.code, message: d.message }));
}

function failResult(code: string, message: string): WikiResult {
  return { ok: false, error: code, message };
}

function vaultFail(check: { diagnostics: Array<{ code: string; message: string }> }): WikiResult {
  return {
    ok: false,
    error: check.diagnostics[0]?.code ?? "vault_error",
    message: `Wiki vault error: ${check.diagnostics[0]?.message ?? "unknown"}`,
    diagnostics: diagList(check.diagnostics),
  };
}

const OUT = {
  type: "object" as const,
  additionalProperties: true as const,
};

function textOut(render: (value: Record<string, unknown>) => string) {
  return {
    schema: OUT,
    render: (_args: unknown, value: Record<string, unknown>) => [
      { type: "text" as const, text: render(value) },
    ],
  };
}

export function buildWikiToolDefinitions(deps: WikiToolDeps): ToolDefinition[] {
  return [
    // ── 1. wiki_bootstrap ────────────────────────────────────────────────
    defineTool({
      name: "wiki_bootstrap",
      description:
        "Initialize a new LLM Wiki vault with the 4-layer architecture. " +
        "Creates config, templates, schema, and metadata scaffolding. " +
        "Use when the user wants to start a new wiki; safe to re-run on an " +
        "existing vault, where it updates the config and rebuilds metadata.",
      parameters: {
        topic: { type: "string", required: true, description: "Main topic of the wiki" },
        mode: {
          type: "string",
          description: "personal or company (default: personal)",
        },
        root: {
          type: "string",
          description: "Root directory (default: current directory)",
        },
      },
      output: {
        schema: OUT,
        render: (_args, value) => {
          const v = value as Record<string, unknown>;
          if (v.ok !== true) {
            return [{ type: "text", text: `Wiki vault error: ${v.message ?? "bootstrap failed"}` }];
          }
          const warnings = (v.diagnostics as Array<{ code: string; message: string }> | undefined) ?? [];
          return [
            {
              type: "text",
              text: [
                `${v.created ? "✅ Wiki bootstrapped" : "✅ Wiki vault updated"} at \`${v.root}\``,
                "**Scope:** project-local",
                "",
                "**Structure:**",
                "- .llm-wiki/raw/sources/ — immutable source packets",
                "- .llm-wiki/wiki/ — editable knowledge pages",
                "- .llm-wiki/meta/ — auto-generated metadata",
                "- .llm-wiki/WIKI_SCHEMA.md — operating rules",
                "",
                "Next: Use wiki_capture_source to add your first source.",
                ...warnings.map((d) => `⚠️ ${d.code}: ${d.message}`),
              ].join("\n"),
            },
          ];
        },
      },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const root = args.root ?? deps.cwdFor?.(exec.agent) ?? deps.cwd();
        const mode = args.mode || "personal";
        const p = getVaultPaths(root);
        const result = bootstrapVault(p, { topic: args.topic, mode });
        if (!result.ok) {
          return failResult(result.diagnostics[0].code, `Wiki vault error: ${result.diagnostics[0].message}`);
        }
        return {
          ok: true,
          root,
          mode,
          topic: args.topic,
          created: result.created,
          diagnostics: result.projection.ok ? [] : diagList(result.projection.diagnostics),
        };
      },
    }),

    // ── 2. wiki_capture_source ───────────────────────────────────────────
    defineTool({
      name: "wiki_capture_source",
      description:
        "Capture a URL, local file, or pasted text into an immutable source " +
        "packet and skeleton source page. After capture, read the extracted " +
        "text and update the skeleton source page.",
      parameters: {
        url: { type: "string", description: "URL to capture" },
        file_path: { type: "string", description: "Local file path to capture" },
        text: { type: "string", description: "Pasted text content" },
        title: { type: "string", description: "Title for pasted text" },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "capture failed");
        return [
          `✅ Captured source **${v.sourceId}**`,
          "",
          `- Packet: \`${v.packetPath}\``,
          `- Skeleton page: \`${v.sourcePagePath}\``,
          "",
          "**Next:** Read the extracted text and update the source page with a proper summary, entities, and concepts.",
        ].join("\n");
      }),
      timeoutMs: 120_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);

        let result: { sourceId: string; packetPath: string; sourcePagePath: string; extracted: string };
        try {
          if (args.url) {
            result = await captureUrl(deps.execApi, p, args.url, exec.signal);
          } else if (args.file_path) {
            result = await captureFile(deps.execApi, p, args.file_path, exec.signal);
          } else if (args.text) {
            result = captureText(p, args.text, args.title);
          } else {
            return failResult("missing_source", "Provide one of: url, file_path, or text");
          }
        } catch (error) {
          return failResult("capture_failed", (error as Error).message);
        }

        scheduleReindex(deps.runtime, launchCtx(deps, exec), p);
        return {
          ok: true,
          sourceId: result.sourceId,
          packetPath: result.packetPath,
          sourcePagePath: result.sourcePagePath,
          extractedPreview: result.extracted.slice(0, 300),
        };
      },
    }),

    // ── 3. wiki_ingest ───────────────────────────────────────────────────
    defineTool({
      name: "wiki_ingest",
      description:
        "Process uningested source packets (captured with wiki_capture_source). " +
        "When the DSH subagent service is available, dispatches background " +
        "synthesis jobs and reports completion asynchronously; otherwise returns " +
        "the extracted-content inventory plus synthesize-yourself instructions.",
      parameters: {
        source_id: {
          type: "string",
          description: "Specific source ID to ingest. Leave empty for all new.",
        },
        batch_size: {
          type: "number",
          description: "Max sources to process (default: 3, max: 5)",
        },
        model: {
          type: "string",
          description: "Per-call model override as 'provider/id'",
        },
      },
      output: {
        schema: OUT,
        render: (_args, value) => {
          const v = value as Record<string, unknown>;
          if (v.report) return [{ type: "text", text: String(v.report) }];
          return [{ type: "text", text: JSON.stringify(v, null, 2) }];
        },
      },
      timeoutMs: 60_000,
      async execute(args, exec): Promise<WikiResult> {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) {
          return {
            report: `Wiki vault error: ${check.diagnostics[0].message}`,
            isError: true,
          };
        }

        if (!existsSync(p.rawSources)) {
          return {
            report: "No raw/sources/ directory. Capture sources first with wiki_capture_source.",
            isError: true,
          };
        }

        const packets = readdirSync(p.rawSources)
          .filter((d) => d.startsWith("SRC-"))
          .sort();
        const registry = readJson<{ pages: Record<string, unknown> }>(
          join(p.meta, "registry.json"),
          { pages: {} },
        );
        const ingested = new Set<string>();
        for (const [id, entry] of Object.entries(registry.pages)) {
          const page = entry as Record<string, unknown>;
          if (page.type === "source" && page.status !== "skeleton") {
            const base = id.split("/").pop();
            if (base) ingested.add(base);
          }
        }

        let toProcess = packets.filter((pk) => !ingested.has(pk));
        if (args.source_id) {
          if (!toProcess.includes(args.source_id) && !packets.includes(args.source_id)) {
            return {
              report: `Source ${args.source_id} not found or already ingested.`,
              isError: true,
            };
          }
          toProcess = [args.source_id];
        }

        const batch = toProcess.slice(0, Math.min(args.batch_size ?? 3, 5));
        if (batch.length === 0) {
          return { report: "✅ All sources ingested. Use wiki_capture_source to add new ones." };
        }

        const sources = batch.map((id) => {
          const manifest = readJson<Record<string, unknown>>(
            join(p.rawSources, id, "manifest.json"),
            {},
          );
          const extractedPath = join(p.rawSources, id, "extracted.md");
          const extracted = existsSync(extractedPath)
            ? readFileSync(extractedPath, "utf-8")
            : "";
          return {
            id,
            title: (manifest.title as string) ?? id,
            extractedChars: extracted.length,
            relPath: `${relative(p.root, p.rawSources)}/${id}/extracted.md`,
            manifest,
            extracted,
          };
        });

        // Phase 3: hand each source to a DSH-managed synthesis child. The child
        // returns structured commit data; the deterministic commit runs in this
        // process, so no model-authored file write ever bypasses the engine.
        const override = args.model ? parseModelRef(args.model) : undefined;
        const dispatched: Array<{ id: string; title: string; jobId?: string }> = [];
        const failures: string[] = [];
        for (const source of sources) {
          const started = await startIngestSynthesis(deps, {
            paths: p,
            sourceId: source.id,
            manifest: source.manifest,
            extracted: source.extracted,
            parent: exec.agent,
            model: override,
          });
          if (started.ok) {
            dispatched.push({
              id: source.id,
              title: source.title,
              ...(started.jobId ? { jobId: started.jobId } : {}),
            });
          } else {
            failures.push(`${source.id}: ${started.reason}`);
          }
        }

        if (dispatched.length > 0) {
          return {
            report: [
              `🚀 Dispatched ${dispatched.length} source(s) to background synthesis.`,
              "",
              ...dispatched.map(
                (s) =>
                  `- **${s.id}**: ${s.title}${s.jobId ? ` (job \`${s.jobId}\`)` : ""}`,
              ),
              ...(failures.length
                ? ["", "⚠️ Not dispatched:", ...failures.map((f) => `- ${f}`)]
                : []),
              "",
              "The synthesis child publishes structured data; the plugin commits pages and refreshes metadata when it completes. Use the job list to follow progress.",
            ].join("\n"),
            background: true,
            dispatched,
            failures,
          };
        }

        return {
          report: [
            "⚠️ Background synthesis is unavailable; synthesize these sources yourself:",
            ...(failures.length ? ["", ...failures.map((f) => `- ${f}`)] : []),
            "",
            ...sources.map(
              (s) => `- **${s.id}**: ${s.title} (${s.extractedChars} chars extracted)\n  Read: \`${s.relPath}\``,
            ),
            "",
            "1. Read each source's extracted.md",
            "2. Update the skeleton source page in wiki/sources/",
            "3. Create/update entity pages in wiki/entities/",
            "4. Create/update concept pages in wiki/concepts/",
            "5. Add [[wikilinks]] cross-references",
            "6. Flag contradictions",
            "",
            "The extension will auto-update metadata when you are done.",
          ].join("\n"),
          sources: sources.map((s) => ({
            id: s.id,
            title: s.title,
            extractedChars: s.extractedChars,
          })),
        };
      },
    }),

    // ── 4. wiki_ensure_page ──────────────────────────────────────────────
    defineTool({
      name: "wiki_ensure_page",
      description:
        "Resolve or safely create a canonical wiki page. Returns the page path. " +
        "Search existing pages first with wiki_search to avoid duplicates. " +
        "Content may begin with a YAML frontmatter block; its fields are merged " +
        "into the page frontmatter, and generated fields (type, title, created, " +
        "updated, sources) are reserved and ignored.",
      parameters: {
        type: {
          type: "string",
          required: true,
          description:
            "Page type: entity | concept | synthesis | analysis | requirement | skill | case (built-in) or any user-defined type",
        },
        title: { type: "string", required: true, description: "Page title" },
        content: {
          type: "string",
          description: "Optional Markdown body (may begin with a YAML frontmatter block)",
        },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "ensure_page failed");
        const gateNote = Array.isArray(v.wikilinkIssues) && v.wikilinkIssues.length
          ? `\n\n⚠️ ${(v.wikilinkIssues as string[]).length} wikilink issue(s):\n${(v.wikilinkIssues as string[]).map((m) => `- ${m}`).join("\n")}`
          : "";
        return v.created
          ? `✅ Created ${v.type} page: \`${v.path}\`${gateNote}`
          : `✅ Page already exists: \`${v.path}\``;
      }),
      timeoutMs: 30_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);

        const config = deps.config;
        const folderMap: Record<string, string> = {
          entity: "entities",
          concept: "concepts",
          synthesis: "syntheses",
          analysis: "analyses",
          requirement: "requirements",
          skill: "skills",
          case: "cases",
          ...(config.customTypes ?? {}),
        };
        const slug = slugify(args.title);
        const folder = folderMap[args.type] || "concepts";
        const pagePath = join(p.wiki, folder, `${slug}.md`);
        if (existsSync(pagePath)) {
          return { ok: true, path: pagePath, created: false, type: args.type };
        }

        const today = fmtDate();
        let body = args.content ?? buildPageBody(args.type, args.title);
        const extraFrontmatter: Record<string, unknown> = {};
        if (body.trimStart().startsWith("---")) {
          const parsed = parseMarkdownFrontmatter(body, `${folder}/${slug}.md`);
          if (parsed.ok) {
            for (const [key, value] of Object.entries(parsed.mapping)) {
              if (!RESERVED_FRONTMATTER.has(key)) extraFrontmatter[key] = value;
            }
            body = parsed.body.trim() ? parsed.body : buildPageBody(args.type, args.title);
          }
        }

        let wikilinkIssues: string[] = [];
        const mode = resolveWikilinkValidation(config);
        if (mode !== "off") {
          const registry = readJson<{ pages: Record<string, unknown> }>(
            join(p.meta, "registry.json"),
            { pages: {} },
          );
          const gate = applyWikilinkGate(
            body,
            buildWikilinkIndex(Object.keys(registry.pages)),
            `${folder}/${slug}`,
            mode,
          );
          wikilinkIssues = gate.diagnostics.map((d) => d.message);
          if (!gate.ok) {
            return {
              ok: false,
              error: "link_validation",
              message: `Rejected write — unresolved/ambiguous wikilinks:\n${wikilinkIssues.map((m) => `- ${m}`).join("\n")}`,
              wikilinkIssues,
            };
          }
          if (mode === "normalize") body = gate.body;
        }

        const doc = createKnowledgeDocument(
          `${folder}/${slug}.md`,
          {
            type: args.type,
            title: args.title,
            created: today,
            updated: today,
            ...extraFrontmatter,
          },
          body,
        );
        mkdirSync(join(p.wiki, folder), { recursive: true });
        writeKnowledgeDocumentFile(pagePath, doc);
        appendEvent(p, {
          kind: "ensure_page",
          page_type: args.type,
          title: args.title,
          path: `${folder}/${slug}`,
        });
        scheduleReindex(deps.runtime, launchCtx(deps, exec), p);

        return { ok: true, path: pagePath, created: true, type: args.type, wikilinkIssues };
      },
    }),

    // ── 5. wiki_search ───────────────────────────────────────────────────
    defineTool({
      name: "wiki_search",
      description:
        "Search the wiki registry for pages matching a query. Use this to find " +
        "existing pages before creating duplicates.",
      parameters: {
        query: { type: "string", required: true, description: "Search term" },
        type: {
          type: "string",
          description: "Filter by page type (source, entity, concept, synthesis, analysis)",
        },
      },
      output: {
        schema: OUT,
        render: (_args, value) => {
          const v = value as Record<string, unknown>;
          if (v.ok !== true) return [{ type: "text", text: String(v.message ?? "search failed") }];
          const matches = (v.matches as Array<{ id: string; title: string; type: string }>) ?? [];
          if (matches.length === 0) {
            return [{ type: "text", text: `No pages found for "${v.query}"` }];
          }
          return [
            {
              type: "text",
              text: [
                `🔍 **${matches.length} result(s)** for "${v.query}":`,
                "",
                ...matches.map((m) => `- [[${m.id}]] — *${m.type}* — ${m.title}`),
              ].join("\n"),
            },
          ];
        },
      },
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        if (!vaultExists(p)) return noVaultResult();
        const result = searchRegistry(p, args.query, args.type);
        return {
          ok: true,
          query: args.query,
          matches: result.matches,
          diagnostics: diagList(result.diagnostics),
        };
      },
    }),

    // ── 6. wiki_lint ─────────────────────────────────────────────────────
    defineTool({
      name: "wiki_lint",
      description:
        "Health check the wiki. Scans for orphans, missing pages, contradictions, " +
        "gaps. Optionally auto-fixes. Contradictions always need human review.",
      parameters: {
        auto_fix: {
          type: "boolean",
          description: "Auto-fix orphans and missing pages (default: false)",
        },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "lint failed");
        return String(v.report ?? "");
      }),
      timeoutMs: 300_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);
        const report = await runWikiLint(p, args.auto_fix === true);
        return { ok: true, report };
      },
    }),

    // ── 7. wiki_status ───────────────────────────────────────────────────
    defineTool({
      name: "wiki_status",
      description:
        "Report wiki health and stats instantly from the generated registry: " +
        "page counts by type, orphans, gaps, QMD index state.",
      parameters: {},
      output: {
        schema: OUT,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      timeoutMs: 15_000,
      async execute(_args, exec) {
        const p = paths(deps, exec);
        if (!vaultExists(p)) return noVaultResult();
        const status = await getWikiStatus(p);
        const config = readJson<Record<string, JsonValue>>(join(p.dotWiki, "config.json"), {});
        const backlinks = readJson<Record<string, string[]>>(join(p.meta, "backlinks.json"), {});
        const orphans = Object.values(backlinks).filter((inbound) => inbound.length === 0).length;
        const gaps = readJson<{ gaps?: unknown[] }>(join(p.discoveries, "gaps.json"), { gaps: [] });
        return {
          ok: true,
          vaultPath: p.root,
          topic: (config.topic as JsonValue) ?? null,
          mode: (config.mode as JsonValue) ?? null,
          knowledgeFormat: status.knowledgeFormat,
          format: status.knowledgeFormat,
          totalPages: status.totalPages,
          byType: status.byType,
          orphans,
          gaps: gaps.gaps?.length ?? 0,
          lastUpdated: status.lastUpdated,
          blockingDiagnostics: diagList(status.blockingDiagnostics),
          qmd: status.qmd as unknown as JsonValue,
        };
      },
    }),

    // ── 8. wiki_rebuild_meta ─────────────────────────────────────────────
    defineTool({
      name: "wiki_rebuild_meta",
      description:
        "Force a full metadata rebuild (registry, backlinks, index, log). " +
        "Use if metadata seems out of sync.",
      parameters: {},
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "rebuild failed");
        return String(v.report ?? "");
      }),
      timeoutMs: 300_000,
      async execute(_args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);

        const result = rebuildMetadata(p);
        if (!result.ok) {
          return {
            ok: true,
            report: `⚠️ LLM Wiki: rebuild had issues — ${result.diagnostics
              .map((d) => `${d.code}: ${d.message}`)
              .join("; ")}`,
            pages: 0,
            warnings: diagList(result.diagnostics),
          };
        }
        const warnings = result.diagnostics
          .filter((d) => d.severity === "warning")
          .map((d) => ({ code: d.code, message: d.message }));

        const qmdResult = await reindexQmdVault(p, {
          scope: "changed",
          components: ["lexical"],
          force: false,
        });
        if (!qmdResult.ok) {
          warnings.push({
            code: "qmd_index_error",
            message: qmdResult.errors[0]?.message ?? "QMD indexing failed",
          });
        }

        const registry = readJson<{ pages: Record<string, unknown> }>(
          join(p.meta, "registry.json"),
          { pages: {} },
        );
        const pageCount = Object.keys(registry.pages).length;
        return {
          ok: true,
          report:
            warnings.length > 0
              ? `⚠️ LLM Wiki: metadata rebuilt with warnings — ${warnings
                  .map((w) => `${w.code}: ${w.message}`)
                  .join("; ")}`
              : `✅ LLM Wiki: metadata rebuilt — ${pageCount} pages indexed.`,
          pages: pageCount,
          warnings,
        };
      },
    }),

    // ── 9. wiki_reindex ──────────────────────────────────────────────────
    defineTool({
      name: "wiki_reindex",
      description:
        "Rebuild or repair the generated QMD search index (meta/qmd) for the " +
        "vault. Lexical indexing is model-free; selecting vectors may download " +
        "approximately 2 GB of models on first use. Use to repair a stale, " +
        "error, or recovering QMD index.",
      parameters: {
        scope: {
          type: "string",
          enum: ["changed", "all"],
          description: "Reindex scope (default: changed)",
        },
        components: {
          type: "array",
          items: { type: "string", enum: ["lexical", "vectors"] },
          description: "Index components to rebuild (default: lexical + vectors)",
        },
        force: {
          type: "boolean",
          description: "Force a full rebuild of the selected components",
        },
        vault: {
          type: "string",
          enum: ["active", "personal", "project", "all"],
          description: "Which vaults to reindex (default: active)",
        },
      },
      output: {
        schema: OUT,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      timeoutMs: 600_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);

        const components = (args.components ?? ["lexical", "vectors"]) as Array<"lexical" | "vectors">;
        const result = await reindexWiki(p, {
          scope: (args.scope as "changed" | "all") ?? "changed",
          components,
          force: args.force === true,
          vault: (args.vault as "active" | "personal" | "project" | "all") ?? "active",
          signal: exec.signal,
        });

        const ok = result.results.every((r) => r.result.ok);
        return {
          ok,
          vault: result.vault,
          results: result.results.map((r) => ({
            root: r.root,
            label: r.label,
            ok: r.result.ok,
            state: r.result.status.state,
            totalDocuments: r.result.status.totalDocuments,
            indexed: r.result.documents.indexed,
            updated: r.result.documents.updated,
            removed: r.result.documents.removed,
            vectorsGenerated: r.result.vectors.generated,
            errors: r.result.errors.map((e) => ({ code: e.code, message: e.message })),
            warnings: r.result.warnings.map((w) => ({ code: w.code, message: w.message })),
          })),
          lexicalOnly: components.length === 1 && components[0] === "lexical",
        };
      },
    }),

    // ── 10. wiki_reindex_embeddings ──────────────────────────────────────
    defineTool({
      name: "wiki_reindex_embeddings",
      description:
        "Backfill / refresh semantic embeddings for the vault. Embeds pages that " +
        "are new or stale (content changed); pass force to re-embed everything. " +
        "No-op when no embedding provider is configured.",
      parameters: {
        force: {
          type: "boolean",
          description: "Re-embed every page, ignoring staleness (default: false)",
        },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "reindex failed");
        return String(v.message ?? "");
      }),
      timeoutMs: 600_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);

        const embedder = resolveEmbedder(deps.config);
        if (!embedder) {
          return {
            ok: true,
            enabled: false,
            message:
              'ℹ️ No embedding provider configured — semantic embeddings are disabled. Set `llm-wiki.embeddingProvider` (e.g. "openai") in settings to enable.',
          };
        }
        const stats = await reindexEmbeddings(p, embedder, { force: args.force === true });
        appendEvent(p, {
          kind: "reindex_embeddings",
          embedded: stats.embedded,
          skipped: stats.skipped,
          pruned: stats.pruned,
          model: embedder.model,
        });
        return {
          ok: true,
          enabled: true,
          model: embedder.model,
          ...stats,
          message: `✅ LLM Wiki: embeddings reindexed (${embedder.model}) — ${stats.embedded} embedded, ${stats.skipped} fresh, ${stats.pruned} pruned.`,
        };
      },
    }),

    // ── 11. wiki_log_event ───────────────────────────────────────────────
    defineTool({
      name: "wiki_log_event",
      description:
        "Append a structured event to meta/events.jsonl and regenerate meta/log.md. " +
        "Use to record significant actions manually.",
      parameters: {
        kind: {
          type: "string",
          required: true,
          description: "Event kind (e.g., ingest, query, decision)",
        },
        details: {
          type: "object",
          additionalProperties: true,
          description: "Additional event fields",
        },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "log_event failed");
        return String(v.message ?? "");
      }),
      timeoutMs: 60_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);

        const kind = typeof args.kind === "string" ? args.kind.trim() : "";
        if (!kind) return failResult("event_missing_kind", "Event kind must be a non-empty string");
        const details = (args.details as Record<string, unknown> | undefined) ?? {};
        if (Object.hasOwn(details, "kind") || Object.hasOwn(details, "timestamp")) {
          return failResult(
            "event_reserved_field",
            "Event details cannot override kind or timestamp",
          );
        }
        appendEvent(p, { kind, ...details });
        rebuildMetadata(p);
        return { ok: true, message: `✅ Event logged: ${kind}`, kind };
      },
    }),

    // ── 12. wiki_watch ───────────────────────────────────────────────────
    defineTool({
      name: "wiki_watch",
      description:
        "Print a ready-to-paste crontab line for scheduling automatic wiki " +
        "updates (discover → ingest → lint). Does NOT schedule anything " +
        "itself — surface the printed line verbatim so the user can install it. " +
        "Do not claim the schedule is active.",
      parameters: {
        interval: {
          type: "string",
          enum: ["daily", "weekly", "hourly", "stop"],
          required: true,
          description: "Cron interval",
        },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "watch failed");
        return String(v.message ?? "");
      }),
      timeoutMs: 10_000,
      async execute(args, exec) {
        if (args.interval === "stop") {
          return {
            ok: true,
            action: "stop_instructions",
            message: [
              "🛑 To stop wiki auto-updates, remove the cron line you installed earlier:",
              "",
              "```bash",
              "crontab -e   # then delete the line tagged '# llm-wiki-autoupdate'",
              "```",
              "",
              "Or list current jobs to confirm:",
              "",
              "```bash",
              "crontab -l | grep llm-wiki-autoupdate",
              "```",
            ].join("\n"),
          };
        }
        const intervals: Record<string, { cron: string; label: string }> = {
          daily: { cron: "0 8 * * *", label: "Daily at 8:00 AM" },
          weekly: { cron: "0 9 * * 1", label: "Weekly on Monday at 9:00 AM" },
          hourly: { cron: "0 * * * *", label: "Every hour" },
        };
        const config = intervals[args.interval as string];
        if (!config) {
          return failResult(
            "bad_interval",
            `Unknown interval: "${args.interval}". Use: daily, weekly, hourly, or stop.`,
          );
        }
        // Headless boot treats positional arguments as one task prompt; it
        // does not execute the UI command plane's slash commands. Spell out
        // the maintenance task so the one-shot agent can use the skill/tools.
        const task =
          "Run the full LLM Wiki maintenance cycle: discover new sources, ingest pending source packets, and lint the wiki. Use the llm-wiki skill and wiki_* tools.";
        const cronLine = `${config.cron} /bin/bash -lc 'mkdir -p "$HOME/.llm-wiki" && cd "$HOME" && dsh headless "${task}" >> "$HOME/.llm-wiki/cron.log" 2>&1' # llm-wiki-autoupdate`;
        return {
          ok: true,
          interval: args.interval,
          cronSchedule: config.cron,
          label: config.label,
          cronLine,
          installed: false,
          message: [
            `⏰ To set up ${config.label} wiki updates, add this line to your crontab.`,
            "**This tool only prints the line — it does not install it.**",
            "",
            "```bash",
            "crontab -e",
            "```",
            "",
            "Then append:",
            "",
            "```cron",
            cronLine,
            "```",
            "",
            "The line uses `/bin/bash -lc` so your shell profile (and the `dsh` binary on PATH) is loaded. Output goes to `~/.llm-wiki/cron.log`.",
          ].join("\n"),
        };
      },
    }),

    // ── 13. wiki_recall ──────────────────────────────────────────────────
    defineTool({
      name: "wiki_recall",
      description:
        "Search the wiki for pages relevant to a query. Searches the resolved " +
        "vault and the personal vault together, deduplicated, with personal hits " +
        "labelled. Returns matching page IDs, titles, types, and content " +
        "previews (small vaults) or ranked links to expand with read (large " +
        "vaults). Use at the start of a task to find relevant wiki knowledge; " +
        "calling it explicitly with specific terms gets better results.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "Search query — use the user's full request or key terms",
        },
        max_results: {
          type: "number",
          description: "Max results (default: 5, max: 10)",
        },
      },
      output: {
        schema: OUT,
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        if (!vaultExists(p)) return noVaultResult();
        const maxResults = Math.min(args.max_results ?? 5, 10);
        const results = searchWikiLayered(p, args.query, maxResults);
        const linksFirst = shouldUseLinksFirst(vaultPageCount(p, true), deps.config);
        return {
          ok: true,
          query: args.query,
          mode: linksFirst ? "links" : "preview",
          matches: results.map((r) => ({
            id: r.id,
            title: r.title,
            type: r.type,
            path: r.path,
            score: r.score,
            vaultLabel: r.vaultLabel ?? null,
            preview: linksFirst ? linkSnippet(r.preview) : r.preview,
          })),
          count: results.length,
        };
      },
    }),

    // ── 14. wiki_retro ───────────────────────────────────────────────────
    defineTool({
      name: "wiki_retro",
      description:
        "Save an atomic insight from a completed task into the wiki. Creates a " +
        "source page. One insight per call; use multiple calls for multiple " +
        "insights. The insight will be auto-surfaced by wiki_recall in future " +
        "sessions. Use at the END of every meaningful task.",
      parameters: {
        slug: {
          type: "string",
          required: true,
          description: "Unique kebab-case identifier (e.g. 'jwt-revocation-pattern')",
        },
        title: {
          type: "string",
          required: true,
          description: "Short descriptive title (60 chars max). Noun phrase.",
        },
        body: {
          type: "string",
          required: true,
          description: "Markdown body with [[wikilinks]] to related wiki pages.",
        },
        category: {
          type: "string",
          description: "Category (e.g. frontend, architecture, devops, bugfix, design)",
        },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "retro failed");
        const gateNote = Array.isArray(v.wikilinkIssues) && v.wikilinkIssues.length
          ? `\n\n⚠️ ${(v.wikilinkIssues as string[]).length} wikilink issue(s):\n${(v.wikilinkIssues as string[]).map((m) => `- ${m}`).join("\n")}`
          : "";
        return [
          `🧠 **Insight saved**: ${v.title}`,
          "",
          `- Page: \`${v.sourcePagePath}\``,
          "",
          "This insight will be auto-surfaced by wiki_recall in future sessions.",
          gateNote,
        ]
          .filter(Boolean)
          .join("\n");
      }),
      timeoutMs: 30_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);

        const mode = resolveWikilinkValidation(deps.config);
        let body = args.body;
        let wikilinkIssues: string[] = [];
        if (mode !== "off") {
          const registry = readJson<{ pages: Record<string, unknown> }>(
            join(p.meta, "registry.json"),
            { pages: {} },
          );
          const gate = applyWikilinkGate(
            body,
            buildWikilinkIndex(Object.keys(registry.pages)),
            `sources/${args.slug}`,
            mode,
          );
          wikilinkIssues = gate.diagnostics.map((d) => d.message);
          if (!gate.ok) {
            return {
              ok: false,
              error: "link_validation",
              message: `Rejected write — unresolved/ambiguous wikilinks:\n${wikilinkIssues.map((m) => `- ${m}`).join("\n")}`,
              wikilinkIssues,
            };
          }
          if (mode === "normalize") body = gate.body;
        }

        let result: { slug: string; sourcePagePath: string };
        try {
          result = saveInsight(p, args.slug, args.title, body, args.category, {
            rebuild: false,
          });
        } catch (error) {
          const msg = (error as Error).message;
          if (msg.startsWith("Invalid insight slug:")) {
            return failResult("invalid_insight_slug", msg);
          }
          throw error;
        }
        scheduleReindex(deps.runtime, launchCtx(deps, exec), p);
        return {
          ok: true,
          slug: result.slug,
          title: args.title,
          category: args.category ?? null,
          sourcePagePath: result.sourcePagePath,
          wikilinkIssues,
        };
      },
    }),

    // ── 15. wiki_observe ─────────────────────────────────────────────────
    defineTool({
      name: "wiki_observe",
      description:
        "Record an atomic observation from the current session into the wiki. " +
        "Observations are timestamped, relevance-rated facts about decisions " +
        "made, findings discovered, constraints established, or work completed. " +
        "Saved observations are searchable via wiki_recall and can later be " +
        "distilled into durable wiki pages via wiki_ensure_page. Call this " +
        "proactively after non-trivial work — every observation compounds the " +
        "wiki's knowledge across sessions. One observation per call; rate " +
        "relevance honestly.",
      parameters: {
        title: {
          type: "string",
          required: true,
          description: "Short descriptive title (≤80 chars). Noun phrase, not a sentence.",
        },
        content: {
          type: "string",
          required: true,
          description:
            "The observation in plain prose. Preserve specifics: file paths, function names, error messages, quantitative results.",
        },
        relevance: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          description:
            "Relevance level: low (routine), medium (task context), high (non-trivial decisions/constraints), critical (user identity, persistent preferences). Default: medium.",
        },
        tags: {
          type: "string",
          description: "Optional space-separated tags for categorization",
        },
        source_context: {
          type: "string",
          description: "What was being worked on",
        },
      },
      output: textOut((v) => {
        if (v.ok !== true) return String(v.message ?? "observe failed");
        return [
          `🔍 **Observation saved**: ${v.title}`,
          "",
          `- Page: \`${v.pagePath}\``,
          `- Relevance: ${v.relevance}`,
          v.tags ? `- Tags: ${v.tags}` : "",
          "",
          "This observation is now searchable via wiki_recall.",
        ]
          .filter((l) => l !== "")
          .join("\n");
      }),
      timeoutMs: 30_000,
      async execute(args, exec) {
        const p = paths(deps, exec);
        const check = inspectWritableVault(p);
        if (!check.ok) return vaultFail(check);

        const relevance = (args.relevance as "low" | "medium" | "high" | "critical") ?? "medium";
        let result: { slug: string; pagePath: string };
        try {
          result = saveObservation(
            p,
            {
              title: args.title,
              content: args.content,
              relevance,
              tags: args.tags,
              source_context: args.source_context,
            },
            { rebuild: false },
          );
        } catch (error) {
          return failResult("observe_failed", (error as Error).message);
        }
        markObserved(deps.reminderStates, exec.agent);
        scheduleReindex(deps.runtime, launchCtx(deps, exec), p);
        return {
          ok: true,
          slug: result.slug,
          title: args.title,
          relevance,
          tags: args.tags ?? null,
          pagePath: result.pagePath,
        };
      },
    }),
  ];
}
