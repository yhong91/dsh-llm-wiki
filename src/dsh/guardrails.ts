import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { scheduleReindex } from "../engine/indexing.js";
import type { Runtime } from "../engine/runtime.js";
import {
  detectVaultFormat,
  getLegacyVaultPaths,
  getVaultPaths,
  isPathWithin,
  isProtectedPath,
  type VaultPaths,
} from "../engine/utils.js";
import { inspectVaultFormat, isGeneratedOkfPath } from "../engine/vault-format.js";

/**
 * Vault ownership guardrails — the dsh port of upstream pi-llm-wiki's
 * `lib/guardrails.ts` (reference/pi-llm-wiki/extensions/llm-wiki/lib/) and the
 * Claude Code `guard-llm-wiki-edit.mjs` PreToolUse hook.
 *
 * The ownership rules (vault-format contract, notes/vault-compatibility.md):
 *
 *  - `raw/**`            immutable source material; only wiki_capture_source writes it
 *  - `meta/**`           generated projections; only engine code writes it
 *  - `meta/events.jsonl` append-only authoritative log; only wiki_log_event/appendEvent
 *  - `wiki/**`           model-and-user editable, EXCEPT generated OKF indexes
 *                        (`index.md` at any depth, root `log.md`) in an okf-0.2 vault
 *  - a vault whose format is blocking (bad config, okf_version ≠ "0.2") is
 *    read-only end to end: any write inside `.llm-wiki/` denies fail-closed
 *
 * Scope: these guardrails govern tool calls dispatched THROUGH the dsh tool
 * pipeline only. The Claude Code plugin writing the same vault is unaffected
 * (different process, different hook system) — they never block it, and must
 * never try to.
 *
 * Seam choice (notes/dsh-plugin-capabilities.md "Policy hooks"): everything
 * goes through `ctx.tools.guard()`, the monotonic deny seam, rather than the
 * `tools/pre-execute` waterfall.
 *
 *  - Guards run AFTER the extensible pre-execute waterfall and return a final
 *    denial reason "no listener ordering can turn back into permission" — the
 *    exact semantics upstream's unconditional `tool_call` veto had. A
 *    waterfall deny is equally final to the pipeline, but a guard is also
 *    immune to future listeners that might wrap `next()` and rewrite a deny.
 *  - Guards are synchronous, which fits this work: vault checks are a handful
 *    of `existsSync`/path-string operations, so there is nothing to await and
 *    no `exec.signal` race to observe.
 *  - One seam covers every tool family uniformly; per-tool-family branching
 *    lives inside the single guard as argument extraction, not registration.
 *
 * Two tool families carry mutating file paths in dsh-base:
 *
 *  - `write` / `edit` (dsh-tool-fs): structured `file_path` argument. Exact
 *    check; the path is resolved against the caller's session cwd the same
 *    way the fs backend resolves it (absolute → as-is; relative → session
 *    working dir, approximated by deps.cwd()).
 *  - `bash` / `pwsh` (dsh-tool-bash{,-persistent}, dsh-tool-pwsh): a raw
 *    `command` string. Full shell parsing is out of scope (documented
 *    limitation, mirroring upstream's own "blunt but sufficient" 19-line
 *    regex for Claude Code). We scan for tokens that are unambiguous write
 *    targets — redirection operands, mutating-command operands, PowerShell
 *    verb operands — and deny only when a resolved target lands inside a
 *    real vault's protected area. Ambiguous commands are allowed: better to
 *    miss an exotic write than to deny legitimate shell work.
 *    `workdir` is honored when present; `cd`/`Set-Location` retargets the
 *    base for later tokens within the same command line.
 *
 * `glob`/`grep`/`read`/`read_image` cannot mutate; they are ignored.
 *
 * Vault detection is physical, not name-based: a candidate path belongs to a
 * vault only when an ancestor directory on disk actually holds `.llm-wiki/` or
 * `.wiki/`, and the protected-roots computation resolves symlinks through the
 * engine's `relativePhysicalPath` (the #145 atomic-OS symlinked-$HOME fix).
 * A `raw/` directory in an unrelated project is never blocked.
 *
 * Never throws: a throwing guard would deny (or worse, fault) every tool call
 * in the host. Every failure mode — unreadable dirs, symlink cycles, odd
 * argument shapes — resolves to allow, except path resolution failure inside
 * an already-confirmed vault, which denies fail-closed (mirroring
 * `isProtectedPath`'s own catch arm).
 */

