---
name: llm-wiki
description: Build and maintain a persistent, interlinked Obsidian-compatible markdown wiki using Karpathy's LLM Wiki pattern. Plugin-backed with auto-generated metadata, guardrails, and 15 wiki_* tools (+3 opt-in agent-trajectory tools).
whenToUse: Call wiki_recall at task start to find relevant wiki pages. Call wiki_retro at task end to save new insights. When agent-trajectory working-memory is enabled (opt-in), also call wiki_recall_skill at task start to find reusable skills / past cases ("have I done this before?") and wiki_capture_trajectory after non-trivial tasks to record how you solved them. The plugin injects a brief status line, but explicit calls with task-specific terms get better results.
---

# LLM Wiki for dsh

You are a disciplined wiki maintainer. The plugin handles all mechanical work — you focus on synthesis, reasoning, and knowledge organization.

## Architecture (4 Layers)

```
WIKI_ROOT/
└── .llm-wiki/                 # All wiki content (one dot-dir)
    ├── config.json            # Vault config
    ├── templates/             # Page templates
    ├── raw/sources/SRC-*/     # Immutable source packets (plugin-owned)
    │   ├── manifest.json
    │   ├── original/
    │   ├── extracted.md
    │   └── attachments/
    ├── raw/trajectories/TRJ-*/ # Immutable agent task packets (plugin-owned)
    │   ├── manifest.json      # Capture metadata (format: trajectory)
    │   ├── packet.json        # Full tool-call sequence
    │   └── extracted.md       # README summary
    ├── wiki/                  # Editable knowledge pages (you own this)
    │   ├── sources/           # One summary per source
    │   ├── entities/          # People, orgs, tools, products
    │   ├── concepts/          # Ideas, patterns, frameworks
    │   ├── syntheses/         # Cross-cutting analyses
    │   ├── analyses/          # Durable query answers
    │   ├── cases/             # One specific past task per trajectory
    │   └── skills/            # Reusable patterns distilled from trajectories
    ├── meta/                  # Durable events + generated projections (plugin-owned)
    │   ├── registry.json      # Master page catalog
    │   ├── backlinks.json     # Inbound link map
    │   ├── index.md           # Human-readable catalog
    │   ├── log.md             # Activity log
    │   ├── events.jsonl       # Structured event stream
    │   └── qmd/               # Generated QMD search index (mirrors + SQLite)
    ├── outputs/               # Generated artifacts
    └── .discoveries/          # Discovery tracking
```

> `meta/qmd/` is plugin-owned, generated, and **rebuildable** with `wiki_reindex`. It never
> scans `wiki/` directly — it indexes parser-valid mirrors. Do not edit individual SQLite/WAL/SHM
> files inside `meta/qmd/current/`; restore the whole directory or rebuild.

## Golden Rules

1. **RAW IS IMMUTABLE.** Never edit `raw/`. Use `wiki_capture_source` to add sources.
2. **META IS PLUGIN-OWNED.** Never edit `meta/` directly. `events.jsonl` is append-only authoritative activity state; other metadata files are generated projections.
3. **YOU OWN THE WIKI.** Create, update, and cross-reference everything in `wiki/`.
4. **ONE FILE PER THING.** Each entity, concept, source gets its own `.md` file.
5. **CROSS-REFERENCE EVERYTHING.** Every page needs at least 2 links. Prefer standard Markdown: `[label](/folder/page.md)`. Legacy wikilinks `[[folder/page]]` remain readable.
6. **CITE SOURCES.** Every claim links back to its raw source packet.
7. **FLAG CONTRADICTIONS.** When sources disagree, document both sides.

> Preserve `meta/events.jsonl` in full-vault backups. `meta/log.md` and `wiki/log.md` cannot reconstruct it. Do not place secrets or private machine paths in manual event details.

## Agent Working-Memory (Trajectories)

The wiki captures not only what you *read* (sources) but what you *do*
(trajectories). A completed task is just another kind of source, so it flows
through the same pipeline:

```
raw/trajectories/TRJ-*  →  wiki/skills/*  (+ optional wiki/cases/*)  →  meta/*
```

> **Opt-in, off by default.** The three tools below are only registered
> when the `trajectories` plugin config is enabled (`/wiki-trajectories on`,
> then restart DSH). When off, the tools are absent entirely; do not call
> them.

- `wiki_capture_trajectory` writes the immutable packet + a **self-contained summary**
  (`extracted.md`), auto-extracting the tool-call sequence from the live session (you
  usually only pass a `title`).
- `wiki_distill_skills` returns undistilled trajectories so you can generalize them
  into reusable `skill` pages (and optionally `case` pages) via `wiki_ensure_page`.
