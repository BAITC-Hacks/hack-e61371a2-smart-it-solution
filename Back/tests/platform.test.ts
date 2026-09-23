import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT, generateKeyPair } from "jose";
import { createPool, migrate } from "../src/db.js";
import { readBundle, importBundle } from "../src/imports.js";
import { seedDemoAccounts, userColumns, type User } from "../src/auth.js";
import { handleAdministration } from "../src/administration.js";
import {
  handleIntegrations,
  calendarFile,
  webhookSignature,
  processWebhooks,
  integrationTargets,
  enqueueMessengerNotifications,
  createReminders,
} from "../src/integrations.js";
import { handleAnalytics } from "../src/analytics.js";
import { validateOidcToken } from "../src/sso.js";
import { notificationText } from "../src/notification-copy.js";
import { HttpError, type RouteContext } from "../src/http.js";

test("calendar escaping and byte-aware folding prevent injected calendar fields", () => {
  const value = calendarFile([
    {
      id: "123",
      title: "Обучение\nBEGIN:VEVENT,опасно;".repeat(5),
      date: "2026-10-02",
    },
  ]);
  assert.equal(value.match(/BEGIN:VEVENT\r\n/g)?.length, 1);
  assert.match(value, /DTEND;VALUE=DATE:20261003/);
  assert.ok(value.split("\r\n").every((line) => Buffer.byteLength(line) <= 75));
});
test("webhook signature covers timestamp and exact body; target URLs require HTTPS", () => {
  assert.deepEqual(integrationTargets({ INTEGRATION_TARGETS_JSON: "" }), {});
  assert.notEqual(
    webhookSignature("secret", "1", "{}"),
    webhookSignature("secret", "2", "{}"),
  );
  assert.throws(() =>
    integrationTargets({
      INTEGRATION_TARGETS_JSON:
        '{"a":{"url":"http://localhost","secret":"1234567890123456"}}',
    }),
  );
});
test("notification copy supports Russian, Kazakh and English without inventing event translations", () => {
  assert.equal(
    notificationText("Вам отправили благодарность", "ru"),
    "Вам отправили благодарность",
  );
  assert.equal(
    notificationText("Вам отправили благодарность", "kk"),
    "Сізге алғыс жіберілді",
  );
  assert.equal(
    notificationText("Вам отправили благодарность", "en"),
    "You received a thank-you",
  );
  assert.equal(
    notificationText("Название авторского курса", "en"),
    "Название авторского курса",
  );
});
test("OIDC checks issuer, audience, nonce, expiry and signature", async () => {
  const keys = await generateKeyPair("RS256");
  const jwt = await new SignJWT({ nonce: "expected" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("employee-1")
    .setIssuer("https://sso.example.test")
    .setAudience("cq")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const settings = {
    issuer: "https://sso.example.test",
    clientId: "cq",
    nonce: "expected",
  };
  assert.equal(
    (await validateOidcToken(jwt, keys.publicKey, settings)).sub,
    "employee-1",
  );
  await assert.rejects(
    validateOidcToken(jwt, keys.publicKey, { ...settings, nonce: "wrong" }),
  );
  await assert.rejects(
    validateOidcToken(jwt, keys.publicKey, { ...settings, clientId: "wrong" }),
  );
  const expired = await new SignJWT({ nonce: "expected" })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject("employee-1")
    .setIssuer(settings.issuer)
    .setAudience("cq")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(keys.privateKey);
  await assert.rejects(validateOidcToken(expired, keys.publicKey, settings));
});
test(
  "platform SQL, administration and integrations",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const originalTargets = process.env.INTEGRATION_TARGETS_JSON;
    const originalMessenger = process.env.MESSENGER_TARGET_KEY;
    const originalFetch = globalThis.fetch;
    const schema = "cq_platform_" + randomUUID().replaceAll("-", "");
    const adminDb = createPool(process.env.TEST_DATABASE_URL!);
    await adminDb.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = createPool(url.toString());
    try {
      await migrate(pool);
      const fixture = await readBundle("./data");
      await importBundle(pool, fixture, { commit: true });
      await seedDemoAccounts(pool);
      const users = (
        await pool.query(`SELECT ${userColumns} FROM user_accounts u`)
      ).rows as User[];
      const admin = users.find((x) => x.role === "admin")!,
        hr = users.find((x) => x.role === "hr")!,
        employee = users.find((x) => x.role === "employee")!,
        manager = users.find((x) => x.role === "manager")!;
      async function call(
        handler: (ctx: RouteContext) => Promise<boolean>,
        path: string,
        method = "GET",
        body: unknown = {},
        user = admin,
        key = randomUUID(),
      ) {
        let data: unknown;
        const ctx = {
          pool,
          user,
          path: path.split("?")[0]!,
          method,
          url: new URL("http://localhost" + path),
          config: {
            databaseUrl: url.toString(),
            port: 0,
            origin: "http://localhost",
            demo: true,
            secure: false,
            datasetPath: "./data",
          },
          req: { headers: { "idempotency-key": key } },
          requestId: randomUUID(),
          body: async () => body,
          send: (d: unknown) => {
            data = d;
          },
        } as unknown as RouteContext;
        assert.equal(await handler(ctx), true);
        return data as Record<string, unknown>;
      }
      await t.test(
        "HR aggregate permissions, gaps, trends and explicit absent financial data",
        async () => {
          await assert.rejects(
            call(handleAnalytics, "/api/v1/hr/overview", "GET", {}, employee),
          );
          const started = performance.now();
          const overview = await call(
            handleAnalytics,
            "/api/v1/hr/overview",
            "GET",
            {},
            hr,
          );
          assert.equal(overview.employees, 200);
          assert.ok(Array.isArray(overview.skillGaps));
          console.log(
            "HR uncached aggregate ms:",
            Math.round(performance.now() - started),
          );
          const team = await call(
            handleAnalytics,
            "/api/v1/manager/overview",
            "GET",
            {},
            manager,
          );
          assert.ok(Number(team.employees) < 200);
          const trends = await call(handleAnalytics, "/api/v1/hr/trends");
          assert.equal(trends.hasLongitudinalData, false);
          assert.equal(
            (await call(handleAnalytics, "/api/v1/hr/roi")).available,
            false,
          );
          await call(
            handleAnalytics,
            "/api/v1/hr/program-financials/EV_005",
            "PUT",
            {
              currency: "KZT",
              cost: 100,
              measuredBenefit: 150,
              methodology:
                "Approved test measurement with explicit monetary benefit",
            },
          );
          const roi = await call(handleAnalytics, "/api/v1/hr/roi");
          assert.equal(
            (roi.programs as { roiPercent: number }[])[0]?.roiPercent,
            50,
          );
        },
      );
      await t.test(
        "admin account management protects last admin and revokes sessions",
        async () => {
          await assert.rejects(
            call(
              handleAdministration,
              `/api/v1/admin/accounts/${admin.id}`,
              "PATCH",
              { active: false },
            ),
          );
          await assert.rejects(
            call(
              handleAdministration,
              "/api/v1/admin/accounts",
              "POST",
              {
                login: "x",
                displayName: "x",
                role: "admin",
                employeeId: null,
                password: "secret-long-password",
              },
              employee,
            ),
          );
          const id = await call(
            handleAdministration,
            "/api/v1/admin/accounts",
            "POST",
            {
              login: "new.admin",
              displayName: "New admin",
              role: "admin",
              employeeId: null,
              password: "secret-long-password",
            },
          );
          await pool.query(
            "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,'test-hash','csrf',now()+interval '1 hour')",
            [id.id],
          );
          await call(
            handleAdministration,
            `/api/v1/admin/accounts/${id.id}`,
            "PATCH",
            { active: false },
          );
          assert.ok(
            (
              await pool.query(
                "SELECT revoked_at FROM sessions WHERE user_id=$1",
                [id.id],
              )
            ).rows[0].revoked_at,
          );
          const rows = await call(
            handleAdministration,
            "/api/v1/admin/accounts",
          );
          assert.ok(!JSON.stringify(rows).includes("password_hash"));
        },
      );
      await t.test(
        "concurrent OIDC identity links have a single owner",
        async () => {
          const accounts = await Promise.all(
            ["oidc.one", "oidc.two"].map((login) =>
              call(handleAdministration, "/api/v1/admin/accounts", "POST", {
                login,
                displayName: login,
                role: "hr",
                employeeId: null,
                password: "identity-test-password",
              }),
            ),
          );
          const results = await Promise.allSettled(
            accounts.map((account) =>
              call(
                handleAdministration,
                "/api/v1/admin/oidc-identities",
                "PUT",
                {
                  issuer: "https://id.example",
                  subject: "same-subject",
                  userId: account.id,
                },
              ),
            ),
          );
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          const failed = results.find(
            (r) => r.status === "rejected",
          ) as PromiseRejectedResult;
          assert.equal(failed.reason.status, 409);
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM oidc_identities"))
              .rows[0].n,
            1,
          );
        },
      );
      await t.test(
        "notifications are private and calendar uses only own participations",
        async () => {
          const inserted = (
            await pool.query(
              "INSERT INTO notifications(employee_id,kind,title,body) VALUES('E0002','test','Private','Private') RETURNING id",
            )
          ).rows[0];
          const list = await call(
            handleIntegrations,
            "/api/v1/notifications",
            "GET",
            {},
            employee,
          );
          assert.equal((list as unknown as unknown[]).length, 0);
          await assert.rejects(
            call(
              handleIntegrations,
              `/api/v1/notifications/${inserted.id}/read`,
              "POST",
              {},
              employee,
            ),
          );
          const calendar = await call(
            handleIntegrations,
            "/api/v1/calendar",
            "GET",
            {},
            employee,
          );
          assert.equal(calendar.dateOnly, true);
          assert.match(calendar.content as string, /BEGIN:VCALENDAR/);
        },
      );
      await t.test(
        "calendar and reminders use session or due dates rather than registration",
        async () => {
          for (const [id, format] of [
            ["CAL_SESSION", "online"],
            ["CAL_DUE", "self_paced"],
            ["CAL_NODATE", "self_paced"],
          ])
            await pool.query(
              "INSERT INTO events(event_id,title,description,type,format,duration_hours,mandatory) VALUES($1,$1,'Synthetic calendar test','course',$2,1,false)",
              [id, format],
            );
          const session = (
            await pool.query(
              "INSERT INTO event_sessions(event_id,session_date) VALUES('CAL_SESSION','2026-10-04') RETURNING id",
            )
          ).rows[0];
          const scheduled = (
            await pool.query(
              "INSERT INTO participations(employee_id,event_id,date,status,completion_pct,assigned_by,session_id) VALUES($1,'CAL_SESSION','2026-09-01','registered',0,'self',$2) RETURNING id",
              [employee.employeeId, session.id],
            )
          ).rows[0];
          const due = (
            await pool.query(
              "INSERT INTO participations(employee_id,event_id,date,due_date,status,completion_pct,assigned_by) VALUES($1,'CAL_DUE','2026-09-01','2026-10-05','registered',0,'self') RETURNING id",
              [employee.employeeId],
            )
          ).rows[0];
          const undated = (
            await pool.query(
              "INSERT INTO participations(employee_id,event_id,date,status,completion_pct,assigned_by) VALUES($1,'CAL_NODATE','2026-10-01','registered',0,'self') RETURNING id",
              [employee.employeeId],
            )
          ).rows[0];
          const calendar = await call(
            handleIntegrations,
            "/api/v1/calendar",
            "GET",
            {},
            employee,
          );
          const entries = (calendar.content as string).split("BEGIN:VEVENT");
          assert.ok(
            entries
              .find((x) => x.includes(scheduled.id))
              ?.includes("DTSTART;VALUE=DATE:20261004"),
          );
          assert.ok(
            entries
              .find((x) => x.includes(due.id))
              ?.includes("DTSTART;VALUE=DATE:20261005"),
          );
          const priorLanguage = (
            await pool.query(
              "SELECT preferred_language FROM employees WHERE employee_id=$1",
              [employee.employeeId],
            )
          ).rows[0].preferred_language;
          await pool.query(
            "UPDATE employees SET preferred_language='en' WHERE employee_id=$1",
            [employee.employeeId],
          );
          await pool.query(
            "INSERT INTO event_translations(event_id,locale,title,description,approved_by,approved_at) VALUES('CAL_SESSION','en','Approved English title','Approved description',$1,now())",
            [admin.id],
          );
          await createReminders(pool);
          const localized = (
            await pool.query(
              "SELECT title,body FROM notifications WHERE dedupe_key=$1",
              [`reminder:${scheduled.id}:2026-10-01`],
            )
          ).rows[0];
          assert.equal(localized.title, "Approved English title");
          assert.equal(localized.body, "Upcoming learning activity");
          await pool.query(
            "UPDATE employees SET preferred_language=$2 WHERE employee_id=$1",
            [employee.employeeId, priorLanguage],
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM notifications WHERE dedupe_key=ANY($1::text[])",
                [
                  [
                    `reminder:${scheduled.id}:2026-10-01`,
                    `reminder:${due.id}:2026-10-01`,
                  ],
                ],
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM notifications WHERE dedupe_key=$1",
                [`reminder:${undated.id}:2026-10-01`],
              )
            ).rows[0].n,
            0,
          );
          assert.equal((await createReminders(pool)).created, 0);
        },
      );
      await t.test(
        "webhooks use durable delivery IDs, retries and signatures",
        async () => {
          process.env.INTEGRATION_TARGETS_JSON = JSON.stringify({
            test: {
              url: "https://hooks.example.test/events",
              secret: "test-webhook-secret-long",
            },
          });
          const s = await call(
            handleIntegrations,
            "/api/v1/integrations/webhooks",
            "POST",
            { name: "Test", targetKey: "test", topics: ["goal.changed"] },
          );
          await pool.query(
            "INSERT INTO outbox_events(topic,payload) VALUES('goal.changed','{\"employeeId\":\"E0001\"}')",
          );
          const sent: {
            key: string;
            signature: string;
            timestamp: string;
            body: string;
          }[] = [];
          const mock: typeof fetch = async (_input, init) => {
            const h = new Headers(init?.headers);
            sent.push({
              key: h.get("Idempotency-Key")!,
              signature: h.get("X-Career-Quest-Signature")!,
              timestamp: h.get("X-Career-Quest-Timestamp")!,
              body: String(init?.body),
            });
            return new Response("", { status: sent.length === 1 ? 503 : 200 });
          };
          assert.equal(
            (await processWebhooks(pool, integrationTargets(), mock)).delivered,
            0,
          );
          await pool.query(
            "UPDATE webhook_deliveries SET next_attempt_at=now() WHERE subscription_id=$1",
            [s.id],
          );
          assert.equal(
            (await processWebhooks(pool, integrationTargets(), mock)).delivered,
            1,
          );
          assert.equal(sent[0]?.key, sent[1]?.key);
          assert.equal(
            sent[1]?.signature,
            webhookSignature(
              "test-webhook-secret-long",
              sent[1]!.timestamp,
              sent[1]!.body,
            ),
          );
          assert.equal(
            (await processWebhooks(pool, integrationTargets(), mock)).processed,
            0,
          );
        },
      );
      await t.test(
        "messenger needs opt-in and exact recipient; concurrent enqueue and revoked consent are safe",
        async () => {
          process.env.MESSENGER_TARGET_KEY = "relay";
          process.env.INTEGRATION_TARGETS_JSON = JSON.stringify({
            relay: {
              url: "https://relay.example.test/messages",
              secret: "test-messenger-secret-long",
            },
            other: {
              url: "https://other.example.test/messages",
              secret: "test-other-secret-long",
            },
          });
          const old = (
            await pool.query(
              "INSERT INTO notifications(employee_id,kind,title,body) VALUES($1,'test','Before opt-in','Private') RETURNING id",
              [employee.employeeId],
            )
          ).rows[0];
          await call(
            handleIntegrations,
            "/api/v1/integrations/identities",
            "PUT",
            {
              providerKey: "relay",
              entityType: "employee",
              externalId: "test-recipient",
              localId: employee.employeeId,
            },
          );
          for (const targetKey of ["relay", "other"])
            await call(
              handleIntegrations,
              "/api/v1/integrations/webhooks",
              "POST",
              { name: targetKey, targetKey, topics: ["notification.created"] },
            );
          assert.equal((await enqueueMessengerNotifications(pool)).queued, 0);
          await call(
            handleIntegrations,
            "/api/v1/notification-preferences",
            "PUT",
            { inApp: false, messenger: true, reminders: true },
            employee,
          );
          const current = (
            await pool.query(
              "INSERT INTO notifications(employee_id,kind,title,body) VALUES($1,'test','After opt-in','Private recipient only') RETURNING id",
              [employee.employeeId],
            )
          ).rows[0];
          const enqueues = await Promise.all([
            enqueueMessengerNotifications(pool),
            enqueueMessengerNotifications(pool),
          ]);
          assert.equal(
            enqueues.reduce((n, r) => n + r.queued, 0),
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT messenger_enqueued_at FROM notifications WHERE id=$1",
                [old.id],
              )
            ).rows[0].messenger_enqueued_at,
            null,
          );
          const sent: Array<{ url: string; payload: Record<string, unknown> }> =
            [];
          const mock: typeof fetch = async (url, init) => {
            sent.push({
              url: String(url),
              payload: JSON.parse(String(init?.body)).payload,
            });
            return new Response("", { status: 200 });
          };
          assert.equal(
            (await processWebhooks(pool, integrationTargets(), mock)).delivered,
            1,
          );
          assert.equal(sent[0]?.url, "https://relay.example.test/messages");
          assert.equal(sent[0]?.payload.recipientId, "test-recipient");
          assert.equal(sent[0]?.payload.notificationId, current.id);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id JOIN outbox_events e ON e.id=d.event_id WHERE e.topic='notification.created' AND s.target_key='other'",
              )
            ).rows[0].n,
            0,
          );
          await pool.query(
            "INSERT INTO notifications(employee_id,kind,title,body) VALUES($1,'test','Pending consent','Private')",
            [employee.employeeId],
          );
          assert.equal((await enqueueMessengerNotifications(pool)).queued, 1);
          await call(
            handleIntegrations,
            "/api/v1/notification-preferences",
            "PUT",
            { inApp: true, messenger: false, reminders: true },
            employee,
          );
          assert.equal(
            (await processWebhooks(pool, integrationTargets(), mock))
              .suppressed,
            1,
          );
          assert.equal(sent.length, 1);
          await call(
            handleIntegrations,
            "/api/v1/notification-preferences",
            "PUT",
            { inApp: true, messenger: true, reminders: true },
            employee,
          );
          await pool.query(
            "INSERT INTO notifications(employee_id,kind,title,body) VALUES($1,'test','Changed recipient','Private')",
            [employee.employeeId],
          );
          assert.equal((await enqueueMessengerNotifications(pool)).queued, 1);
          await pool.query(
            "UPDATE integration_identities SET external_id='different-recipient' WHERE provider_key='relay' AND external_id='test-recipient'",
          );
          assert.equal(
            (await processWebhooks(pool, integrationTargets(), mock))
              .suppressed,
            1,
          );
          assert.equal(sent.length, 1);
          delete process.env.MESSENGER_TARGET_KEY;
        },
      );
      await t.test(
        "tickets never invent external IDs and replay is idempotent",
        async () => {
          delete process.env.INTEGRATION_TARGETS_JSON;
          await assert.rejects(
            call(
              handleIntegrations,
              "/api/v1/tickets",
              "POST",
              {
                providerKey: "tickets",
                title: "Help",
                description: "A longer request",
              },
              employee,
            ),
          );
          process.env.INTEGRATION_TARGETS_JSON = JSON.stringify({
            tickets: {
              url: "https://tickets.example.test/api",
              secret: "test-ticket-secret-long",
            },
          });
          let requests = 0;
          globalThis.fetch = async () => {
            requests++;
            return Response.json({ id: "REAL-123", status: "open" });
          };
          const key = randomUUID();
          const payload = {
            providerKey: "tickets",
            title: "Help",
            description: "A longer request",
          };
          assert.equal(
            (
              await call(
                handleIntegrations,
                "/api/v1/tickets",
                "POST",
                payload,
                employee,
                key,
              )
            ).externalId,
            "REAL-123",
          );
          await call(
            handleIntegrations,
            "/api/v1/tickets",
            "POST",
            payload,
            employee,
            key,
          );
          assert.equal(requests, 1);
          assert.equal(
            (
              (await call(
                handleIntegrations,
                "/api/v1/tickets",
                "GET",
                {},
                manager,
              )) as unknown as unknown[]
            ).length,
            0,
          );
          globalThis.fetch = originalFetch;
        },
      );
      await t.test(
        "external history IDs are mapped and duplicate messages are safe",
        async () => {
          const record = {
            ...fixture.history![0]!,
            record_id: "EXTERNAL_TEST_1",
            employee_id: "external-employee",
            event_id: "external-event",
          };
          await call(
            handleIntegrations,
            "/api/v1/integrations/identities",
            "PUT",
            {
              providerKey: "lms",
              entityType: "employee",
              externalId: record.employee_id,
              localId: fixture.history![0]!.employee_id,
            },
          );
          await call(
            handleIntegrations,
            "/api/v1/integrations/identities",
            "PUT",
            {
              providerKey: "lms",
              entityType: "event",
              externalId: record.event_id,
              localId: fixture.history![0]!.event_id,
            },
          );
          const payload = {
            providerKey: "lms",
            messageId: "message-001",
            history: [record],
          };
          const blocker = await pool.connect();
          await blocker.query("BEGIN");
          await blocker.query("SELECT pg_advisory_xact_lock(2401902)");
          const inflight = call(
            handleIntegrations,
            "/api/v1/integrations/import",
            "POST",
            payload,
          ).then(
            (data) => ({ data, error: null }),
            (error) => ({ data: null, error }),
          );
          try {
            let claimed = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              claimed = Boolean(
                (
                  await pool.query(
                    "SELECT lease_token FROM integration_receipts WHERE provider_key='lms' AND message_id='message-001'",
                  )
                ).rows[0]?.lease_token,
              );
              if (claimed) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(claimed, true);
            const duplicates = await Promise.allSettled(
              Array.from({ length: 12 }, () =>
                call(
                  handleIntegrations,
                  "/api/v1/integrations/import",
                  "POST",
                  payload,
                ),
              ),
            );
            assert.ok(
              duplicates.every(
                (r) =>
                  r.status === "rejected" &&
                  r.reason instanceof HttpError &&
                  r.reason.code === "IMPORT_IN_PROGRESS",
              ),
            );
            assert.equal(
              (await pool.query("SELECT 1 AS available")).rows[0].available,
              1,
            );
          } finally {
            await blocker.query("ROLLBACK");
            blocker.release();
          }
          const completed = await inflight;
          if (completed.error) throw completed.error;
          const replay = await call(
            handleIntegrations,
            "/api/v1/integrations/import",
            "POST",
            payload,
          );
          assert.equal(completed.data!.hash, replay.hash);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM participations WHERE source_record_id='EXTERNAL_TEST_1'",
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            call(handleIntegrations, "/api/v1/integrations/import", "POST", {
              ...payload,
              history: [{ ...record, score: 0 }],
            }),
          );
          await pool.query(
            "UPDATE integration_receipts SET result='{\"pending\":true}',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second' WHERE provider_key='lms' AND message_id='message-001'",
          );
          await pool.query(
            "UPDATE integration_identities SET local_id=$1 WHERE provider_key='lms' AND entity_type='employee' AND external_id='external-employee'",
            [manager.employeeId],
          );
          const recovered = await call(
            handleIntegrations,
            "/api/v1/integrations/import",
            "POST",
            payload,
          );
          assert.equal(recovered.duplicate, true);
          assert.equal(recovered.hash, replay.hash);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalMessenger === undefined)
        delete process.env.MESSENGER_TARGET_KEY;
      else process.env.MESSENGER_TARGET_KEY = originalMessenger;
      if (originalTargets === undefined)
        delete process.env.INTEGRATION_TARGETS_JSON;
      else process.env.INTEGRATION_TARGETS_JSON = originalTargets;
      await pool.end();
      await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);
      await adminDb.end();
    }
  },
);
