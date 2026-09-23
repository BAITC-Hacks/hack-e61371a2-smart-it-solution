import { z } from "zod";
import { readAiConfig, type AiConfig } from "./ai-config.js";

export type SemanticConfig = {
  enabled: boolean;
  model: string;
  price: number;
  budget: AiConfig;
};

// Generation and embeddings have separate providers, credentials and opt-ins.
// Shared by inference and the sanitized administrative configuration response.
export function readSemanticConfig(
  env: NodeJS.ProcessEnv = process.env,
): SemanticConfig {
  const base = readAiConfig({
    ...env,
    AI_ENABLED: "false",
    AI_PROVIDER: "openai",
  });
  const enabled =
    env.AI_EMBEDDING_ENABLED === undefined
      ? env.AI_ENABLED === "true" && (env.AI_PROVIDER ?? "openai") === "openai"
      : z.enum(["true", "false"]).parse(env.AI_EMBEDDING_ENABLED) === "true";
  const model = (env.AI_EMBEDDING_MODEL ?? "").trim();
  const price = Number(env.AI_EMBEDDING_USD_PER_MILLION);
  return {
    enabled: enabled && Boolean(base.apiKey && model) && Number.isFinite(price) && price > 0,
    model,
    price: Number.isFinite(price) && price > 0 ? price : 0,
    budget: base,
  };
}
