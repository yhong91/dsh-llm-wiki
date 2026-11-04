import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Host adapter for the coding agents whose settings layouts this engine reads:
 *
 *  - **pi**   — pi coding agent, config dir `.pi`
 *  - **omp**  — oh-my-pi, config dir `.omp`
 *  - **dsh**  — DeepSeek Harness, config dir `.dsh`
 *
 * omp rewrites `pi-*` package imports (and bare `typebox`) onto its own
 * bundled packages at load time (its `legacy-pi-compat.ts`), so the *module
 * graph* needs no changes. What does differ is the on-disk config layout:
 *
 * | | pi | omp | dsh |
 * |---|---|---|---|
 * | user dir      | `~/.pi/agent`   | `~/.omp/agent` | `~/.dsh` |
 * | project dir   | `<cwd>/.pi`     | `<cwd>/.omp`   | `<cwd>/.dsh` |
 * | settings file | `settings.json` | `settings.json`, then `config.yml` | `settings.json` |
 *
 * omp explicitly does **not** read `.pi` (its config source order is
 * `.omp` → `.claude` → `.codex` → `.gemini`), so a wiki configured under pi
 * would silently lose its settings after switching hosts. This module keeps
 * all layouts readable and picks a sensible file to write to.
 *
 * Everything here is additive: on pi with only a `.pi/` directory the effective
 * behaviour is identical to the pre-compat code path, which keeps upstream
 * merges clean.
 */

export type HostKind = "pi" | "omp" | "dsh";

/** Project config directory name per host. */
const CONFIG_DIR: Record<HostKind, string> = { pi: ".pi", omp: ".omp", dsh: ".dsh" };

/** Settings file names inside a config directory, lowest → highest precedence. */
const SETTINGS_FILES = ["settings.json", "config.yml", "config.yaml"] as const;

/**
 * The hosting agent's user-level config directory, first hit wins:
 * `PI_CODING_AGENT_DIR` override → `~/.pi/agent` → `~/.omp/agent` → `~/.dsh`
 * → `~/.pi/agent` as the historical default when nothing is on disk yet.
 */
function resolveAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  const home = homedir();
  for (const candidate of [
    join(home, ".pi", "agent"),
    join(home, ".omp", "agent"),
    join(home, ".dsh"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(home, ".pi", "agent");
}

/**
 * Detect which agent is hosting this extension.
 *
 * Ordered by reliability:
 *  1. `LLM_WIKI_HOST` — explicit escape hatch (tests, exotic embeddings).
 *  2. The agent directory path: pi resolves `~/.pi/agent`, omp `~/.omp/agent`,
 *     dsh `~/.dsh`. A `PI_CODING_AGENT_DIR` override that keeps the marker
 *     segment still classifies correctly; anything else falls through.
 *  3. `OMP_PROFILE`, which omp sets on itself whenever a profile is active.
 *  4. Default `pi` — the historical behaviour.
 */
export function detectHost(): HostKind {
  const forced = process.env.LLM_WIKI_HOST?.trim().toLowerCase();
  if (forced === "omp" || forced === "pi" || forced === "dsh") return forced;

  let agentDir = "";
  try {
    agentDir = resolveAgentDir();
  } catch {
    agentDir = "";
  }
  if (agentDir) {
    const segments = agentDir.split(/[\\/]/);
    if (segments.includes(".omp")) return "omp";
    if (segments.includes(".pi")) return "pi";
    if (segments.includes(".dsh")) return "dsh";
  }

  if (process.env.OMP_PROFILE) return "omp";
  return "pi";
}

/**
 * Every project settings file that may hold `llm-wiki` configuration, ordered
 * from lowest to highest precedence so callers can merge left-to-right.
 *
 * The host's *native* directory is last (wins). The foreign directories are
 * still read so a vault configured under pi keeps working after omp or dsh
 * takes over the repository, and vice versa. Within a directory `config.yml`
 * follows `settings.json`, matching omp's own project-settings precedence.
 */
export function listProjectSettingsFiles(cwd: string, host: HostKind = detectHost()): string[] {
  const foreign: HostKind[] = (["pi", "omp", "dsh"] as HostKind[]).filter((k) => k !== host);
  const files: string[] = [];
  for (const kind of [...foreign, host]) {
    const dir = join(cwd, CONFIG_DIR[kind]);
    for (const name of SETTINGS_FILES) files.push(join(dir, name));
  }
  return files;
}

/**
 * User-level settings files, lowest → highest precedence.
 *
 * The agent dir already resolves per host (`~/.pi/agent` vs `~/.omp/agent` vs
 * `~/.dsh`), so only the file names differ: omp migrates `settings.json` into
 * `config.yml` on first start, and a migrated install has *only* the YAML file.
 */
export function listGlobalSettingsFiles(): string[] {
  let agentDir = "";
  try {
    agentDir = resolveAgentDir();
  } catch {
    return [];
  }
  if (!agentDir) return [];
  return SETTINGS_FILES.map((name) => join(agentDir, name));
}

/**
 * The project settings file this extension writes to.
 *
 * Always JSON (`settings.json`) — all hosts read it, and rewriting a user's
 * hand-authored `config.yml` would destroy comments and formatting.
 *
 * Directory choice: an already-existing project config directory wins (so a
 * repo that only has `.pi/` keeps a single settings file), otherwise the
 * detected host's native directory is created.
 */
export function resolveProjectSettingsPath(cwd: string, host: HostKind = detectHost()): string {
  const native = join(cwd, CONFIG_DIR[host]);
  if (existsSync(native)) return join(native, "settings.json");

  for (const kind of (["pi", "omp", "dsh"] as HostKind[]).filter((k) => k !== host)) {
    const foreign = join(cwd, CONFIG_DIR[kind]);
    if (existsSync(foreign)) return join(foreign, "settings.json");
  }

  return join(native, "settings.json");
}

/**
 * The global (user-level) settings file this extension writes to.
 *
 * Always writes to `settings.json` inside the agent dir — all hosts read it.
 */
export function resolveGlobalSettingsPath(_host: HostKind = detectHost()): string {
  let agentDir = "";
  try {
    agentDir = resolveAgentDir();
  } catch {
    agentDir = "";
  }
  if (!agentDir) {
    // Fallback: ~/.pi/agent/settings.json
    const home = process.env.HOME || "~";
    return join(home, ".pi", "agent", "settings.json");
  }
  return join(agentDir, "settings.json");
}
