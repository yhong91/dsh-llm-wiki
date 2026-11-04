import type { Static, TSchema } from "typebox";

/**
 * Host-neutral extension surface the vendored engine types its registration
 * functions against. It mirrors the members upstream borrowed from the pi
 * coding-agent SDK (tool registration, event hooks, custom messages); the
 * dsh adapter supplies a conforming value in a later phase.
 */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDefinition<TParams extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult>;
}

export type ToolFactory = <TParams extends TSchema>(
  tool: ToolDefinition<TParams>,
) => void;

export type ExtensionEventHandler = (event: any, ctx: ExtensionContext) => unknown;

export interface ExtensionAPI {
  registerTool: ToolFactory;
  on(event: string, handler: ExtensionEventHandler): void;
  sendMessage(
    message: { customType: string; content: unknown; display?: boolean | (() => boolean) },
    options?: { deliverAs?: string },
  ): void;
}

export interface ExtensionContext {
  cwd?: string;
  hasUI: boolean;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
  sessionManager?: unknown;
}
