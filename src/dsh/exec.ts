import type { ExecApi } from "../engine/utils.js";

/**
 * The subset of the dsh subprocess service this adapter needs, mirrored from
 * `ctx.subprocess` (verified against the detpecca dsh plugin's runner.js).
 * Kept structural so the service type does not have to be a dependency.
 */
export interface SubprocessHandle {
  done: Promise<{ exitCode: number | null }>;
  collected: {
    stdout?: { readFrom(offset: number): { text: string } };
    stderr?: { readFrom(offset: number): { text: string } };
  };
}

export interface SubprocessService {
  spawn(options: {
    argv: string[];
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    stdio: {
      stdin: "ignore";
      stdout: { maxBytes: number };
      stderr: { maxBytes: number };
    };
    graceMs: number;
  }): SubprocessHandle;
}

/**
 * Engine `ExecApi` over `ctx.subprocess.spawn`.
 *
 * The engine shells out for source capture (curl for URLs, uvx/pandoc-style
 * extractors for files). `exec()` returns the pi-shaped result —
 * `{stdout, stderr, code, killed}` — and never rejects for a nonzero exit;
 * the engine's own `exec()` wrapper maps code/killed onto errors. `options.timeout`
 * is enforced with a local `AbortController` fused with the caller's signal:
 * expiry reports `killed: true` the same way pi's timeout path does.
 */
export function createExecApi(subprocess: SubprocessService | undefined): ExecApi {
  if (!subprocess) {
    return {
      exec() {
        throw new Error(
          "@yhong91/dsh-llm-wiki: the subprocess service is unavailable — wiki_capture_source needs ctx.subprocess to fetch URLs and extract files",
        );
      },
    };
  }

  return {
    async exec(command, args, options = {}) {
      let timedOut = false;
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort();
      const callerSignal = options.signal;
      if (callerSignal) {
        if (callerSignal.aborted) controller.abort();
        else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
      const timer =
        options.timeout && options.timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, options.timeout)
          : undefined;

      try {
        const handle = subprocess.spawn({
          argv: [command, ...args],
          ...(options.cwd ? { cwd: options.cwd } : {}),
          signal: controller.signal,
          stdio: {
            stdin: "ignore",
            stdout: { maxBytes: 2_000_000 },
            stderr: { maxBytes: 200_000 },
          },
          graceMs: 5_000,
        });
        const outcome = await handle.done;
        return {
          stdout: handle.collected.stdout?.readFrom(0).text ?? "",
          stderr: handle.collected.stderr?.readFrom(0).text ?? "",
          code: outcome.exitCode ?? -1,
          killed: timedOut || (callerSignal?.aborted ?? false),
        };
      } finally {
        if (timer) clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}
