# @yhong91/dsh-llm-wiki

Karpathy-style LLM Wiki for DeepSeek Harness (dsh): native tools, ambient
recall, and guardrails over a pi-llm-wiki-compatible `.llm-wiki` (okf-0.2)
vault. It reads and extends the same vaults the pi and Claude Code plugins
use, so existing memory keeps working.

Status: phase 3 — native tools, ambient recall, guardrails, commands, the
bundled `llm-wiki` skill, background ingest synthesis (DSH subagents + jobs),
the read-only Web wiki dashboard, the periodic observe/retro reminder, and
opt-in agent-trajectory memory (`trajectories: true` or `/wiki-trajectories on`,
then restart) are wired.

The knowledge engine under `src/engine/` is vendored from
[pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki) v0.6.3 (MIT); its
license is kept as `LICENSE`.

## Develop

```bash
npm install
npm run build   # tsc -> lib/
npm run smoke   # read-only check against ~/.llm-wiki
```
