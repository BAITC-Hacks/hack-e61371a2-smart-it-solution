import { isIP } from "node:net";
import { z } from "zod";

function internalHost(host: string) {
  if (["localhost", "host.docker.internal", "[::1]"].includes(host))
    return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return /^\[(?:fc|fd)[a-f0-9]{2}:/i.test(host);
}

function selfHostedBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AI_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && internalHost(url.hostname))
    )
  )
    throw new Error(
      "AI_BASE_URL requires HTTPS (or a private/loopback HTTP endpoint) and no credentials, query or fragment",
    );
  return url.toString().replace(/\/+$/, "");
}

const shape = z.object({
  AI_ENABLED: z.enum(["true", "false"]).default("false"),
  AI_PROVIDER: z.enum(["openai", "self_hosted"]).default("openai"),
  AI_BASE_URL: z.string().trim().default(""),
  AI_API_KEY: z.string().default(""),
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
  AI_TIMEOUT_MS: z.coerce.number().int().min(50).max(60000).default(7000),
  AI_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(32).default(2),
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
    v.AI_PROVIDER === "openai" &&
    (!v.OPENAI_API_KEY ||
      !v.AI_MODEL_FAST ||
      v.AI_INPUT_USD_PER_MILLION <= 0 ||
      v.AI_OUTPUT_USD_PER_MILLION <= 0)
  )
    throw new Error(
      "Enabled AI requires a server key, explicit model and verified maximum input/output prices for both configured models",
    );
  if (
    v.AI_ENABLED === "true" &&
    v.AI_PROVIDER === "self_hosted" &&
    (!v.AI_BASE_URL || !v.AI_API_KEY || !v.AI_MODEL_FAST)
  )
    throw new Error(
      "Enabled self_hosted AI requires AI_BASE_URL, AI_API_KEY and AI_MODEL_FAST",
    );
  const baseUrl =
    v.AI_PROVIDER === "self_hosted"
      ? v.AI_BASE_URL
        ? selfHostedBaseUrl(v.AI_BASE_URL)
        : ""
      : "https://api.openai.com/v1";
  return {
    enabled: v.AI_ENABLED === "true",
    provider: v.AI_PROVIDER,
    baseUrl,
    apiKey: v.AI_PROVIDER === "self_hosted" ? v.AI_API_KEY : v.OPENAI_API_KEY,
    model: v.AI_MODEL_FAST,
    recommendModel: v.AI_MODEL_RECOMMEND || v.AI_MODEL_FAST,
    // GPU infrastructure is billed by uptime, not by model tokens. This ledger only tracks API token charges.
    inputPrice:
      v.AI_PROVIDER === "self_hosted" ? 0 : v.AI_INPUT_USD_PER_MILLION,
    outputPrice:
      v.AI_PROVIDER === "self_hosted" ? 0 : v.AI_OUTPUT_USD_PER_MILLION,
    projectBudget: Math.floor(v.AI_PROJECT_BUDGET_USD * 1e6),
    userBudget: Math.floor(v.AI_USER_DAILY_BUDGET_USD * 1e6),
    userHourly: v.AI_USER_REQUESTS_PER_HOUR,
    projectDaily: v.AI_PROJECT_REQUESTS_PER_DAY,
    timeoutMs: v.AI_TIMEOUT_MS,
    maxConcurrent: v.AI_MAX_CONCURRENT_REQUESTS,
    maxOutput: v.AI_MAX_OUTPUT_TOKENS,
    maxInputBytes: v.AI_MAX_INPUT_BYTES,
    retentionDays: v.AI_RETENTION_DAYS,
  };
}
export type AiConfig = ReturnType<typeof readAiConfig>;