/** The dsh-side contract registerGuardrails needs from index.ts. */
export interface GuardrailDeps {
  /**
   * Resolve the session working directory. Used as the base for relative
   * `file_path`/`workdir` arguments — the same approximation tools.ts's
   * private `paths()` helper makes for vault resolution (this module does not
   * import that helper; it is not exported, so vault resolution here works on
   * ancestor discovery instead — see findEnclosingVault).
   */
  cwd(): string;
  /** Optional per-agent session directory resolver (DSH workingDirectory). */
  cwdFor?(agent?: unknown): string;
  /**
   * Shared background runtime, used by the optional dirty-tracking half of
   * upstream's guardrails (tool_result → turn_end scheduleReindex). May be
   * omitted to register the deny guard alone.
   */
  runtime?: Runtime;
}

/**
 * Mutating-tool → the argument key carrying the target file path.
 * dsh-tool-fs registers `write` and `edit` with a required `file_path`.
 * A map keeps the family open: another structured file-mutating tool can be
 * added by extending PATH_ARG_BY_TOOL, not by editing the guard.
 */
const PATH_ARG_BY_TOOL: Record<string, string> = {
  write: "file_path",
  edit: "file_path",
};

/** dsh-base tools that execute a raw shell command string. */
const SHELL_ARG_BY_TOOL: Record<string, string> = {
  bash: "command",
  pwsh: "command",
};

/**
 * POSIX-ish command names whose operands are filesystem write targets.
 * Matching is basename-based (bare `rm`, `/bin/rm`, `sudo rm` after stripping
 * prefixes) and case-sensitive — POSIX commands are.
 *
 * Only commands whose primary effect is mutation are listed; readers (cat,
 * ls, grep, sed-without--i) are intentionally absent so a command like
 * `cat .llm-wiki/raw/x` still runs. `cp`/`mv`/`ln` check every operand: both
 * "copy INTO the vault" and "move a protected file OUT" are mutations of the
 * ownership rule, so source-side denies are correct, not just tolerated.
 * `dd` is included for the `of=` operand form; its `if=` source is also
 * filtered out by the `key=value` operand skip.
 */
const POSIX_WRITE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "ln",
  "mkdir",
  "touch",
  "tee",
  "install",
  "truncate",
  "dd",
  "rsync",
  "scp",
  "chmod",
  "chown",
  "chgrp",
  "xattr",
  "patch",
]);

/**
 * PowerShell/cmd aliases whose operands are write targets. Lower-cased before
 * lookup; covers the native verbs plus the POSIX aliases pwsh predefines.
 */
const PWSH_WRITE_COMMANDS = new Set([
  "out-file",
  "set-content",
  "add-content",
  "remove-item",
  "rename-item",
  "move-item",
  "copy-item",
  "new-item",
  "clear-content",
  "set-item",
  "del",
  "erase",
  "rd",
  "ren",
  "move",
  "copy",
  "ni",
  "md",
  "sc",
  "ac",
  "ri",
]);

/**
 * Command tokens that change the effective working directory mid-line; the
 * operand becomes the base for subsequent relative targets.
 */
const CD_COMMANDS = new Set(["cd", "pushd", "set-location", "sl", "chdir"]);

/**
 * Wrapper prefixes that carry no write semantics of their own; skipped when
 * resolving the effective command name (e.g. `sudo rm -rf x` → rm).
 */
