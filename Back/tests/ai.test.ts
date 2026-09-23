import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { createPool, migrate } from "../src/db.js";
import { seedDemoAccounts, type User } from "../src/auth.js";
import { readBundle, importBundle } from "../src/imports.js";
import { seedGuideDemo } from "../src/guide.js";
import { readAiConfig } from "../src/ai-config.js";
import { readSemanticConfig } from "../src/semantic.js";
import {
  requestStructured,
  reserveAiBudget,
  settleAiBudget,
  rerankRecommendations,
  redactQuestion,
  answerAssistant,
  handleAssistant,
  cleanupAssistantRetention,
  revalidateSavedAnswer,
} from "../src/ai.js";
import { type RouteContext, HttpError } from "../src/http.js";

test("AI defaults disabled and requires explicit model pricing to enable", () => {
  assert.equal(readAiConfig({}).enabled, false);
  assert.throws(
    () =>
      readAiConfig({
        AI_ENABLED: "true",
        OPENAI_API_KEY: "dummy-test-key",
        AI_MODEL_FAST: "fake-model",
      }),
    /verified maximum/,
  );
  assert.equal(
    redactQuestion("sk-example123456789 test@example.invalid 123456789012"),
    "[secret removed] [email removed] [identifier removed]",
  );
});

const selfHostedEnv = {
  AI_ENABLED: "true",
  AI_PROVIDER: "self_hosted",
  AI_BASE_URL: "http://127.0.0.1:18000/v1/",
  AI_API_KEY: "test-private-gpu-key",
  AI_MODEL_FAST: "test-gpu-model",
  AI_USER_REQUESTS_PER_HOUR: "100",
  AI_PROJECT_REQUESTS_PER_DAY: "1000",
};

test("self-hosted configuration isolates credentials/prices and validates endpoint transport", () => {
  const config = readAiConfig({
    ...selfHostedEnv,
    OPENAI_API_KEY: "must-not-be-used",
    AI_INPUT_USD_PER_MILLION: "100",
    AI_OUTPUT_USD_PER_MILLION: "100",
    AI_TIMEOUT_MS: "60000",
  });
  assert.equal(config.provider, "self_hosted");
  assert.equal(config.baseUrl, "http://127.0.0.1:18000/v1");
  assert.equal(config.apiKey, selfHostedEnv.AI_API_KEY);
  assert.equal(config.inputPrice, 0);
  assert.equal(config.outputPrice, 0);
  assert.equal(config.timeoutMs, 60000);
  assert.throws(
    () => readAiConfig({ ...selfHostedEnv, AI_API_KEY: "" }),
    /AI_API_KEY/,
  );
  assert.throws(
    () => readAiConfig({ ...selfHostedEnv, AI_TIMEOUT_MS: "60001" }),
    /AI_TIMEOUT_MS/,
  );
  for (const endpoint of [
    "http://public.example/v1",
    "https://user:secret@example.com/v1",
    "https://example.com/v1?key=secret",
    "https://example.com/v1#fragment",
    "file:///tmp/model",
    "not-a-url",
    "http://169.254.169.254/v1",
  ])
    assert.throws(
      () => readAiConfig({ ...selfHostedEnv, AI_BASE_URL: endpoint }),
      /AI_BASE_URL/,
    );
  for (const endpoint of [
    "https://inference.example/v1",
    "http://host.docker.internal:18000/v1",
    "http://10.0.0.2:8000/v1",
    "http://172.16.0.2/v1",
    "http://192.168.1.2/v1",
    "http://[::1]:8000/v1",
    "http://[fd00::1]:8000/v1",
  ])
    assert.equal(
      readAiConfig({ ...selfHostedEnv, AI_BASE_URL: endpoint }).enabled,
      true,
    );
});