- `wiki_recall_skill` filters layered recall to `skill`/`case` pages —
  "have I done something like this before?". Call it at task start.

A **skill** generalizes across many trajectories ("how I do X"); a **case** is one
concrete past run ("the time I did X for project Y"). Trajectory packets live under
`raw/**` and are therefore immutable under the same guardrail as source packets —
edit the `case`/`skill` pages, never the packet.

### When to use which memory tool

| Tool | Stores | Use for |
|------|--------|---------|
| `wiki_capture_trajectory` | A structured, **replayable** tool-call packet (`packet.json`: tool names + arguments + results + errors) | "How did I *mechanically* solve this?" — the exact step sequence, to distill into a repeatable skill |
| `wiki_retro` | A durable prose **insight** (one markdown file) | "What did I learn?" — a lesson/gotcha worth keeping, not a step list |
| `wiki_observe` | A timestamped prose **observation** | Lightweight running notes the plugin reminds you to jot during a task |

## 🔄 Wiki Usage

### At Start — Call wiki_recall

**Call `wiki_recall` at the START of every task** to find relevant wiki pages:

```
wiki_recall(query="key terms from the user's request", max_results=5)
```

This searches both your **personal wiki** (`~/.llm-wiki/`) and the **project wiki** (`.llm-wiki/` in the current directory), merging results.

The plugin also briefly searches automatically, but explicit calls with task-specific terms get better results.

#### Two-Stage Recall (links-first for large vaults)

Recall scales with vault size via **two-stage retrieval** (memex-style):

- **Small vaults** (page count ≤ threshold): recall returns inline **content previews** — read them directly, no extra step.
- **Large vaults** (page count > threshold): recall returns a **ranked list of links** only — `id`, `title`, `type`, `score`, and a 1-line snippet. **No full previews are injected**, to protect your context window.

**The two-step contract for large vaults:**

1. **Stage 1 — scan the links.** `wiki_recall` gives you ranked `[[id]]` links with scores and short snippets. Use the scores and snippets to pick the few pages that actually matter.
2. **Stage 2 — expand on demand.** Call `read` on the chosen link **paths** to pull their full content. Do **not** assume the snippet is the whole page — open the link before relying on its content.

The gate is the `recallLinksThreshold` setting (default **50** pages). Page count is read from `meta/registry.json` (O(1), no page-body I/O).

**Skills/cases carve-out:** distilled `skill`/`case` pages are meant to be **applied immediately**, so recall inlines their short body directly instead of a bare link the agent tends to skip. The `recallSkillInlineMax` setting (default **1600** chars) caps how much body is inlined; `0` disables inlining. Only relevant when trajectories are enabled.

### At End — Save Insights with wiki_retro

After completing any meaningful task, call `wiki_retro` to save key insights:
- Non-obvious bug fixes or workarounds
- Architectural decisions and their rationale
- Tool/library gotchas you discovered
- Patterns worth remembering for future sessions

**Do not wait for the user to ask.** Save insights proactively — one atomic insight per call.

```
wiki_retro(slug="kebab-case-slug", title="Brief descriptive title", body="Insight in your own words with [links](/folder/page.md)")
```

### Deeper Searches

For thorough research, also use `wiki_search` to browse the full registry:

```
wiki_search(query="broad topic")
```

### Auto-Bootstrap (One-Time)

The plugin creates the wiki vault automatically on startup when ambient apply conditions are met. On the first turn it may inject a directive asking you to infer topic and mode, then call:

```
wiki_bootstrap(topic="...", mode="personal|company")
```

This is a one-time step.

## Available Tools

Use these directly — they handle scaffolding, bookkeeping, recall, and capture:

- `wiki_bootstrap` — Initialize a new vault
- `wiki_capture_source` — Capture URL/file/text into immutable packet + skeleton page
- `wiki_ingest` — Get batch of uningested sources with extracted text
- `wiki_ensure_page` — Create entity/concept/synthesis/analysis/requirement/skill/case page from template
- `wiki_search` — Search registry for existing pages
- `wiki_lint` — Health check (orphans, missing, contradictions, gaps)
- `wiki_status` — Instant stats
- `wiki_rebuild_meta` — Force metadata rebuild
- `wiki_reindex` — Rebuild/repair the generated QMD search index
- `wiki_reindex_embeddings` — Backfill/refresh semantic embeddings
- `wiki_log_event` — Record a custom event
- `wiki_watch` — Print a crontab line for auto-updates (prints only, installs nothing)
- `wiki_recall` — Search both personal + project wikis for task-relevant pages
- `wiki_retro` — Save an atomic insight from a completed task into the wiki
- `wiki_observe` — Record an atomic observation from the current session

