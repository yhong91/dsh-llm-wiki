import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { parse as parseYaml } from "yaml";

/**
 * Bundled `llm-wiki` skill provider.
 *
 * `skills/llm-wiki/SKILL.md` is part of the package, but DSH does not scan a
 * package's `skills/` directory by itself: the skill subsystem only merges
 * providers registered through `ctx.skills`. Without this registration the
 * `/wiki-*` command bodies that tell the agent to invoke the `llm-wiki` skill
 * would point at a skill the `skill` tool cannot find.
 *
 * Registration is optional at the plugin level (`ctx.inject(["skills"], ...)`)
 * so a minimal profile without the skills service still loads the tools and
 * ambient surfaces. The provider follows the documented bundled-skill shape:
 * one immutable candidate at the bundled rank (600), with the package's
 * `skills/llm-wiki` directory as its resource base.
 */

const PROVIDER_NAME = "llm-wiki";
const BUNDLED_SKILL_RANK = 600;
const SKILL_FILE = fileURLToPath(new URL("../../skills/llm-wiki/SKILL.md", import.meta.url));
const SKILL_DIR = fileURLToPath(new URL("../../skills/llm-wiki/", import.meta.url));

interface SkillInvocation {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

interface SkillResourceBase {
  readonly kind: "directory";
  readonly path: string;
}

interface SkillCandidate {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: SkillInvocation;
  readonly source: string;
  readonly provider: string;
  readonly resourceBase?: SkillResourceBase;
  readonly path?: string;
  readonly rank: number;
  readonly locator: unknown;
}

interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: SkillInvocation;
  readonly source: string;
  readonly provider: string;
  readonly resourceBase?: SkillResourceBase;
  readonly path?: string;
  readonly content: string;
}

interface SkillProvider {
  readonly name: string;
  list(): Promise<readonly SkillCandidate[]>;
  get(candidate: unknown): Promise<SkillDefinition | undefined>;
}

interface SkillsService {
  registerProvider(create: () => SkillProvider): unknown;
}

interface LoadedSkill {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly content: string;
}

function loadSkillFile(): LoadedSkill | undefined {
  let raw: string;
  try {
    raw = readFileSync(SKILL_FILE, "utf8");
  } catch {
    return undefined;
  }

  // The skill file's frontmatter is the source of truth for the catalog
  // summary; the body (without frontmatter) is what the skill tool renders.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  let metadata: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parseYaml(match[1]);
      if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const description =
    typeof metadata.description === "string" ? metadata.description.trim() : "";
  if (!name || !description) return undefined;

  return {
    name,
    description,
    ...(typeof metadata.whenToUse === "string" ? { whenToUse: metadata.whenToUse } : {}),
    content: match ? raw.slice(match[0].length) : raw,
  };
}

/**
 * Register the package's skill as a bundled provider. A missing skills service
 * or an unreadable skill file is deliberately silent: the rest of the plugin
 * must remain usable in minimal profiles.
 */
export function registerSkill(ctx: Context): void {
  const loaded = loadSkillFile();
  if (!loaded) return;

  const invocation: SkillInvocation = { modelInvocable: true, userInvocable: true };
  const resourceBase: SkillResourceBase = { kind: "directory", path: SKILL_DIR };
  const candidate: SkillCandidate = {
    name: loaded.name,
    description: loaded.description,
    ...(loaded.whenToUse ? { whenToUse: loaded.whenToUse } : {}),
    invocation,
    source: "bundled",
    provider: PROVIDER_NAME,
    resourceBase,
    path: SKILL_FILE,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_FILE,
  };
  const provider: SkillProvider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    get: () =>
      Promise.resolve({
        name: candidate.name,
        description: candidate.description,
        ...(candidate.whenToUse ? { whenToUse: candidate.whenToUse } : {}),
        invocation,
        source: candidate.source,
        provider: candidate.provider,
        resourceBase,
        path: candidate.path,
        content: loaded.content,
      }),
  };

  const injectable = ctx as Context & {
    inject(services: string[], callback: (child: Context) => void): unknown;
  };
  injectable.inject(["skills"], (skillCtx) => {
    const skills = (skillCtx as Context & { skills?: SkillsService }).skills;
    skills?.registerProvider(() => provider);
  });
}

export { loadSkillFile };