test("GPU generation never implicitly enables paid OpenAI embeddings", () => {
  const env = {
    ...selfHostedEnv,
    OPENAI_API_KEY: "separate-openai-key",
    AI_EMBEDDING_MODEL: "test-embedding",
    AI_EMBEDDING_USD_PER_MILLION: "0.2",
  };
  assert.equal(readSemanticConfig(env).enabled, false);
  const explicit = readSemanticConfig({ ...env, AI_EMBEDDING_ENABLED: "true" });
  assert.equal(explicit.enabled, true);
  assert.equal(explicit.budget.provider, "openai");
  assert.equal(explicit.budget.apiKey, env.OPENAI_API_KEY);
  assert.equal(explicit.budget.baseUrl, "https://api.openai.com/v1");
  assert.equal(
    readSemanticConfig({
      ...env,
      OPENAI_API_KEY: "",
      AI_EMBEDDING_ENABLED: "true",
    }).enabled,
    false,
  );
  assert.equal(
    readSemanticConfig({
      ...env,
      AI_PROVIDER: "openai",
      AI_EMBEDDING_ENABLED: "false",
    }).enabled,
    false,
  );
});

test(
  "AI provider, budget concurrency and owner-only assistant",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admin = createPool(process.env.TEST_DATABASE_URL!);
    const schema = `ai_test_${randomUUID().replaceAll("-", "")}`;
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      pool = createPool(url.toString());
      await migrate(pool);
      await importBundle(pool, await readBundle("./data"), { commit: true });
      await seedDemoAccounts(pool);
      await seedGuideDemo(pool);
      const users = (
        await pool.query(
          `SELECT id,login,display_name AS "displayName",app_role AS role,employee_id AS "employeeId",demo_only AS demo FROM user_accounts`,
        )
      ).rows as User[];
      const employee = users.find((u) => u.role === "employee")!,
        hr = users.find((u) => u.role === "hr")!,
        root = users.find((u) => u.role === "admin")!;
      const enabled = readAiConfig({
        AI_ENABLED: "true",
        OPENAI_API_KEY: "fake-key-no-network",
        AI_MODEL_FAST: "fake-model",
        AI_INPUT_USD_PER_MILLION: "1",
        AI_OUTPUT_USD_PER_MILLION: "2",
        AI_USER_REQUESTS_PER_HOUR: "100",
        AI_PROJECT_REQUESTS_PER_DAY: "1000",
      });
      const disabled = readAiConfig({});
      const selfHosted = readAiConfig(selfHostedEnv);
      const chatOutput = (value: unknown, finish = "stop") =>
        new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: finish,
                message: {
                  role: "assistant",
                  content: JSON.stringify(value),
                },
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 6 },
          }),
        );
      const output = (value: unknown) =>
        new Response(
          JSON.stringify({
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 5 },
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: JSON.stringify(value) }],
              },
            ],
          }),
          { status: 200 },
        );
      const minimal = {
        pool,
        userId: employee.id,
        config: enabled,
        purpose: "test",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        input: { test: true },
        instructions: "Select supplied facts only",
      };
      await t.test(
        "concurrent reservations cannot exceed cap; uncertain reservation is not reclaimed",
        async () => {
          const cfg = { ...enabled, projectBudget: 250, userBudget: 250 };
          const results = await Promise.allSettled(
            Array.from({ length: 3 }, () =>
              reserveAiBudget({
                pool: pool!,
                userId: employee.id,
                config: cfg,
                purpose: "concurrency",
                model: "fake",
                reservedMicrousd: 100,
              }),
            ),
          );
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            2,
          );
          assert.equal(
            results.filter((r) => r.status === "rejected").length,
            1,
          );
          const sum = (
            await pool!.query(
              `SELECT sum(reserved_microusd)::int AS n FROM ai_usage WHERE status='reserved'`,
            )
          ).rows[0].n;
          assert.equal(sum, 200);
          for (const r of results)
            if (r.status === "fulfilled")
              await settleAiBudget(pool!, r.value, {
                costMicrousd: 0,
                outcome: "test_no_call",
              });
        },
      );
      await t.test(
        "Responses API sends strict schema, store:false and settles actual token usage",
        async () => {
          const result = await requestStructured({
            ...minimal,
            fetchFn: async (input, init) => {
              assert.equal(input, "https://api.openai.com/v1/responses");
              const body = JSON.parse(init.body as string);
              assert.equal(body.store, false);
              assert.equal(body.text.format.strict, true);
              assert.equal(body.model, "fake-model");
              assert.equal(body.max_output_tokens, 800);
              assert.equal("tools" in body, false);
              return output({ ok: true });
            },
          });
          assert.ok("value" in result);
          if ("value" in result) assert.deepEqual(result.value, { ok: true });
          const usage = (
            await pool!.query("SELECT * FROM ai_usage WHERE id=$1", [
              result.usageId,
            ])
          ).rows[0];
          assert.equal(Number(usage.cost_microusd), 20);
          assert.equal(usage.status, "settled");
        },
      );
      await t.test(
        "self-hosted Chat Completions keeps strict output and token telemetry without API charges",
        async () => {
          const result = await requestStructured({
            ...minimal,
            config: { ...selfHosted, projectBudget: 1, userBudget: 1 },
            fetchFn: async (url, init) => {
              assert.equal(url, "http://127.0.0.1:18000/v1/chat/completions");
              assert.equal(init.redirect, "error");
              assert.equal(
                (init.headers as Record<string, string>).Authorization,
                "Bearer test-private-gpu-key",
              );
              const body = JSON.parse(String(init.body));
              assert.equal(body.response_format.json_schema.strict, true);
              assert.deepEqual(
                body.response_format.json_schema.schema,
                minimal.schema,
              );
              assert.equal(body.messages[0].role, "system");
              assert.equal(
                body.messages[1].content,
                JSON.stringify(minimal.input),
              );
              assert.equal(body.max_tokens, 800);
              assert.equal(body.stream, false);
              assert.equal("tools" in body, false);
              return chatOutput({ ok: true });
            },
          });
          assert.ok("value" in result);
          if ("value" in result) assert.deepEqual(result.value, { ok: true });
          const usage = (
            await pool!.query("SELECT * FROM ai_usage WHERE id=$1", [
              result.usageId,
            ])
          ).rows[0];
          assert.equal(usage.provider, "self_hosted");
          assert.equal(Number(usage.cost_microusd), 0);
          assert.equal(Number(usage.reserved_microusd), 0);
          assert.equal(usage.input_tokens, 12);
          assert.equal(usage.output_tokens, 6);
          // The same exhausted budget must still prevent any paid provider call.
          const paid = await requestStructured({
            ...minimal,
            config: { ...enabled, projectBudget: 1 },
            fetchFn: async () => {
              assert.fail("OpenAI budget must still be enforced");
            },
          });
          assert.equal("error" in paid && paid.error, "AI_BUDGET_LIMIT");
        },
      );
      await t.test(
        "self-hosted reservations cap concurrent calls across clients and reclaim only stale GPU leases",
        async () => {
          const reserve = () =>
            reserveAiBudget({
              pool: pool!,
              userId: employee.id,
              config: selfHosted,
              purpose: "gpu_concurrency",
              model: selfHosted.model,
              reservedMicrousd: 0,
            });
          const attempts = await Promise.allSettled([
            reserve(),
            reserve(),
            reserve(),
          ]);
          const ids = attempts
            .filter(
              (r): r is PromiseFulfilledResult<string> =>
                r.status === "fulfilled",
            )
            .map((r) => r.value);
          assert.equal(ids.length, 2);
          const rejected = attempts.find(
            (r) => r.status === "rejected",
          ) as PromiseRejectedResult;
          assert.equal(rejected.reason.code, "AI_CONCURRENCY_LIMIT");
          await pool!.query(
            "UPDATE ai_usage SET created_at=now()-interval '121 seconds' WHERE id=$1",
            [ids[0]],
          );
          const replacement = await reserve();
          const expired = (
            await pool!.query(
              "SELECT status,outcome,cost_microusd FROM ai_usage WHERE id=$1",
              [ids[0]],
            )
          ).rows[0];
          assert.equal(expired.status, "settled");
          assert.equal(expired.outcome, "expired_self_hosted");
          assert.equal(Number(expired.cost_microusd), 0);
          for (const id of [...ids, replacement])
            await settleAiBudget(pool!, id, {
              costMicrousd: 0,
              outcome: "test_no_call",
            });
        },
      );
      await t.test(
        "self-hosted malformed/truncated/refused responses and request quotas do not fall through to OpenAI",
        async () => {
          for (const [response, expected] of [
            [
              () => chatOutput({ ok: true }, "length"),
              "INCOMPLETE_AI_RESPONSE",
            ],
            [
              () => new Response(JSON.stringify({ choices: [] })),
              "INVALID_AI_RESPONSE",
            ],
            [
              () =>
                new Response(
                  JSON.stringify({
                    choices: [
                      {
                        index: 0,
                        finish_reason: "stop",
                        message: { role: "assistant", content: "not json" },
                      },
                    ],
                  }),
                ),
              "INVALID_AI_RESPONSE",
            ],
            [
              () =>
                new Response(
                  JSON.stringify({
                    choices: [
                      {
                        index: 0,
                        finish_reason: "stop",
                        message: {
                          role: "assistant",
                          content: null,
                          refusal: "Cannot answer",
                        },
                      },
                    ],
                  }),
                ),
              "AI_REFUSAL",
            ],
            [() => new Response("", { status: 503 }), "AI_UNAVAILABLE"],
          ] as const) {
            let count = 0;
            const result = await requestStructured({
              ...minimal,
              config: selfHosted,
              fetchFn: async (url) => {
                count++;
                assert.equal(url.startsWith(selfHosted.baseUrl), true);
                return response();
              },
            });
            assert.equal(count, 1);
            assert.equal("error" in result && result.error, expected);
          }
          const limited = await requestStructured({
            ...minimal,
            config: { ...selfHosted, userHourly: 1 },
            fetchFn: async () => {
              assert.fail("Shared request quota must prevent GPU calls too");
            },
          });
          assert.equal("error" in limited && limited.error, "AI_RATE_LIMIT");
        },
      );
      await t.test(
        "a timed-out GPU call retains a concurrency slot temporarily but never an API charge",
        async () => {
          const config = { ...selfHosted, timeoutMs: 50, maxConcurrent: 1 };
          const result = await requestStructured({
            ...minimal,
            config,
            fetchFn: (_url, init) =>
              new Promise((_resolve, reject) => {
                init.signal!.addEventListener(
                  "abort",
                  () => reject(new Error("aborted")),
                  { once: true },
                );
              }),
          });
          assert.equal("error" in result && result.error, "AI_TIMEOUT");
          const usage = (
            await pool!.query("SELECT * FROM ai_usage WHERE id=$1", [
              result.usageId,
            ])
          ).rows[0];
          assert.equal(Number(usage.cost_microusd), 0);
          assert.equal(usage.outcome, "timeout_uncertain");
          const busy = await requestStructured({
            ...minimal,
            config,
            fetchFn: async () => {
              assert.fail("Unknown remote completion still holds one slot");
            },
          });
          assert.equal("error" in busy && busy.error, "AI_CONCURRENCY_LIMIT");
          await pool!.query(
            "UPDATE ai_usage SET created_at=now()-interval '121 seconds' WHERE id=$1",
            [result.usageId],
          );
          const recovered = await requestStructured({
            ...minimal,
            config,
            fetchFn: async () => chatOutput({ ok: true }),
          });
          assert.ok("value" in recovered);
        },
      );
      await t.test(
        "malformed JSON, refusal and invented candidate IDs produce fallback",
        async () => {
          const candidates = [
            {
              eventId: "EV001",
              facts: [{ id: "gap", text: "Verified skill gap" }],
            },
          ];
          const invented = await rerankRecommendations({
            pool: pool!,
            userId: employee.id,
            config: enabled,
            candidates,
            context: { grade: "Junior" },
            fetchFn: async () =>
              output({ items: [{ eventId: "EV_FAKE", factIds: ["gap"] }] }),
          });
          assert.equal(invented.source, "fallback");
          assert.deepEqual(invented.eventIds, ["EV001"]);
          const wrongFact = await rerankRecommendations({
            pool: pool!,
            userId: employee.id,
            config: enabled,
            candidates,
            context: {},
            fetchFn: async () =>
              output({ items: [{ eventId: "EV001", factIds: ["invented"] }] }),
          });
          assert.equal(wrongFact.source, "fallback");
          const valid = await rerankRecommendations({
            pool: pool!,
            userId: employee.id,
            config: enabled,
            candidates,
            context: {},
            fetchFn: async () =>
              output({ items: [{ eventId: "EV001", factIds: ["gap"] }] }),
          });
          assert.equal(valid.source, "ai");
          const malformed = await requestStructured({
            ...minimal,
            fetchFn: async () => new Response("not json"),
          });
          assert.equal(
            "error" in malformed && malformed.error,
            "INVALID_AI_RESPONSE",
          );
          const refusal = await requestStructured({
            ...minimal,
            fetchFn: async () =>
              new Response(
                JSON.stringify({
                  status: "completed",
                  output: [{ type: "message", content: [{ type: "refusal" }] }],
                }),
              ),
          });
          assert.equal("error" in refusal && refusal.error, "AI_REFUSAL");
        },
      );
      await t.test(
        "retry only explicit 429; network failures keep conservative cost and are not retried",
        async () => {
          let attempts = 0;
          const retry = await requestStructured({
            ...minimal,
            fetchFn: async () =>
              ++attempts === 1
                ? new Response("", { status: 429 })
                : output({ ok: true }),
          });
          assert.equal(attempts, 2);
          assert.ok("value" in retry);
          attempts = 0;
          const failure = await requestStructured({
            ...minimal,
            fetchFn: async () => {
              attempts++;
              throw new Error("network");
            },
          });
          assert.equal(attempts, 1);
          assert.equal("error" in failure && failure.error, "AI_UNAVAILABLE");
          const usage = (
            await pool!.query("SELECT * FROM ai_usage WHERE id=$1", [
              failure.usageId,
            ])
          ).rows[0];
          assert.equal(usage.cost_microusd, usage.reserved_microusd);
        },
      );
      await t.test(
        "timeout aborts fake provider and request quotas prevent provider calls",
        async () => {
          const timeout = await requestStructured({
            ...minimal,
            config: { ...enabled, timeoutMs: 50 },
            fetchFn: (_url, init) =>
              new Promise((_resolve, reject) => {
                init.signal!.addEventListener(
                  "abort",
                  () => reject(new Error("aborted")),
                  { once: true },
                );
              }),
          });
          assert.equal("error" in timeout && timeout.error, "AI_TIMEOUT");
          let called = false;
          const limited = await requestStructured({
            ...minimal,
            config: { ...enabled, userHourly: 1 },
            fetchFn: async () => {
              called = true;
              return output({ ok: true });
            },
          });
          assert.equal(called, false);
          assert.equal("error" in limited && limited.error, "AI_RATE_LIMIT");
        },
      );
      await t.test(
        "assistant selection constrains IDs and renders a selected demonstration instruction without inventing contacts",
        async () => {
          let selectedId: string | undefined;
          const answer = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "Что указано в демонстрационной инструкции про ноутбук?",
            locale: "ru",
            config: selfHosted,
            fetchFn: async (_url, init) => {
              const body = JSON.parse(String(init.body));
              const input = JSON.parse(body.messages[1].content);
              const properties =
                body.response_format.json_schema.schema.properties;
              const ids = input.sources.map(
                (source: { id: string }) => source.id,
              );
              assert.ok(ids.length > 0);
              assert.deepEqual(properties.sourceIds.items.enum, ids);
              assert.equal(
                properties.sourceIds.maxItems,
                Math.min(3, ids.length),
              );
              // No career facts were supplied: an empty array is required,
              // rather than an invalid JSON Schema enum: [].
              assert.deepEqual(input.facts, []);
              assert.equal(properties.factIds.maxItems, 0);
              assert.equal("enum" in properties.factIds.items, false);
              selectedId = ids[0];
              return chatOutput({
                sourceIds: [selectedId],
                factIds: [],
                needsClarification: false,
              });
            },
          });
          assert.equal(answer.source, "ai");
          assert.deepEqual(
            answer.citations.map((citation) => citation.id),
            [selectedId],
          );
          assert.equal(answer.citations[0]!.synthetic, true);
          assert.match(answer.content, /Демонстрационный материал/);
          assert.ok(answer.contacts.every((contact) => contact.synthetic));
          assert.deepEqual(answer.facts, []);
        },
      );
      await t.test(
        "assistant renders grounded model wording with validated citations",
        async () => {
          const generatedText =
            "В демонстрационной инструкции описаны действия при проблемах с ноутбуком. Реальные контакты организации пока не настроены.";
          let selectedId: string | undefined;
          const answer = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "Что делать, если сломался ноутбук?",
            locale: "ru",
            config: selfHosted,
            fetchFn: async (_url, init) => {
              const body = JSON.parse(String(init.body));
              const input = JSON.parse(body.messages[1].content);
              assert.ok(
                body.response_format.json_schema.schema.required.includes(
                  "answerText",
                ),
              );
              selectedId = input.sources[0].id;
              return chatOutput({
                sourceIds: [selectedId],
                factIds: [],
                needsClarification: false,
                answerText: generatedText,
              });
            },
          });
          assert.equal(answer.source, "ai");
          assert.ok(answer.content.includes(generatedText));
          assert.deepEqual(
            answer.citations.map((citation) => citation.id),
            [selectedId],
          );
          assert.equal(answer.citations[0]!.synthetic, true);
          assert.ok(answer.contacts.every((contact) => contact.synthetic));
        },
      );
      await t.test(
        "assistant selection constrains career fact IDs and renders the actual own profile",
        async () => {
          let expectedProfile = "";
          const answer = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "Какая у меня текущая роль и грейд?",
            locale: "ru",
            config: selfHosted,
            fetchFn: async (_url, init) => {
              const body = JSON.parse(String(init.body));
              const input = JSON.parse(body.messages[1].content);
              const properties =
                body.response_format.json_schema.schema.properties;
              const facts = input.facts as { id: string; text: string }[];
              assert.deepEqual(
                properties.factIds.items.enum,
                facts.map((fact) => fact.id),
              );
              const profile = facts.find((fact) => fact.id === "profile");
              assert.ok(profile);
              expectedProfile = profile.text;
              return chatOutput({
                sourceIds: [],
                factIds: [profile.id],
                needsClarification: false,
              });
            },
          });
          assert.equal(answer.source, "ai");
          assert.deepEqual(
            answer.facts.map((fact) => fact.id),
            ["profile"],
          );
          assert.ok(answer.content.includes(expectedProfile));
          assert.deepEqual(answer.citations, []);
          assert.deepEqual(answer.contacts, []);
          assert.equal(answer.fallbackReason, undefined);
        },
      );
      await t.test(
        "assistant uses approved excerpts, refuses fabricated citations, no AI on sensitive scripts",
        async () => {
          const answer = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "сломался ноутбук",
            locale: "ru",
            config: disabled,
          });
          assert.equal(answer.source, "fallback");
          assert.equal(answer.citations.length, 1);
          assert.equal(answer.citations[0]!.synthetic, true);
          assert.ok(answer.contacts.every((contact) => contact.synthetic));
          const fabricated = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "ноутбук",
            locale: "ru",
            config: enabled,
            fetchFn: async () =>
              output({
                sourceIds: [randomUUID()],
                factIds: [],
                needsClarification: false,
                answerText: "FABRICATED_SOURCE_MUST_NEVER_BE_RENDERED",
              }),
          });
          assert.equal(fabricated.source, "fallback");
          assert.equal(fabricated.fallbackReason, "INVALID_AI_SELECTION");
          assert.equal(
            fabricated.content.includes("FABRICATED_SOURCE_MUST_NEVER_BE_RENDERED"),
            false,
          );
          let called = false;
          const sensitive = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "конфликт",
            locale: "ru",
            config: enabled,
            fetchFn: async () => {
              called = true;
              return output({});
            },
          });
          assert.equal(called, false);
          assert.equal(sensitive.source, "verified_script");
          const career = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "Мои навыки и карьера",
            locale: "ru",
            config: disabled,
          });
          assert.ok(career.facts.some((f) => f.id === "profile"));
          assert.ok(
            career.facts.every((f) => f.href.includes(employee.employeeId!)),
          );
        },
      );
      await t.test(
        "saved learning context keeps only the owning employee and safe internal links",
        async () => {
          const saved: Parameters<typeof revalidateSavedAnswer>[2] = {
            content: "Suggested course", source: "ai", locale: "ru", scope: "own",
            citations: [], contacts: [],
            facts: [{ id: "event:EV_012", text: "Advanced Python", href: "/events/EV_012", employeeId: employee.employeeId! }],
          };
          assert.equal((await revalidateSavedAnswer(pool!, employee, saved)).content, saved.content);
          const other = { ...saved, facts: saved.facts.map((f) => ({ ...f, employeeId: "E9999" })) };
          assert.equal((await revalidateSavedAnswer(pool!, employee, other)).fallbackReason, "SOURCE_ACCESS_CHANGED");
          const external = { ...saved, facts: saved.facts.map((f) => ({ ...f, href: "https://example.invalid/" })) };
          assert.equal((await revalidateSavedAnswer(pool!, employee, external)).fallbackReason, "SOURCE_ACCESS_CHANGED");
        },
      );
      await t.test(
        "conversation includes both roles, redacts personal data and bounds context",
        async () => {
          const fullName = (
            await pool!.query(
              "SELECT full_name FROM employees WHERE employee_id=$1",
              [employee.employeeId],
            )
          ).rows[0].full_name;
          const conversation = Array.from({ length: 14 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content:
              `CONVERSATION_TURN_${index}: Мои навыки ${fullName} ${employee.employeeId} test@example.invalid sk-example123456789 ` +
              "подробности ".repeat(150),
          }));
          let input: any;
          const answer = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "Почему?",
            conversation,
            locale: "ru",
            config: selfHosted,
            fetchFn: async (_url, init) => {
              const body = JSON.parse(String(init.body));
              input = JSON.parse(body.messages[1].content);
              return chatOutput({
                sourceIds: [],
                factIds: ["profile"],
                needsClarification: false,
                answerText: "Ваш текущий профиль учтён в ответе.",
              });
            },
          });
          assert.ok(input, answer.fallbackReason);
          assert.equal(input.conversation.length, 12);
          assert.deepEqual(
            input.conversation.map((turn: { role: string }) => turn.role),
            conversation.slice(-12).map((turn) => turn.role),
          );
          assert.match(
            input.conversation[0].content,
            /^CONVERSATION_TURN_2:/,
          );
          assert.match(
            input.conversation.at(-1).content,
            /^CONVERSATION_TURN_13:/,
          );
          for (const turn of input.conversation) {
            assert.ok(turn.content.length <= 1000);
            for (const secret of [
              fullName,
              employee.employeeId!,
              "test@example.invalid",
              "sk-example123456789",
            ])
              assert.equal(turn.content.includes(secret), false);
          }
          assert.ok(input.facts.some((fact: { id: string }) => fact.id === "profile"));
        },
      );
      await t.test(
        "provider receives no employee names/IDs or frontend links and source access is rechecked after inference",
        async () => {
          const fullName = (
            await pool!.query(
              "SELECT full_name FROM employees WHERE employee_id=$1",
              [employee.employeeId],
            )
          ).rows[0].full_name;
          let checked = false;
          await answerAssistant({
            pool: pool!,
            user: employee,
            question: `Мои навыки ${fullName} ${employee.employeeId}`,
            locale: "ru",
            config: enabled,
            fetchFn: async (_url, init) => {
              const encoded = String(init.body);
              assert.equal(encoded.includes(fullName), false);
              assert.equal(encoded.includes(employee.employeeId!), false);
              assert.equal(encoded.includes("/employees/"), false);
              checked = true;
              return output({
                sourceIds: [],
                factIds: ["profile"],
                needsClarification: false,
              });
            },
          });
          assert.equal(checked, true);
          const changed = await answerAssistant({
            pool: pool!,
            user: employee,
            question: "ноутбук",
            locale: "ru",
            config: enabled,
            fetchFn: async (_url, init) => {
              const payload = JSON.parse(JSON.parse(String(init.body)).input);
              const articleId = payload.sources[0].id;
              await pool!.query(
                `UPDATE guide_articles SET status='archived' WHERE id=$1`,
                [articleId],
              );
              return output({
                sourceIds: [articleId],
                factIds: [],
                needsClarification: false,
                answerText: "ARCHIVED_SOURCE_MUST_NEVER_BE_RENDERED",
              });
            },
          });
          assert.equal(changed.citations.length, 0);
          assert.match(changed.content, /нет подтверждённого ответа/);
          assert.equal(
            changed.content.includes("ARCHIVED_SOURCE_MUST_NEVER_BE_RENDERED"),
            false,
          );
        },
      );
      const invoke = async (
        user: User,
        path: string,
        method = "GET",
        payload: unknown = {},
        key = randomUUID(),
      ) => {
        let result: any;
        let status = 200;
        const parsed = new URL(`http://test${path}`);
        const ctx: RouteContext = {
          pool: pool!,
          config: {
            databaseUrl: url.toString(),
            port: 0,
            origin: "http://test",
            demo: true,
            secure: false,
            datasetPath: "./data",
          },
          user,
          path: parsed.pathname,
          method,
          url: parsed,
          req: {
            headers: { "idempotency-key": key },
          } as unknown as IncomingMessage,
          requestId: randomUUID(),
          body: async () => payload,
          send: (data, code = 200) => {
            result = data;
            status = code;
          },
        };
        assert.equal(await handleAssistant(ctx, disabled), true);
        return { data: result, status };
      };
      let threadId: string;
      await t.test(
        "thread/messages owner-only even for HR/admin, replay protected and deletion cascades",
        async () => {
          threadId = (
            await invoke(employee, "/assistant/threads", "POST", {
              title: "Мои вопросы",
              locale: "ru",
            })
          ).data.id;
          for (const other of [hr, root]) {
            await assert.rejects(
              invoke(other, `/assistant/threads/${threadId}`),
              (e: unknown) => e instanceof HttpError && e.status === 404,
            );
            await assert.rejects(
              invoke(other, `/assistant/threads/${threadId}/messages`, "POST", {
                content: "Мои навыки",
              }),
              HttpError,
            );
          }
          const key = randomUUID();
          const first = await invoke(
            employee,
            `/assistant/threads/${threadId}/messages`,
            "POST",
            { content: "сломался ноутбук" },
            key,
          );
          const second = await invoke(
            employee,
            `/assistant/threads/${threadId}/messages`,
            "POST",
            { content: "сломался ноутбук" },
            key,
          );
          assert.equal(first.data.id, second.data.id);
          await assert.rejects(
            invoke(
              employee,
              `/assistant/threads/${threadId}/messages`,
              "POST",
              { content: "другой вопрос" },
              key,
            ),
            (e: unknown) =>
              e instanceof HttpError && e.code === "IDEMPOTENCY_CONFLICT",
          );
          const messages = (
            await invoke(employee, `/assistant/threads/${threadId}`)
          ).data.messages;
          assert.equal(messages.length, 2);
          await invoke(employee, `/assistant/threads/${threadId}`, "DELETE");
          assert.equal(
            (
              await pool!.query(
                "SELECT count(*)::int AS n FROM assistant_messages WHERE thread_id=$1",
                [threadId],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "retention hides and deletes expired chats without erasing spend ledger",
        async () => {
          threadId = (
            await invoke(employee, "/assistant/threads", "POST", {
              title: "Истекший диалог",
            })
          ).data.id;
          await pool!.query(
            `UPDATE assistant_threads SET expires_at=now()-interval '1 day' WHERE id=$1`,
            [threadId],
          );
          await assert.rejects(
            invoke(employee, `/assistant/threads/${threadId}`),
            HttpError,
          );
          assert.equal(await cleanupAssistantRetention(pool!), 1);
          assert.ok((await invoke(root, "/admin/ai/usage")).data.requests > 0);
          await assert.rejects(invoke(employee, "/admin/ai/usage"), HttpError);
        },
      );
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
