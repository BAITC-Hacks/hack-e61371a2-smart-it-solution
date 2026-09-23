import { z } from "zod";

const shape = z.object({
  AI_ENABLED: z.enum(["true", "false"]).default("false"),
  OPENAI_API_KEY: z.string().default(""),
  AI_MODEL_FAST: z.string().default(""),
  AI_MODEL_RECOMMEND: z.string().default(""),
  AI_INPUT_USD_PER_MILLION: z.coerce.number().finite().nonnegative().default(0),
  AI_OUTPUT_USD_PER_MILLION: z.coerce
    .number()
    .finite()
    .nonnegative()
    .default(0),
  AI_PROJECT_BUDGET_USD: z.coerce.number().positive().max(50).default(40),
  AI_USER_DAILY_BUDGET_USD: z.coerce.number().positive().max(10).default(0.5),
  AI_USER_REQUESTS_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20),
  AI_PROJECT_REQUESTS_PER_DAY: z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .default(500),
  AI_TIMEOUT_MS: z.coerce.number().int().min(50).max(9000).default(7000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(4096).default(800),
  AI_MAX_INPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(100000)
    .default(24000),
  AI_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
});
export function readAiConfig(source: NodeJS.ProcessEnv = process.env) {
  const result = shape.safeParse(source);
  if (!result.success)
    throw new Error(
      `Invalid AI settings: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const v = result.data;
  if (
    v.AI_ENABLED === "true" &&
    (!v.OPENAI_API_KEY ||
      !v.AI_MODEL_FAST ||
      v.AI_INPUT_USD_PER_MILLION <= 0 ||
      v.AI_OUTPUT_USD_PER_MILLION <= 0)
  )
    throw new Error(
      "Enabled AI requires a server key, explicit model and verified maximum input/output prices for both configured models",
    );
  return {
    enabled: v.AI_ENABLED === "true",
    apiKey: v.OPENAI_API_KEY,
    model: v.AI_MODEL_FAST,
    recommendModel: v.AI_MODEL_RECOMMEND || v.AI_MODEL_FAST,
    inputPrice: v.AI_INPUT_USD_PER_MILLION,
    outputPrice: v.AI_OUTPUT_USD_PER_MILLION,
    projectBudget: Math.floor(v.AI_PROJECT_BUDGET_USD * 1e6),
    userBudget: Math.floor(v.AI_USER_DAILY_BUDGET_USD * 1e6),
    userHourly: v.AI_USER_REQUESTS_PER_HOUR,
    projectDaily: v.AI_PROJECT_REQUESTS_PER_DAY,
    timeoutMs: v.AI_TIMEOUT_MS,
    maxOutput: v.AI_MAX_OUTPUT_TOKENS,
    maxInputBytes: v.AI_MAX_INPUT_BYTES,
    retentionDays: v.AI_RETENTION_DAYS,
  };
}
export type AiConfig = ReturnType<typeof readAiConfig>;