Opt-in trajectory tools (registered only when `trajectories` is enabled, not yet wired in this build):

- `wiki_capture_trajectory` — Capture the completed task's tool-call trajectory (working-memory)
- `wiki_distill_skills` — Batch undistilled trajectories for skill synthesis
- `wiki_recall_skill` — Recall distilled skills + similar past cases

## Slash Commands

The plugin registers `/wiki-*` commands that steer instruction templates into the agent: `wiki-init`, `wiki-status`, `wiki-query`, `wiki-ingest`, `wiki-discover`, `wiki-lint`, `wiki-run`, `wiki-retro`, `wiki-record`, `wiki-skills`, `wiki-req`, `wiki-digest`. Each drives the tools above.

## Workflows

### Capture → Ingest → Synthesize

1. **Capture**: `wiki_capture_source(url="...")` → creates packet + skeleton
2. **Ingest**: `wiki_ingest()` → get batch of sources needing synthesis
3. **Read**: `read raw/sources/SRC-*/extracted.md`
4. **Write**: Update skeleton source page with summary, entities, concepts
5. **Ensure**: `wiki_ensure_page(type="entity", title="...")` for each entity
6. **Cross-ref**: Add `[links](/folder/page.md)` between related pages
7. **Done**: Plugin auto-rebuilds metadata

### Query → Answer → File

1. **Layered recall**: Plugin searches personal + project vaults, injects matching pages with vault labels
2. For better results: call `wiki_recall` explicitly with task-specific terms
3. Read those pages
4. Synthesize answer with `[link](/folder/page.md)` citations
5. If novel: create analysis page via `wiki_ensure_page(type="analysis")`
6. Plugin auto-updates metadata

### Task → Capture → Retro

1. Complete a meaningful task
2. Call `wiki_retro` to save key insights
3. The insight is saved as a single markdown file
4. Plugin auto-updates metadata
5. Next time, layered recall surfaces your saved insight

### Task → Record → Distill (agent working-memory, opt-in)

1. Finish a non-trivial task (debug, refactor, integration)
2. `wiki_capture_trajectory(title="...")` — auto-extracts the tool-call trajectory into `raw/trajectories/TRJ-*`
3. Flesh out the `wiki/cases/` page (Task → Approach → Outcome)
4. `wiki_distill_skills()` — get undistilled trajectories
5. `wiki_ensure_page(type="skill", title="...")` — generalize into a reusable skill citing `[[trajectories/TRJ-...]]`
6. Next time, `wiki_recall_skill(query="...")` surfaces the skill/case before you start

## Page Conventions

### Naming

- `kebab-case.md` for all files
- Standard Markdown links: `[label](/concepts/retrieval-augmented-generation.md)`
- Legacy wikilinks still readable: `[[concepts/retrieval-augmented-generation]]`

### Frontmatter

```yaml
---
type: entity | concept | source | synthesis | analysis | skill | case | trajectory
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [sources/SRC-YYYY-MM-DD-NNN]
---
```

Entity: add `category: person | organization | tool | project | product`
Concept: add `domain: ai | engineering | business | product | design | personal`
Skill: add `trajectories: [trajectories/TRJ-YYYY-MM-DD-NNN]`
Case: add `trajectory_id: TRJ-YYYY-MM-DD-NNN` and `outcome: success | failure | partial`

### Citations

Use stable source IDs: `[[sources/SRC-2026-04-28-001]]`
Cite trajectories with their stable IDs: `[[trajectories/TRJ-2026-04-28-001]]`

### Contradictions

```markdown
> ⚠️ **Contradiction:** Source A claims X, but Source B claims Y.
> See [[page-a]] and [[page-b]].
```

## Variants

### Personal Wiki

- Extra: `wiki/journal/`, `wiki/goals/`
- Track: learning, books, health, reflections

### Company Wiki

- Extra: `wiki/changes/`, `wiki/decisions/`
- Track: competitors, market, strategy
- Frontmatter: `confidence: high | medium | low`

## Obsidian Integration

Open `wiki/` as an Obsidian vault. The plugin generates:

- `meta/index.md` — browsable catalog
- `meta/backlinks.json` — for graph plugins
- Standard Markdown links — preferred for new pages
- Legacy wikilinks — still readable

Recommended plugins: Dataview, Graph View, Backlinks

## Tips

- **Start small:** 3-5 sources, let it grow organically
- **Batch efficiently:** Plan all pages for a source, then write them rapidly
- **Trust the plugin:** Never waste tokens updating INDEX.md or LOG.md manually
- **Evolve the schema:** Update `WIKI_SCHEMA.md` as conventions mature
