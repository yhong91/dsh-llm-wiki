import Schema from "@deepseek-ai/schemastery";
import type { WikilinkValidationMode } from "../engine/knowledge-links.js";
import type { TaskConfig } from "../engine/task-config.js";

/**
 * Schemastery config for the @yhong91/dsh-llm-wiki bundle.
 *
 * Mirrors the engine's `llm-wiki` settings namespace (`TaskConfig` in
 * engine/task-config.ts) so cordis.patch.yml `config:` rows reuse the same
 * field names the pi/.omp settings files already carry. `apply()` merges this
 * over a `loadTaskConfig()` compat read, with Schemastery values winning.
 */
export interface Config {
  notices: boolean;
  autoRecall: boolean;
  ambientPersonalVault: boolean;
  trajectories: boolean;
  taskModel?: { provider: string; id: string };
  taskModelBaseUrl: string;
  taskModelApiKeyEnv: string;
  taskModelApiKey: string;
  embeddingProvider: string;
  embeddingBaseUrl: string;
  embeddingApiKeyEnv: string;
  embeddingApiKey: string;
  embeddingModel: string;
  semanticWeight: number;
  recallLinksThreshold: number;
  recallSkillInlineMax: number;
  synthesisLanguage: string;
  synthesisMaxTokens: number;
  wikilinkValidation: WikilinkValidationMode;
  customTypes: Record<string, string>;
}

export const Config = Schema.object({
  notices: Schema.boolean()
    .default(true)
    .description("Surface wiki activity as user-visible notices."),
  autoRecall: Schema.boolean()
    .default(true)
    .description("Run automatic wiki recall injection each turn."),
  ambientPersonalVault: Schema.boolean()
    .default(true)
    .description("Let the personal vault serve as ambient vault when a project has none."),
  trajectories: Schema.boolean()
    .default(false)
    .description("Enable agent-trajectory working memory (opt-in)."),
  taskModel: Schema.object({
    provider: Schema.string(),
    id: Schema.string(),
  })
    .description("Background task model override.")
    .hidden(),
  taskModelBaseUrl: Schema.string().default("").description("Task-model endpoint base URL."),
  taskModelApiKeyEnv: Schema.string()
    .default("")
    .description("Env var holding the task-model API key."),
  taskModelApiKey: Schema.string()
    .default("")
    .description("Task-model API key (prefer taskModelApiKeyEnv).")
    .hidden(),
  embeddingProvider: Schema.string()
    .default("")
    .description('Embedding provider ("openai"/"openai-compatible"; empty disables).'),
  embeddingBaseUrl: Schema.string().default("").description("Embedding endpoint base URL."),
  embeddingApiKeyEnv: Schema.string()
    .default("")
    .description("Env var holding the embedding API key."),
  embeddingApiKey: Schema.string()
    .default("")
    .description("Embedding API key (prefer embeddingApiKeyEnv).")
    .hidden(),
  embeddingModel: Schema.string().default("").description("Embedding model id."),
  semanticWeight: Schema.number()
    .min(0)
    .max(1)
    .default(0.5)
    .description("Blend weight of the semantic signal in hybrid recall."),
  recallLinksThreshold: Schema.natural()
    .default(50)
    .description("Vault page count above which recall returns links instead of previews."),
  recallSkillInlineMax: Schema.natural()
    .default(1600)
    .description("Max chars of a skill/case body inlined into recall blocks (0 disables)."),
  synthesisLanguage: Schema.string()
    .default("")
    .description("BCP 47 language tag for ingest synthesis (empty = English)."),
  synthesisMaxTokens: Schema.natural()
    .default(16384)
    .description("Max output tokens for the synthesis agent."),
  wikilinkValidation: Schema.union([
    Schema.const("off" as const),
    Schema.const("warn" as const),
    Schema.const("strict" as const),
    Schema.const("normalize" as const),
  ])
    .default("warn")
    .description("Pre-write wikilink gate mode."),
  customTypes: Schema.dict(Schema.string())
    .default({})
    .description("User-defined page types: type name → wiki/ folder."),
});