const COMMAND_PREFIXES = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "command",
  "builtin",
  "exec",
  "xargs",
  "time",
  "nice",
  "ionice",
  "stdbuf",
]);

/** Tokens that end a simple command and start the next one. */
const COMMAND_SEPARATORS = new Set(["&&", "||", ";", "|", "|&", "&"]);

/**
 * Strip one layer of surrounding quotes. Returns undefined for mismatched or
 * empty results — a token we cannot normalize is a token we cannot accuse,
 * and the shell scanner is allow-on-ambiguity by contract.
 */
function unquote(token: string): string | undefined {
  const t = token.trim();
  if (!t) return undefined;
  const first = t[0];
  const last = t[t.length - 1];
  const quoted = first === '"' || first === "'";
  if (quoted !== (last === '"' || last === "'") || (quoted && first !== last)) {
    return undefined;
  }
  const inner = quoted ? t.slice(1, -1) : t;
  return inner || undefined;
}

/**
 * Expand a leading `~` (or `~/`) to the home directory. Mirrors what the
 * shell does before the fs layer sees the path; `~user` forms are left alone
 * (rare, and an unresolvable base is a safe miss, not a false deny).
 */
function expandTilde(token: string): string {
  if (token === "~") return homedir();
  if (token.startsWith(`~${sep}`) || token.startsWith("~/")) {
    return join(homedir(), token.slice(2));
  }
  return token;
}

/**
 * Resolve a candidate path to absolute form against `base`. No normalization
 * beyond `resolve` — symlinks are resolved later by `relativePhysicalPath`,
 * which is the only resolution the vault-containment check trusts.
 */
