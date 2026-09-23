import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { createPool, migrate } from "../src/db.js";
import { importBundle, readBundle } from "../src/imports.js";
import { seedDemoAccounts } from "../src/auth.js";
import { seedGuideDemo } from "../src/guide.js";
import { createApp } from "../src/server.js";

type Session = {
  cookie: string;
  csrf: string;
  user: { id: string; role: string; employeeId: string | null };
};
test(
  "full backend HTTP routes, sessions, role boundaries and persisted response privacy",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admin = createPool(process.env.TEST_DATABASE_URL!);
    const schema = `http_test_${randomUUID().replaceAll("-", "")}`;
    let pool: Pool | undefined, server: Server | undefined;
    const saved = {
      AI_ENABLED: process.env.AI_ENABLED,
      INTEGRATION_TARGETS_JSON: process.env.INTEGRATION_TARGETS_JSON,
    };
    process.env.AI_ENABLED = "false";
    process.env.INTEGRATION_TARGETS_JSON = "{}";
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const dburl = new URL(process.env.TEST_DATABASE_URL!);
      dburl.searchParams.set("options", `-c search_path=${schema}`);
      pool = createPool(dburl.toString());
      await migrate(pool);
      await importBundle(pool, await readBundle("./data"), { commit: true });
      await seedDemoAccounts(pool);
      await seedGuideDemo(pool);
      const peer = (
        await pool.query(
          `SELECT employee_id FROM employees WHERE employee_id NOT IN (SELECT employee_id FROM user_accounts WHERE employee_id IS NOT NULL) ORDER BY employee_id LIMIT 1`,
        )
      ).rows[0].employee_id;
      await pool.query(
        `INSERT INTO user_accounts(employee_id,app_role,login,display_name,demo_only) VALUES($1,'employee','demo.peer','HTTP peer fixture',true)`,
        [peer],
      );
      const origin = "http://localhost:5173";
      server = createApp(pool, {
        databaseUrl: dburl.toString(),
        port: 0,
        origin,
        demo: true,
        secure: false,
        datasetPath: "./data",
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
      const request = async (
        path: string,
        options: {
          session?: Session;
          method?: string;
          body?: unknown;
          key?: string;
          csrf?: string;
          origin?: string;
        } = {},
      ) => {
        const response = await fetch(base + path, {
          method: options.method ?? "GET",
          headers: {
            Origin: options.origin ?? origin,
            "Content-Type": "application/json",
            ...(options.session
              ? {
                  Cookie: options.session.cookie,
                  "X-CSRF-Token": options.csrf ?? options.session.csrf,
                }
              : {}),
            ...(options.key ? { "Idempotency-Key": options.key } : {}),
          },
          body:
            options.body !== undefined
              ? JSON.stringify(options.body)
              : undefined,
        });
        return {
          status: response.status,
          json: (await response.json()) as any,
          cookie: response.headers.get("set-cookie")?.split(";")[0],
          headers: response.headers,
        };
      };
      const login = async (role: string): Promise<Session> => {
        const result = await request("/auth/login", {
          method: "POST",
          body: { login: `demo.${role}`, demo: true },
        });
        assert.equal(result.status, 200);
        assert.ok(result.cookie);
        assert.ok(result.headers.get("set-cookie")?.includes("HttpOnly"));
        return {
          cookie: result.cookie!,
          csrf: result.json.data.csrfToken,
          user: result.json.data.user,
        };
      };
      const employee = await login("employee"),
        manager = await login("manager"),
        hr = await login("hr"),
        root = await login("admin"),
        other = await login("peer");
      const get = async (path: string, session: Session, expected = 200) => {
        const result = await request(path, { session });
        assert.equal(
          result.status,
          expected,
          `${path}: ${JSON.stringify(result.json)}`,
        );
        return result.json.data;
      };
      const write = async (
        path: string,
        session: Session,
        body: unknown = {},
        method = "POST",
        expected = 200,
        key: string = randomUUID(),
      ) => {
        const result = await request(path, { session, method, body, key });
        assert.equal(
          result.status,
          expected,
          `${method} ${path}: ${JSON.stringify(result.json)}`,
        );
        return result.json.data;
      };
      await t.test(
        "authentication, Origin and CSRF protect mounted handlers",
        async () => {
          assert.equal((await request("/guide/topics")).status, 401);
          assert.equal((await request("/health/ready")).status, 200);
          const csrf = await request("/me/preferences", {
            session: employee,
            method: "PUT",
            body: { weeklyHours: 3, formats: ["online"] },
            csrf: "invalid",
          });
          assert.equal(csrf.status, 403);
          assert.equal(csrf.json.error.code, "CSRF_REJECTED");
          const cross = await request("/assistant/threads", {
            session: employee,
            method: "POST",
            body: {},
            origin: "https://untrusted.invalid",
          });
          assert.equal(cross.status, 403);
          assert.equal(cross.json.error.code, "ORIGIN_REJECTED");
          assert.equal(
            (await get("/auth/me", employee)).user.employeeId,
            employee.user.employeeId,
          );
        },
      );
      await t.test(
        "career routes work through HTTP and reject other employee profiles",
        async () => {
          const own = await get(
            `/employees/${employee.user.employeeId}`,
            employee,
          );
          assert.equal(own.employeeId ?? own.id, employee.user.employeeId);
          assert.equal(
            (
              await get(
                `/employees/${employee.user.employeeId}/skills`,
                employee,
              )
            ).length,
            60,
          );
          await get(
            `/employees/${other.user.employeeId}/skills`,
            employee,
            404,
          );
          await get(`/employees/${employee.user.employeeId}/skills`, manager);
          await get(`/employees/${other.user.employeeId}/skills`, hr);
          const events = await get("/events?limit=3", employee);
          assert.ok(events.length > 0);
          const recommendation = await write(
            `/employees/${employee.user.employeeId}/recommendations`,
            employee,
            { useAi: false },
            "POST",
          );
          assert.ok(recommendation.recommendations.length <= 3);
          assert.ok(
            ["fallback", "deterministic"].includes(recommendation.source),
          );
        },
      );
      let taskId: string, planId: string;
      await t.test(
        "growth writes persist and owner boundaries survive HTTP routing",
        async () => {
          const preferences = await write(
            "/me/preferences",
            employee,
            { weeklyHours: 3, formats: ["self_paced"] },
            "PUT",
          );
          assert.equal(preferences.weeklyHours, 3);
          const plan = await write(
            "/me/plans",
            employee,
            { horizonDays: 30 },
            "POST",
            201,
          );
          planId = plan.id;
          assert.equal((await get(`/me/plans/${planId}`, employee)).id, planId);
          await get(`/me/plans/${planId}`, other, 404);
          const task = await write(
            "/me/tasks",
            employee,
            { title: "Моя приватная учебная задача" },
            "POST",
            201,
          );
          taskId = task.id;
          assert.equal(
            (await get("/me/tasks", employee)).some(
              (row: any) => row.id === taskId,
            ),
            true,
          );
          assert.equal(
            (await get("/me/tasks", other)).some(
              (row: any) => row.id === taskId,
            ),
            false,
          );
          await write(
            `/me/tasks/${taskId}`,
            other,
            { status: "completed" },
            "PATCH",
            404,
          );
          await get("/me/achievements", hr, 403);
        },
      );
      await t.test(
        "HR growth administration does not get intercepted by admin-only router",
        async () => {
          for (const path of [
            "/admin/mentors",
            "/admin/recognitions",
            "/admin/rewards/catalog",
            "/admin/rewards/redemptions",
          ]) {
            assert.ok(Array.isArray(await get(path, hr)));
            await get(path, employee, 403);
          }
          await get("/admin/accounts", hr, 403);
          const accounts = await get("/admin/accounts", root);
          assert.ok(accounts.length >= 5);
          assert.ok(accounts.every((a: any) => a.password_hash === undefined));
          await get("/admin/ai/usage", hr, 403);
          assert.equal((await get("/admin/ai/usage", root)).enabled, false);
          assert.ok(Array.isArray(await get("/admin/audit?limit=5", root)));
        },
      );
      await t.test(
        "HR and manager analytics preserve different scopes",
        async () => {
          const organization = await get("/hr/overview", hr);
          assert.equal(organization.employees, 200);
          assert.equal(organization.scope, "organization");
          const team = await get("/manager/overview", manager);
          assert.equal(team.scope, "team");
          assert.ok(team.employees < 200);
          assert.ok(team.employees >= 2);
          await get("/hr/overview", manager, 403);
          await get("/manager/overview", employee, 403);
          assert.equal((await get("/hr/roi", hr)).available, false);
          const programs = await get("/hr/programs", hr);
          assert.ok(
            programs.every(
              (p: any) =>
                Number.isFinite(p.observedSkillPoints) &&
                p.observedGapClosure >= 0,
            ),
          );
          await pool!.query(
            "INSERT INTO career_activity_log(employee_id,event_id,stage,date) VALUES($1,'EV_005','offered','2026-09-18'),($1,'EV_005','registered','2026-09-18')",
            [employee.user.employeeId],
          );
          const funnel = await get(
            "/hr/funnel?from=2026-09-18&to=2026-09-18",
            hr,
          );
          assert.equal(
            funnel.stages.find((s: any) => s.stage === "offered").records,
            1,
          );
          assert.equal(
            funnel.stages.find((s: any) => s.stage === "completed").records,
            0,
          );
          const empty = await get(
            "/hr/engagement-signals?department=nonexistent",
            hr,
          );
          assert.deepEqual(empty.signals, []);
          await get("/hr/trends?from=2026-10-01&to=2026-01-01", hr, 400);
        },
      );
      let threadId: string, messageKey: string;
      await t.test(
        "guide and assistant mounted at /api/v1, localized content and owner-only threads",
        async () => {
          assert.equal((await get("/guide/topics", employee)).length, 5);
          for (const locale of ["ru", "kk", "en"])
            assert.equal(
              (await get(`/guide/articles?locale=${locale}`, employee)).length,
              5,
            );
          const thread = await write(
            "/assistant/threads",
            employee,
            { title: "HTTP диалог", locale: "ru" },
            "POST",
            201,
          );
          threadId = thread.id;
          messageKey = randomUUID();
          const answer = await write(
            `/assistant/threads/${threadId}/messages`,
            employee,
            { content: "сломался ноутбук" },
            "POST",
            201,
            messageKey,
          );
          assert.equal(answer.source, "fallback");
          assert.equal(answer.citations.length, 1);
          assert.equal(answer.citations[0].synthetic, true);
          const replay = await write(
            `/assistant/threads/${threadId}/messages`,
            employee,
            { content: "сломался ноутбук" },
            "POST",
            200,
            messageKey,
          );
          assert.equal(replay.id, answer.id);
          for (const account of [other, hr, root]) {
            await get(`/assistant/threads/${threadId}`, account, 404);
            await write(
              `/assistant/threads/${threadId}/messages`,
              account,
              { content: "Мои навыки" },
              "POST",
              404,
            );
          }
        },
      );
      await t.test(
        "archiving a source hides saved text on thread reads and idempotent replay",
        async () => {
          const thread = await get(`/assistant/threads/${threadId}`, employee);
          const answer = thread.messages.find(
            (m: any) => m.role === "assistant",
          );
          const source = answer.response.citations[0].id;
          await write(`/guide/articles/${source}/archive`, hr);
          const hidden = await get(`/assistant/threads/${threadId}`, employee);
          assert.equal(
            hidden.messages.find((m: any) => m.role === "assistant").response
              .fallbackReason,
            "SOURCE_ACCESS_CHANGED",
          );
          assert.equal(
            hidden.messages.find((m: any) => m.role === "assistant").response
              .citations.length,
            0,
          );
          assert.equal(
            hidden.messages.find((m: any) => m.role === "user").response
              .citations.length,
            0,
          );
          const replay = await write(
            `/assistant/threads/${threadId}/messages`,
            employee,
            { content: "сломался ноутбук" },
            "POST",
            200,
            messageKey,
          );
          assert.equal(replay.fallbackReason, "SOURCE_ACCESS_CHANGED");
        },
      );
      await t.test(
        "thread context prevents access after same account role/profile changes",
        async () => {
          await pool!.query(
            `UPDATE user_accounts SET app_role='manager' WHERE id=$1`,
            [employee.user.id],
          );
          await get(`/assistant/threads/${threadId}`, employee, 404);
          assert.equal(
            (await get("/assistant/threads", employee)).some(
              (x: any) => x.id === threadId,
            ),
            false,
          );
          await pool!.query(
            `UPDATE user_accounts SET app_role='employee',employee_id=$2 WHERE id=$1`,
            [employee.user.id, other.user.employeeId],
          );
          await write(
            `/assistant/threads/${threadId}/messages`,
            employee,
            { content: "сломался ноутбук" },
            "POST",
            404,
            messageKey,
          );
          await pool!.query(
            `UPDATE user_accounts SET employee_id=$2 WHERE id=$1`,
            [employee.user.id, employee.user.employeeId],
          );
        },
      );
      await t.test(
        "calendar, notifications and disabled integration routes are truthful and protected",
        async () => {
          assert.match(
            (await get("/calendar", employee)).content,
            /BEGIN:VCALENDAR/,
          );
          assert.ok(Array.isArray(await get("/notifications", employee)));
          assert.ok(Array.isArray(await get("/tickets", employee)));
          const integrations = await get("/integrations", root);
          assert.deepEqual(integrations.configuredTargets, []);
          assert.equal(integrations.nvidia, "deferred");
          await get("/integrations", employee, 403);
          await write(
            "/tickets",
            employee,
            {
              providerKey: "missing",
              title: "VPN issue",
              description: "Cannot access the example work system",
            },
            "POST",
            503,
          );
          await write(
            "/integrations/webhooks",
            root,
            {
              name: "Missing connector",
              targetKey: "missing",
              topics: ["goal.changed"],
            },
            "POST",
            422,
          );
          assert.equal(
            (await pool!.query("SELECT count(*)::int AS n FROM ai_usage"))
              .rows[0].n,
            0,
          );
        },
      );
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
