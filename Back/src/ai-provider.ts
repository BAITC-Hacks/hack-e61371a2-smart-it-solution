import { z } from "zod";
import type { AiConfig } from "./ai-config.js";

type Input = {
  model: string;
  schema: Record<string, unknown>;
  input: unknown;
  instructions: string;
};

export function structuredRequest(config: AiConfig, args: Input) {
  const format = {
    name: "career_quest_response",
    strict: true,
    schema: args.schema,
  };
  if (config.provider === "self_hosted")
    return {
      url: `${config.baseUrl}/chat/completions`,
      body: {
        model: args.model,
        messages: [
          { role: "system", content: args.instructions },
          { role: "user", content: JSON.stringify(args.input) },
        ],
        max_tokens: config.maxOutput,
        temperature: 0,
        stream: false,
        response_format: { type: "json_schema", json_schema: format },
      },
    };
  return {
    url: "https://api.openai.com/v1/responses",
    body: {
      model: args.model,
      store: false,
      instructions: args.instructions,
      input: JSON.stringify(args.input),
      max_output_tokens: config.maxOutput,
      text: { format: { type: "json_schema", ...format } },
    },
  };
}

const tokens = z.number().int().min(0).max(2147483647);
type Parsed = {
  status: string;
  text: string;
  refusal: boolean;
  usage?: { input_tokens: number; output_tokens: number };
};

// Both transports feed the same downstream schema, fact-ID and authorization checks.
export function parseStructuredResponse(
  provider: AiConfig["provider"],
  raw: unknown,
): Parsed | null {
  if (provider === "self_hosted") {
    const parsed = z
      .object({
        choices: z
          .array(
            z.object({
              index: z.literal(0),
              finish_reason: z.string(),
              message: z.object({
                role: z.literal("assistant"),
                content: z.string().nullable(),
                refusal: z.string().nullable().optional(),
              }),
            }),
          )
          .length(1),
        usage: z
          .object({ prompt_tokens: tokens, completion_tokens: tokens })
          .optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return null;
    const choice = parsed.data.choices[0]!;
    return {
      status:
        choice.finish_reason === "stop" ? "completed" : choice.finish_reason,
      text: choice.message.content ?? "",
      refusal:
        Boolean(choice.message.refusal) ||
        choice.finish_reason === "content_filter",
      usage: parsed.data.usage
        ? {
            input_tokens: parsed.data.usage.prompt_tokens,
            output_tokens: parsed.data.usage.completion_tokens,
          }
        : undefined,
    };
  }
  const parsed = z
    .object({
      status: z.string().optional(),
      usage: z
        .object({ input_tokens: tokens, output_tokens: tokens })
        .optional(),
      output: z
        .array(
          z.object({
            type: z.string(),
            content: z
              .array(
                z.object({ type: z.string(), text: z.string().optional() }),
              )
              .optional(),
          }),
        )
        .default([]),
    })
    .safeParse(raw);
  if (!parsed.success) return null;
  const content = parsed.data.output.flatMap((o) => o.content ?? []);
  return {
    status: parsed.data.status ?? "unknown",
    text: content
      .filter((i) => i.type === "output_text")
      .map((i) => i.text ?? "")
      .join(""),
    refusal: content.some((i) => i.type === "refusal"),
    usage: parsed.data.usage,
  };
}