function toAbsolute(candidate: string, base: string): string | undefined {
  const expanded = expandTilde(candidate);
  if (!expanded) return undefined;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/**
 * Find the vault that physically contains `absPath`, if any.
 *
 * Walks ancestors from the candidate's directory upward; the first ancestor
 * holding `.llm-wiki/` or `.wiki/` wins. A new-layout vault's dot-dir is also
 * an ancestor of protected paths (`<root>/.llm-wiki/raw/x`), so the walk
 * detects it at `<root>`. A legacy vault's protected trees sit BESIDE the
 * dot-dir (`<root>/raw`), which the same walk catches at `<root>` via `.wiki`.
 *
 * Deliberately does NOT use `resolveVaultPaths`/`resolveProjectVaultRoot`:
 * those answer "which vault governs this cwd" for the ambient/tool layer.
 * The guardrail asks a different question — "is THIS path inside ANY real
 * vault" — because a bash command can reach any directory on the machine,
 * including the personal vault, from any cwd.
 *
 * Returns the VaultPaths for the enclosing vault, or undefined when no
 * ancestor holds a vault dot-dir (the fail-open non-vault path).
 */
function findEnclosingVault(absPath: string): VaultPaths | undefined {
  // Start at the candidate itself when it exists as a directory (e.g.
  // `rm -rf <root>` or `mkdir <root>/raw`), else at its parent — a file
  // named `x` inside `raw/` is found via `raw/`'s ancestors, never `x/`.
  let current = absPath;
  try {
    if (!statSync(current).isDirectory()) current = dirname(current);
  } catch {
    current = dirname(current);
  }

  while (true) {
    let format: ReturnType<typeof detectVaultFormat>;
    try {
      format = detectVaultFormat(current);
    } catch {
      format = "none";
    }
    if (format !== "none") {
      // The personal vault is not exempted by ancestry: a path inside
      // ~/.llm-wiki/** IS personal-vault content and is governed regardless
      // of session cwd. The walk returns it here; isProtectedPath does the
      // rest.
      return format === "legacy" ? getLegacyVaultPaths(current) : getVaultPaths(current);
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Deny reason for `absPath`, or undefined when the write is allowed.
 *
 * One decision, three gates, mirroring upstream mutationBlockReason:
 *
 *  1. Not inside any vault → allow (guardrails govern vault protection, not
 *     general filesystem policy — a `raw/` dir in an unrelated project is
 *     none of our business).
 *  2. Inside a vault → isProtectedPath (raw/**, meta/**, events.jsonl).
 *  3. Inside the dot-dir while the vault format blocks → deny everything
 *     (fail-closed, upstream lines 208-213).
 *  4. Inside wiki/** but a generated OKF projection (index.md at any depth,
 *     root log.md) → deny so hand edits can't fight the rebuild pipeline.
 *
 * Path-resolution failure inside a confirmed vault denies (isProtectedPath's
 * own catch arm); failure to even locate a vault ancestor allows.
 */
export function mutationDenyReason(absPath: string): string | undefined {
  const paths = findEnclosingVault(absPath);
  if (!paths) return undefined;

  const protectedPath = isProtectedPath(absPath, paths);
  if (protectedPath.protected) return protectedPath.reason;

  if (isPathWithin(paths.dotWiki, absPath)) {
    const state = inspectVaultFormat(paths);
    if (state.blocking) {
      return `Wiki vault configuration is invalid: ${state.diagnostics[0].message}`;
    }
  }

  if (isGeneratedOkfPath(absPath, paths)) {
    return "Generated OKF indexes and log are read-only. Use wiki_rebuild_meta or the page-producing tool that owns the source mutation.";
  }
  return undefined;
}

/**
 * Extract the filesystem target of one structured file-mutating call.
 * Returns the absolute path, or undefined when the call carries no usable
 * target (missing/invalid arg → the tool's own validation will fail it; we
 * have no opinion).
 */
function structuredTarget(exec: Readonly<ToolExecution>, cwd: string): string | undefined {
  const key = PATH_ARG_BY_TOOL[exec.name];
  if (!key) return undefined;
  const args = exec.arguments;
  if (!args || typeof args !== "object") return undefined;
  const raw = (args as Record<string, unknown>)[key];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return toAbsolute(raw.trim(), cwd);
}

/**
 * Scan a shell command string for write targets. Best-effort, fail-open:
 * only operands of a KNOWN mutating verb or a redirection are collected, and
 * only tokens that survive unquoting and resolve to a real vault path deny.
 *
 * Known gaps (documented, acceptable):
 *  - Command substitution `$(…)`/`( )`, heredocs, eval, and shell variables
 *    are opaque — `rm -rf $P` can still write the vault. Sandboxing, not this
 *    guardrail, owns that class of risk.
 *  - `find … -delete`/`xargs`-nested writes and multi-line scripts ride the
 *    same blind spot.
 *  - A `cd` into the vault mid-line is tracked only at the top token level;
 *    `cd` inside a subshell or loop isn't followed.
 *  - `python -c`/`node -e` scripts that write files aren't parsed.
 */
function shellWriteTargets(command: string, workdir: string): string[] {
  const targets: string[] = [];
  // Split on whitespace first; quote runs are kept together by a second pass
  // over the raw string so `"a b"` survives as one token. This is a scanner,
  // not a parser — it only needs to find operands it can name.
  const tokens = lex(command);
  let base = workdir;
  let i = 0;

  const pushTarget = (token: string) => {
    const un = unquote(token);
    if (!un) return;
    const abs = toAbsolute(un, base);
    if (abs) targets.push(abs);
  };

  const isSep = (tok: string) =>
    COMMAND_SEPARATORS.has(tok) ||
    // lex() emits `&&`, `|&`, `;;` runs as consecutive single chars; a run of
    // pure separator chars is one logical separator either way.
    /^[;|&]+$/.test(tok);

  while (i < tokens.length) {
    const tok = tokens[i];

    if (isSep(tok)) {
      i += 1;
      continue;
    }

    // Redirections: `>`, `>>`, `&>`, `2>`, `1>`, `>file`, `2>file`, `>>file`.
    // `2>&1` lexes as `2>` + `&` + `1` (lex splits `&`), so the token after
    // a bare `>` may itself be a separator — a separator is never a target.
    const redirect = /^([&0-9]*>{1,2})(.*)$/.exec(tok);
    if (redirect) {
      const inline = redirect[2];
      if (inline) {
        pushTarget(inline);
      } else if (i + 1 < tokens.length && !isSep(tokens[i + 1])) {
        pushTarget(tokens[i + 1]);
        i += 1;
      }
      i += 1;
      continue;
    }

    // cd-family retargets the base for later relative tokens.
    if (CD_COMMANDS.has(tok.toLowerCase())) {
      const operand = tokens[i + 1];
      if (operand) {
        const un = unquote(operand);
        if (un) {
          const abs = toAbsolute(un, base);
          if (abs) base = abs;
        }
        i += 1;
      }
      i += 1;
      continue;
    }

    // Skip wrapper prefixes to reach the effective command name.
    const baseName = tok.replace(/\\/g, "/").split("/").pop() ?? tok;
    if (COMMAND_PREFIXES.has(baseName)) {
      i += 1;
      continue;
    }

    const isPwshWrite = PWSH_WRITE_COMMANDS.has(baseName.toLowerCase());
    const isPosixWrite = POSIX_WRITE_COMMANDS.has(baseName);
    if (!isPwshWrite && !isPosixWrite) {
      i += 1;
      continue;
    }

    // Collect operands until the next separator. Redirection tokens inside
    // an operand list (e.g. `tee a > b`) still redirect — handle them inline
    // so a write hiding behind `>` is not skipped just because it followed a
    // mutating verb.
    let j = i + 1;
    while (j < tokens.length && !isSep(tokens[j])) {
      const operand = tokens[j];
      const innerRedirect = /^([&0-9]*>{1,2})(.*)$/.exec(operand);
      if (innerRedirect) {
        if (innerRedirect[2]) pushTarget(innerRedirect[2]);
        else if (j + 1 < tokens.length && !isSep(tokens[j + 1])) {
          pushTarget(tokens[j + 1]);
          j += 1;
        }
        j += 1;
        continue;
      }
      // Flags, VAR=value assignments, expansions, and subshells aren't paths.
      if (
        operand.startsWith("-") ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(operand) ||
        operand.startsWith("$") ||
        operand.startsWith("(")
      ) {
        j += 1;
        continue;
      }
      pushTarget(operand);
      j += 1;
    }
    i = j;
  }
  return targets;
}

/**
 * Minimal tokenizer: whitespace-separated words, honoring single/double
 * quotes and backslash escapes just enough to keep quoted operands and
 * redirection operators intact. Not a shell parser — see shellWriteTargets.
 */
function lex(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  const flush = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      flush();
      // Runs like `&&` or `|&` arrive as consecutive single-char tokens; the
      // separator test uses startsWith so both forms terminate operands.
      tokens.push(ch);
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

/**
 * The one guard installed for all tool families. Reads exec.name to pick an
 * argument extractor, then routes every candidate path through
 * mutationDenyReason. Never throws (see module docstring).
 */
function vaultGuard(deps: GuardrailDeps) {
  return (exec: Readonly<ToolExecution>): string | undefined => {
    try {
      const cwd = safeCwd(deps, exec.agent);

      // Structured file-mutating tools: exact target check.
      const structured = structuredTarget(exec, cwd);
      if (structured) {
        return mutationDenyReason(structured);
      }

      // Shell tools: conservative write-target scan.
      const shellKey = SHELL_ARG_BY_TOOL[exec.name];
      if (shellKey) {
        const args = exec.arguments;
        if (!args || typeof args !== "object") return undefined;
        const record = args as Record<string, unknown>;
        const command = record[shellKey];
        if (typeof command !== "string" || !command.trim()) return undefined;
        const workdir =
          typeof record.workdir === "string" && record.workdir.trim()
            ? (toAbsolute(record.workdir.trim(), cwd) ?? cwd)
            : cwd;
        for (const target of shellWriteTargets(command, workdir)) {
          const reason = mutationDenyReason(target);
          if (reason) return reason;
        }
      }
      return undefined;
    } catch {
      // A throwing guard denies (or faults) every call in the host. Fail-open
      // for the pipeline: vault ownership is enforced wherever we can prove
      // it, and a broken check proves nothing.
      return undefined;
    }
  };
}

function safeCwd(deps: GuardrailDeps, agent?: unknown): string {
  try {
    const cwd = deps.cwdFor?.(agent) ?? deps.cwd();
    return typeof cwd === "string" && cwd.trim() ? cwd : homedir();
  } catch {
    return homedir();
  }
}

/**
 * Register the vault-ownership guardrail on the host's tool pipeline.
 *
 * `ctx.tools.guard` applies globally (plain ctx = every agent, including
 * delegated sub-agents — a child cannot ask for permission, so the deny must
 * reach it the same way). The returned registrations are fiber-owned and
 * unwind with the plugin.
 *
 * With `deps.runtime` present, also installs the dirty-tracking half of
 * upstream's guardrails: `tools/result` observing successful write/edit
 * results that touched `wiki/**`, marking the vault dirty, and — the pi
 * `turn_end` shape — a `session/event` `tool/result` observer that converts
 * the dirty flag into one coalesced `scheduleReindex` per turn boundary.
 * Upstream keyed on turn end; dsh has no direct turn_end event, so the
 * `step/*` boundary in session/events is the nearest drain point. This keeps
 * hand edits to wiki pages (which the guard allows) consistent with the
 * generated metadata — the second half of the ownership contract.
 */
export function registerGuardrails(ctx: Context, deps: GuardrailDeps): void {
  ctx.tools.guard(vaultGuard(deps));

  if (!deps.runtime) return;
  const runtime = deps.runtime;
  let pendingRebuild: VaultPaths | undefined;

  // Dirty-track successful structured mutations that landed in wiki/** (the
  // editable tree). events.jsonl writes route through appendEvent inside the
  // engine and trigger their own rebuild; this flag only covers foreign
  // writes the tools layer did not schedule.
  ctx.on("tools/result", (exec, result) => {
    try {
      if (result.isError) return;
      const cwd = safeCwd(deps, exec.agent);
      const target = structuredTarget(exec, cwd);
      if (!target) return;
      const paths = findEnclosingVault(target);
      if (!paths) return;
      if (isPathWithin(paths.wiki, target)) pendingRebuild = paths;
    } catch {
      // Observe-only listener: contained by the pipeline, but don't rely on it.
    }
  });

  // Drain point: upstream used pi's turn_end. dsh's session/event stream
  // carries `step/*` events; a finished step is the nearest equivalent, and
  // scheduleReindex's own coalescing makes extra drains cheap. The rebuild
  // runs on the shared runtime lane, off the pipeline's stack.
  //
  // Event contract: `session/event` emits `(session, event)` — the session
  // comes first (see @deepseek-ai/dsh-session's SessionEvents declaration).
  // Reading the first argument as the event silently disables this drain.
  ctx.on("session/event", (_session: unknown, event: unknown) => {
    try {
      const type = (event as { type?: string })?.type;
      if (!type || !type.startsWith("step/")) return;
      if (!pendingRebuild) return;
      const paths = pendingRebuild;
      pendingRebuild = undefined;
      scheduleReindex(runtime, { hasUI: false }, paths);
    } catch {
      // Best-effort reindex; a dropped drain leaves a stale projection the
      // next write fixes, never a corrupted vault.
    }
  });
}

// Exported for the test surface: the same extraction the guard uses, exposed
// so tests can assert deny/allow per command shape without a live registry.
export { shellWriteTargets, structuredTarget, findEnclosingVault };
