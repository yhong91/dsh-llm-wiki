import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VaultPaths } from "./utils.js";

/**
 * Rolling record of wiki READ calls (issue: read operations left no trace —
 * writes already log to meta/events.jsonl). One JSON line per call:
 *
 *   { tool, query, hits, ms, timestamp }
 *
 * Kept in a dedicated meta/calls.jsonl (not events.jsonl) so the volume of
 * per-turn auto-recall entries never buries the semantic event stream, and
 * so both surfaces keep their own retention policy. The file is rewritten
 * with only the newest MAX_LINES entries once it grows past the trim
 * threshold — a plain append between checks, a bounded rewrite on trim.
 */

export interface WikiCallEntry {
  /** Which surface made the call: "search" | "recall" | "auto-recall". */
  readonly tool: string;
  /** Query text as passed (already length-capped by the caller). */
  readonly query: string;
  /** Result count. */
  readonly hits: number;
  /** Wall-clock duration of the search itself, milliseconds. */
  readonly ms: number;
  readonly timestamp: string;
}

const MAX_LINES = 500;

function callsPath(paths: VaultPaths): string {
  return join(paths.meta, "calls.jsonl");
}

/** Append one call entry, trimming the file to MAX_LINES when it overgrows. */
export function appendCall(paths: VaultPaths, entry: Omit<WikiCallEntry, "timestamp">): void {
  try {
    mkdirSync(paths.meta, { recursive: true });
    const file = callsPath(paths);
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      if (lines.length >= MAX_LINES) {
        // Rewrite with only the newest MAX_LINES - 1 entries; the new line is
        // appended below by the same code path as the common case.
        writeFileSync(
          file,
          `${lines.slice(lines.length - (MAX_LINES - 1)).join("\n")}\n`,
          "utf-8",
        );
      }
    }
    writeFileSync(file, `${line}\n`, { flag: "a", encoding: "utf-8" });
  } catch {
    // A read-path log must never break the search that produced it.
  }
}

/** Read the newest `limit` call entries (newest first). Missing file → []. */
export function readCalls(paths: VaultPaths, limit = 50): WikiCallEntry[] {
  try {
    const file = callsPath(paths);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    const out: WikiCallEntry[] = [];
    for (let index = lines.length - 1; index >= 0 && out.length < limit; index -= 1) {
      try {
        out.push(JSON.parse(lines[index]) as WikiCallEntry);
      } catch {
        // Corrupt line: skip. A log reader must not fail the dashboard.
      }
    }
    return out;
  } catch {
    return [];
  }
}
