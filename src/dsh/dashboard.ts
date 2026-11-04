import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  collectDashboardStats,
  type DashboardStats,
} from "../engine/dashboard.js";
import { readJson, resolveVaultPaths } from "../engine/utils.js";

/**
 * Read-only data for the Web dashboard panel. The heavy aggregate is the
 * vendored dashboard engine; this module adds the human-facing slices the
 * browser needs (recent pages and the latest activity stream) without ever
 * writing to the vault.
 */

export interface DashboardPage {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly status?: string;
  readonly updated?: string;
  readonly excerpt: string;
}

export interface DashboardEvent {
  readonly kind: string;
  readonly title: string;
  readonly timestamp?: string;
}

export interface DashboardPayload {
  readonly generatedAt: string;
  readonly stats: DashboardStats;
  readonly topic?: string;
  readonly mode?: string;
  readonly recentPages: DashboardPage[];
  readonly recentEvents: DashboardEvent[];
}

function readExcerpt(file: string): string {
  try {
    const raw = readFileSync(file, "utf-8");
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    return body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .join(" ")
      .slice(0, 360);
  } catch {
    return "";
  }
}

function recentEvents(metaDir: string): DashboardEvent[] {
  const file = join(metaDir, "events.jsonl");
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
    const out: DashboardEvent[] = [];
    for (let index = lines.length - 1; index >= 0 && out.length < 12; index -= 1) {
      try {
        const event = JSON.parse(lines[index]) as Record<string, unknown>;
        const kind = typeof event.kind === "string" ? event.kind : "event";
        const title =
          typeof event.title === "string"
            ? event.title
            : typeof event.slug === "string"
              ? event.slug
              : kind;
        out.push({
          kind,
          title,
          ...(typeof event.timestamp === "string" ? { timestamp: event.timestamp } : {}),
        });
      } catch {
        // Corrupt line: skip, not fatal for a read-only dashboard.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function collectDashboardPayload(cwd: string): Promise<DashboardPayload> {
  const stats = await collectDashboardStats(cwd);
  const paths = resolveVaultPaths(cwd);
  const vaultConfig = readJson<{ topic?: unknown; mode?: unknown }>(
    join(paths.dotWiki, "config.json"),
    {},
  );
  const registry = readJson<{
    pages?: Record<string, Record<string, unknown>>;
  }>(join(paths.meta, "registry.json"), { pages: {} });

  const recentPages = Object.entries(registry.pages ?? {})
    .map(([id, entry]) => {
      const type = typeof entry.type === "string" ? entry.type : "page";
      const title = typeof entry.title === "string" ? entry.title : id;
      const updated = typeof entry.updated === "string" ? entry.updated : undefined;
      const created = typeof entry.created === "string" ? entry.created : undefined;
      return {
        id,
        title,
        type,
        ...(typeof entry.status === "string" ? { status: entry.status } : {}),
        ...(updated ? { updated } : created ? { updated: created } : {}),
        excerpt: readExcerpt(join(paths.wiki, `${id}.md`)),
      };
    })
    .sort((left, right) => (right.updated ?? "").localeCompare(left.updated ?? ""))
    .slice(0, 18);

  return {
    generatedAt: new Date().toISOString(),
    stats,
    ...(typeof vaultConfig.topic === "string" && vaultConfig.topic
      ? { topic: vaultConfig.topic }
      : {}),
    ...(typeof vaultConfig.mode === "string" && vaultConfig.mode
      ? { mode: vaultConfig.mode }
      : {}),
    recentPages,
    recentEvents: recentEvents(paths.meta),
  };
}

interface ConnectionLike {
  readonly fetch?: {
    register?: (spec: {
      path: string;
      methods: string[];
      requestBody: "buffered";
      fetch: (request: Request) => Promise<Response>;
    }) => unknown;
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Register the read-only dashboard route on the optional Host connection
 * service. Client panels use plain same-origin POST requests.
 */
export function registerDashboardRoute(ctx: Context): void {
  const injectable = ctx as Context & {
    inject(services: string[], callback: (child: Context) => void): unknown;
  };
  injectable.inject(["connection"], (connectionCtx) => {
    const connection = (connectionCtx as Context & { get(name: string): unknown }).get(
      "connection",
    ) as ConnectionLike | undefined;
    const register =
      typeof connection?.fetch?.register === "function"
        ? connection.fetch.register.bind(connection.fetch)
        : undefined;
    if (!register) return;

    try {
      connectionCtx.effect(
        () => {
          const dispose = register({
            path: "/api/llm-wiki/dashboard",
            methods: ["POST"],
            requestBody: "buffered",
            fetch: async (request: Request) => {
              let body: Record<string, unknown> = {};
              try {
                body = (await request.json()) as Record<string, unknown>;
              } catch {
                // Empty/non-JSON bodies use the process cwd.
              }
              const cwd =
                typeof body.cwd === "string" && body.cwd.trim()
                  ? body.cwd
                  : process.cwd();
              try {
                return jsonResponse({
                  ok: true,
                  value: await collectDashboardPayload(cwd),
                });
              } catch (error) {
                return jsonResponse(
                  {
                    ok: false,
                    error: {
                      code: "llm-wiki/dashboard-failed",
                      message: error instanceof Error ? error.message : String(error),
                    },
                  },
                  500,
                );
              }
            },
          });
          return () => {
            if (typeof dispose === "function") (dispose as () => void)();
          };
        },
        "llm-wiki: dashboard route",
      );
    } catch {
      // Connection routes are optional outside the Web app.
    }
  });
}