/**
 * Overlay a resolved dsh Config on a compat-read `TaskConfig`.
 *
 * Two things are easy to get wrong here:
 *
 *  - `Config(config)` fills every Schemastery default, so a resolved value
 *    alone cannot distinguish "the user set this" from "the schema default".
 *    The third argument carries the raw row object; only keys physically
 *    present in it are allowed to win. Without that distinction a repo's
 *    `.pi/settings.json` `notices: false` would be silently overridden by the
 *    schema default `true`.
 *  - Empty strings/objects count as unset even when explicitly present. They
 *    are the natural "not configured" value in YAML and must not erase a
 *    settings-file value.
 *
 * `explicit` is optional for callers/tests that already constructed a full
 * `Config`: omitting it preserves the legacy "every field wins" behavior.
 * `taskModel` passes through only when both provider and id are present.
 */
export function mergeTaskConfig(
  config: Config,
  file: TaskConfig,
  explicit?: Partial<Config>,
): TaskConfig {
  const out: TaskConfig = { ...file };
  const isExplicit = (key: keyof Config): boolean =>
    explicit === undefined || Object.hasOwn(explicit, key);
  const str = <K extends keyof TaskConfig>(key: K, value: string | undefined) => {
    if (value?.trim()) (out as Record<string, unknown>)[key as string] = value.trim();
  };

  if (isExplicit("notices") && typeof config.notices === "boolean") out.notices = config.notices;
  if (isExplicit("autoRecall") && typeof config.autoRecall === "boolean") {
    out.autoRecall = config.autoRecall;
  }
  if (isExplicit("ambientPersonalVault") && typeof config.ambientPersonalVault === "boolean") {
    out.ambientPersonalVault = config.ambientPersonalVault;
  }
  if (isExplicit("trajectories") && typeof config.trajectories === "boolean") {
    out.trajectories = config.trajectories;
  }
  if (isExplicit("taskModel") && config.taskModel?.provider && config.taskModel?.id) {
    out.taskModel = { provider: config.taskModel.provider, id: config.taskModel.id };
  }
  if (isExplicit("taskModelBaseUrl")) str("taskModelBaseUrl", config.taskModelBaseUrl);
  if (isExplicit("taskModelApiKeyEnv")) str("taskModelApiKeyEnv", config.taskModelApiKeyEnv);
  if (isExplicit("taskModelApiKey")) str("taskModelApiKey", config.taskModelApiKey);
  if (isExplicit("embeddingProvider")) str("embeddingProvider", config.embeddingProvider);
  if (isExplicit("embeddingBaseUrl")) str("embeddingBaseUrl", config.embeddingBaseUrl);
  if (isExplicit("embeddingApiKeyEnv")) str("embeddingApiKeyEnv", config.embeddingApiKeyEnv);
  if (isExplicit("embeddingApiKey")) str("embeddingApiKey", config.embeddingApiKey);
  if (isExplicit("embeddingModel")) str("embeddingModel", config.embeddingModel);
  if (isExplicit("semanticWeight") && typeof config.semanticWeight === "number") {
    out.semanticWeight = Math.min(1, Math.max(0, config.semanticWeight));
  }
  if (isExplicit("recallLinksThreshold") && typeof config.recallLinksThreshold === "number") {
    out.recallLinksThreshold = config.recallLinksThreshold;
  }
  if (isExplicit("recallSkillInlineMax") && typeof config.recallSkillInlineMax === "number") {
    out.recallSkillInlineMax = config.recallSkillInlineMax;
  }
  if (isExplicit("synthesisLanguage")) str("synthesisLanguage", config.synthesisLanguage);
  if (isExplicit("synthesisMaxTokens") && typeof config.synthesisMaxTokens === "number") {
    out.synthesisMaxTokens = config.synthesisMaxTokens;
  }
  if (isExplicit("wikilinkValidation") && config.wikilinkValidation) {
    out.wikilinkValidation = config.wikilinkValidation;
  }
  if (
    isExplicit("customTypes") &&
    config.customTypes &&
    Object.keys(config.customTypes).length
  ) {
    out.customTypes = config.customTypes;
  }
  return out;
}
