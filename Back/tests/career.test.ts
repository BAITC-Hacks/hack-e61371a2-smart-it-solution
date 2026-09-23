import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate } from "../src/db.js";
import { readBundle, importBundle } from "../src/imports.js";
import {
  handleCareer,
  loadCareer,
  computeRecommendations,
  loadEvents,
  eligibility,
} from "../src/career.js";
import { HttpError, type RouteContext } from "../src/http.js";
import type { User } from "../src/auth.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  "career PostgreSQL transactions, profiles and recommendations",
  { skip: !databaseUrl },
  async (t) => {
    const schema = `career_test_${randomUUID().replaceAll("-", "")}`,
      admin = createPool(databaseUrl!);
    let pool: ReturnType<typeof createPool> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      pool = createPool(url.toString());
      await migrate(pool);
      await importBundle(pool, await readBundle("./data"), { commit: true });
      const db = pool,
        batch = (await db.query("SELECT id FROM dataset_batches LIMIT 1"))
          .rows[0].id;
      for (const employeeId of ["TEST_MANAGER", "TEST_A", "TEST_B", "TEST_C"]) {
        await db.query(
          "INSERT INTO employees(employee_id,full_name,department,role,grade,hire_date,tenure_months,work_format,preferred_language,last_review_date,dataset_batch_id) VALUES($1,$1,'Test','Backend Engineer','Junior','2026-01-01',9,'remote','ru','2026-09-01',$2)",
          [employeeId, batch],
        );
        await db.query(
          "INSERT INTO employee_skill_baselines VALUES($1,'SK_SQL',1)",
          [employeeId],
        );
      }
      await db.query(
        "UPDATE employees SET manager_id='TEST_MANAGER' WHERE employee_id IN ('TEST_A','TEST_B')",
      );
      async function account(
        role: User["role"],
        employeeId: string | null,
      ): Promise<User> {
        const row = (
          await db.query(
            "INSERT INTO user_accounts(login,display_name,employee_id,app_role,demo_only) VALUES($1,$1,$2,$3,true) RETURNING id",
            [randomUUID(), employeeId, role],
          )
        ).rows[0];
        return {
          id: row.id,
          login: "test",
          displayName: "Test",
          role,
          employeeId,
          demo: true,
        };
      }
      const hr = await account("hr", null),
        employee = await account("employee", "TEST_A"),
        second = await account("employee", "TEST_B"),
        third = await account("employee", "TEST_C"),
        manager = await account("manager", "TEST_MANAGER");
      async function request(
        user: User,
        path: string,
        method = "GET",
        body: unknown = {},
        key = randomUUID(),
      ) {
        let result: any,
          status = 200,
          meta: unknown;
        const handled = await handleCareer({
          pool: db,
          user,
          path: path.split("?")[0]!,
          method,
          url: new URL(`http://test${path}`),
          config: {
            databaseUrl: databaseUrl!,
            port: 0,
            origin: "http://test",
            demo: true,
            secure: false,
            datasetPath: "./data",
          },
          requestId: randomUUID(),
          req: { headers: { "idempotency-key": key } },
          body: async () => body,
          send: (value: unknown, code = 200, m?: unknown) => {
            result = value;
            status = code;
            meta = m;
          },
        } as unknown as RouteContext);
        assert.equal(handled, true, `${method} ${path}`);
        return { data: result, status, meta };
      }
      const eventInput = {
        eventId: "TEST_SELF",
        title: "SQL development",
        description: "Test",
        type: "course",
        format: "self_paced",
        durationHours: 2,
        mandatory: false,
        targetRoles: ["Backend Engineer"],
        targetGrades: ["Junior"],
        effects: [{ skillId: "SK_SQL", gain: 2, maxLevel: 4 }],
        prerequisites: [],
        sessions: [],
      };
      await request(hr, "/api/v1/events", "POST", eventInput);
      let participationId: string;
      await t.test(
        "profile access, manager read scope and forbidden team writes",
        async () => {
          assert.equal(
            (await request(employee, "/api/v1/employees/TEST_A")).data.id,
            "TEST_A",
          );
          await assert.rejects(
            request(employee, "/api/v1/employees/TEST_B"),
            (e: unknown) => e instanceof HttpError && e.status === 404,
          );
          assert.equal(
            (await request(manager, "/api/v1/employees/TEST_A")).data.id,
            "TEST_A",
          );
          await assert.rejects(
            request(manager, "/api/v1/employees/TEST_C"),
            (e: unknown) => e instanceof HttpError && e.status === 404,
          );
          await assert.rejects(
            request(manager, "/api/v1/employees/TEST_A/goal", "PUT", {
              targetRole: "Backend Engineer",
              targetGrade: "Middle",
            }),
            (e: unknown) => e instanceof HttpError && e.status === 403,
          );
        },
      );
      await t.test(
        "registration is durable-idempotent and one active participation remains",
        async () => {
          const key = randomUUID(),
            payload = { employeeId: "TEST_A", eventId: "TEST_SELF" };
          const results = await Promise.all([
            request(employee, "/api/v1/participations", "POST", payload, key),
            request(employee, "/api/v1/participations", "POST", payload, key),
          ]);
          participationId = results[0].data.id;
          assert.equal(results[1].data.id, participationId);
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM participations WHERE employee_id='TEST_A' AND event_id='TEST_SELF'",
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            request(
              employee,
              "/api/v1/participations",
              "POST",
              { ...payload, joinWaitlist: true },
              key,
            ),
            (e: unknown) =>
              e instanceof HttpError && e.code === "IDEMPOTENCY_CONFLICT",
          );
        },
      );
      await t.test(
        "start, completion, duplicate retry and historical effects snapshot",
        async () => {
          await request(
            employee,
            `/api/v1/participations/${participationId}/start`,
            "POST",
            {},
          );
          const complete = await request(
            employee,
            `/api/v1/participations/${participationId}/complete`,
            "POST",
            { score: 90 },
          );
          assert.equal(complete.data.participation.status, "completed");
          assert.equal(
            (await loadCareer(db, "TEST_A")).effectiveLevels.SK_SQL,
            3,
          );
          assert.equal(
            (
              await request(
                employee,
                `/api/v1/participations/${participationId}/complete`,
                "POST",
                {},
              )
            ).data.alreadyCompleted,
            true,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM outbox_events WHERE topic='participation.completed'",
              )
            ).rows[0].n,
            1,
          );
          await request(hr, "/api/v1/events/TEST_SELF", "PATCH", {
            effects: [{ skillId: "SK_SQL", gain: 1, maxLevel: 2 }],
          });
          assert.equal(
            (await loadCareer(db, "TEST_A")).effectiveLevels.SK_SQL,
            3,
            "catalog edits must not rewrite past completion gains",
          );
          await assert.rejects(
            request(employee, "/api/v1/participations", "POST", {
              employeeId: "TEST_A",
              eventId: "TEST_SELF",
            }),
            (e: unknown) =>
              e instanceof HttpError && e.code === "EVENT_INELIGIBLE",
          );
        },
      );
      await t.test(
        "authorized correction replays history and records reason",
        async () => {
          await assert.rejects(
            request(
              employee,
              `/api/v1/participations/${participationId}`,
              "PATCH",
              { status: "dropped", reason: "wrong completion" },
            ),
            (e: unknown) => e instanceof HttpError && e.status === 403,
          );
          await request(
            hr,
            `/api/v1/participations/${participationId}`,
            "PATCH",
            { status: "dropped", reason: "wrong completion" },
          );
          assert.equal(
            (await loadCareer(db, "TEST_A")).effectiveLevels.SK_SQL,
            1,
          );
          assert.equal(
            (
              await db.query(
                "SELECT details->>'reason' AS reason FROM audit_log WHERE action='participation.corrected'",
              )
            ).rows[0].reason,
            "wrong completion",
          );
        },
      );
      await t.test(
        "capacity remains bounded under concurrent registrations and queue promotion",
        async () => {
          await request(hr, "/api/v1/events", "POST", {
            ...eventInput,
            eventId: "TEST_SESSION",
            format: "online",
            sessions: [{ date: "2026-10-10", capacity: 1 }],
          });
          const attempts = await Promise.allSettled([
            request(employee, "/api/v1/participations", "POST", {
              employeeId: "TEST_A",
              eventId: "TEST_SESSION",
            }),
            request(second, "/api/v1/participations", "POST", {
              employeeId: "TEST_B",
              eventId: "TEST_SESSION",
            }),
          ]);
          assert.equal(
            attempts.filter((x) => x.status === "fulfilled").length,
            1,
          );
          const succeeded = attempts.find(
              (x) => x.status === "fulfilled",
            ) as PromiseFulfilledResult<any>,
            winner =
              succeeded.value.data.employeeId === "TEST_A" ? employee : second,
            waiting = winner === employee ? second : employee;
          const queue = await request(
            waiting,
            "/api/v1/participations",
            "POST",
            {
              employeeId: waiting.employeeId,
              eventId: "TEST_SESSION",
              joinWaitlist: true,
            },
          );
          assert.equal(queue.data.status, "waitlisted");
          await assert.rejects(
            request(
              winner,
              `/api/v1/participations/${succeeded.value.data.id}/start`,
              "POST",
              {},
            ),
            (e: unknown) =>
              e instanceof HttpError && e.code === "SESSION_NOT_STARTED",
          );
          await request(
            winner,
            `/api/v1/participations/${succeeded.value.data.id}/drop`,
            "POST",
            {},
          );
          assert.equal(
            (await request(waiting, `/api/v1/participations/${queue.data.id}`))
              .data.status,
            "registered",
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM participations WHERE event_id='TEST_SESSION' AND status='registered'",
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM notifications WHERE kind='waitlist'",
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            request(hr, "/api/v1/events/TEST_SESSION", "PATCH", {
              sessions: [],
            }),
            (e: unknown) =>
              e instanceof HttpError && e.code === "SESSION_IN_USE",
          );
        },
      );
      await t.test(
        "recommendations are valid, explain >=3 factors, persist and detect changed goal",
        async () => {
          const result = await request(
              third,
              "/api/v1/employees/TEST_C/recommendations",
              "POST",
              {},
            ),
            recs = result.data.recommendations;
          assert.ok(recs.length >= 1 && recs.length <= 3);
          const events = await loadEvents(db),
            profile = await loadCareer(db, "TEST_C");
          for (const rec of recs) {
            const event = events.find((e) => e.eventId === rec.eventId)!;
            assert.equal(event.mandatory, false);
            assert.equal(eligibility(event, profile).eligible, true);
            assert.ok(new Set(rec.factorIds).size >= 3);
            assert.ok(rec.expectedGains.every((g: any) => g.to > g.from));
          }
          const cached = await request(
            third,
            "/api/v1/employees/TEST_C/recommendations",
            "POST",
            {},
          );
          assert.equal(cached.data.runId, result.data.runId);
          assert.equal(cached.data.cached, true);
          assert.equal(
            (
              await request(
                third,
                "/api/v1/employees/TEST_C/recommendations/latest",
              )
            ).data.stale,
            false,
          );
          await request(third, "/api/v1/employees/TEST_C/goal", "PUT", {
            targetRole: "Backend Engineer",
            targetGrade: "Senior",
          });
          assert.equal(
            (
              await request(
                third,
                "/api/v1/employees/TEST_C/recommendations/latest",
              )
            ).data.stale,
            true,
          );
          await request(
            third,
            `/api/v1/recommendations/${result.data.runId}/feedback`,
            "POST",
            { eventId: recs[0].eventId, helpful: false, reason: "Timing" },
          );
          await assert.rejects(
            request(
              employee,
              `/api/v1/recommendations/${result.data.runId}/feedback`,
              "POST",
              { eventId: recs[0].eventId, helpful: true },
            ),
            (e: unknown) => e instanceof HttpError && e.status === 404,
          );
        },
      );
      await t.test(
        "idempotent replays recheck employee ownership and current manager scope",
        async () => {
          const changedIdentity = { ...third, employeeId: "TEST_A" };
          const goalKey = randomUUID(),
            goal = { targetRole: "Backend Engineer", targetGrade: "Middle" };
          await request(
            third,
            "/api/v1/employees/TEST_C/goal",
            "PUT",
            goal,
            goalKey,
          );
          await assert.rejects(
            request(
              changedIdentity,
              "/api/v1/employees/TEST_C/goal",
              "PUT",
              goal,
              goalKey,
            ),
            (e: unknown) => e instanceof HttpError && e.status === 404,
          );
          const clearKey = randomUUID();
          await request(
            third,
            "/api/v1/employees/TEST_C/goal",
            "DELETE",
            {},
            clearKey,
          );
          await assert.rejects(
            request(
              changedIdentity,
              "/api/v1/employees/TEST_C/goal",
              "DELETE",
              {},
              clearKey,
            ),
            (e: unknown) => e instanceof HttpError && e.status === 404,
          );
          const recKey = randomUUID();
          await request(
            manager,
            "/api/v1/employees/TEST_B/recommendations",
            "POST",
            {},
            recKey,
          );
          await db.query(
            "UPDATE employees SET manager_id=NULL WHERE employee_id='TEST_B'",
          );
          await assert.rejects(
            request(
              manager,
              "/api/v1/employees/TEST_B/recommendations",
              "POST",
              {},
              recKey,
            ),
            (e: unknown) => e instanceof HttpError && e.status === 404,
          );
          await db.query(
            "UPDATE employees SET manager_id='TEST_MANAGER' WHERE employee_id='TEST_B'",
          );
          const rec = await request(
            third,
            "/api/v1/employees/TEST_C/recommendations",
            "POST",
            {},
          );
          const feedbackKey = randomUUID(),
            feedback = {
              eventId: rec.data.recommendations[0].eventId,
              helpful: true,
            };
          await request(
            third,
            `/api/v1/recommendations/${rec.data.runId}/feedback`,
            "POST",
            feedback,
            feedbackKey,
          );
          await assert.rejects(
            request(
              changedIdentity,
              `/api/v1/recommendations/${rec.data.runId}/feedback`,
              "POST",
              feedback,
              feedbackKey,
            ),
            (e: unknown) => e instanceof HttpError && e.status === 404,
          );
          const registrationKey = randomUUID(),
            registration = { employeeId: "TEST_C", eventId: "TEST_SELF" };
          await request(
            third,
            "/api/v1/participations",
            "POST",
            registration,
            registrationKey,
          );
          await assert.rejects(
            request(
              changedIdentity,
              "/api/v1/participations",
              "POST",
              registration,
              registrationKey,
            ),
            (e: unknown) => e instanceof HttpError && e.status === 404,
          );
        },
      );
      await t.test(
        "Lead without goal has explicit empty state and no fabricated next grade",
        async () => {
          await db.query(
            "UPDATE employees SET grade='Lead' WHERE employee_id='TEST_C'",
          );
          await db.query(
            "UPDATE career_goals SET status='archived' WHERE employee_id='TEST_C'",
          );
          const rec = await computeRecommendations(db, "TEST_C");
          assert.equal(rec.profile.goal, null);
          assert.deepEqual(rec.candidates, []);
        },
      );
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
