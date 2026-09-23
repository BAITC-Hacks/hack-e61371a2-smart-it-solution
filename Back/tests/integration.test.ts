import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { createPool, migrate } from "../src/db.js";
import {
  readBundle,
  importBundle,
  type Bundle,
  ImportError,
} from "../src/imports.js";
import { seedDemoAccounts, hashPassword } from "../src/auth.js";
import { createApp } from "../src/server.js";
import type { Config } from "../src/config.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("PostgreSQL integration", { skip: !databaseUrl }, async (t) => {
  const schema = `cq_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool(databaseUrl!);
  let pool: Pool | undefined;
  let server: Server | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool(url.toString());
    await migrate(pool);
    await migrate(pool);
    const fixture = await readBundle("./data");
    await t.test(
      "full import preserves every record and manager link",
      async () => {
        const result = await importBundle(pool!, fixture, { commit: true });
        assert.equal(result.committed, true);
        assert.deepEqual(result.counts, {
          skills: 60,
          roleProfiles: 32,
          employees: 200,
          events: 40,
          history: 2743,
        });
        assert.equal(
          (await pool!.query("SELECT count(*)::int AS n FROM participations"))
            .rows[0].n,
          2743,
        );
      },
    );
    await t.test(
      "duplicate and concurrent imports do not add records",
      async () => {
        const results = await Promise.all([
          importBundle(pool!, fixture, { commit: true }),
          importBundle(pool!, fixture, { commit: true }),
        ]);
        assert.ok(results.every((x) => x.duplicate && !x.committed));
        assert.equal(
          (await pool!.query("SELECT count(*)::int AS n FROM dataset_batches"))
            .rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "preview is read-only and invalid reference rolls back the entire package",
      async () => {
        const newEmployee = structuredClone(fixture.employees!.employees[0]!);
        newEmployee.employee_id = "JURY_001";
        const extra: Bundle = {
          employees: {
            meta: fixture.employees!.meta,
            employees: [newEmployee],
          },
        };
        assert.equal(
          (await importBundle(pool!, extra, { commit: false })).committed,
          false,
        );
        assert.equal(
          (
            await pool!.query(
              "SELECT count(*)::int AS n FROM employees WHERE employee_id='JURY_001'",
            )
          ).rows[0].n,
          0,
        );
        extra.employees!.employees.push({
          ...newEmployee,
          employee_id: "JURY_BAD",
          manager_id: "MISSING",
        });
        await assert.rejects(
          importBundle(pool!, extra, { commit: true }),
          ImportError,
        );
        assert.equal(
          (
            await pool!.query(
              "SELECT count(*)::int AS n FROM employees WHERE employee_id LIKE 'JURY%'",
            )
          ).rows[0].n,
          0,
        );
        extra.employees!.employees.pop();
        assert.equal(
          (await importBundle(pool!, extra, { commit: true })).committed,
          true,
        );
      },
    );
    await t.test("conflicting history ID is rejected atomically", async () => {
      const record = {
        ...fixture.history![0]!,
        completion_pct: 99,
        status: "in_progress" as const,
      };
      await assert.rejects(
        importBundle(pool!, { history: [record] }, { commit: true }),
        ImportError,
      );
    });
    await t.test(
      "preview reports changes and catalog import preserves referenced session identity/capacity",
      async () => {
        const unchanged = await importBundle(pool!, fixture, { commit: false });
        assert.equal(unchanged.changes.events?.unchanged, 40);
        assert.equal(unchanged.changes.employees?.unchanged, 200);
        const event = structuredClone(
          fixture.events!.events.find((e) => e.upcoming_sessions.length > 0)!,
        );
        const session = (
          await pool!.query(
            "SELECT id FROM event_sessions WHERE event_id=$1 ORDER BY session_date LIMIT 1",
            [event.event_id],
          )
        ).rows[0];
        await pool!.query("UPDATE event_sessions SET capacity=7 WHERE id=$1", [
          session.id,
        ]);
        const participation = (
          await pool!.query(
            "INSERT INTO participations(employee_id,event_id,date,status,completion_pct,assigned_by,session_id) VALUES($1,$2,$3,'declined',0,'self',$4) RETURNING id",
            [
              fixture.employees!.employees[0]!.employee_id,
              event.event_id,
              fixture.events!.meta.as_of_date,
              session.id,
            ],
          )
        ).rows[0];
        event.title += " updated";
        const patch: Bundle = {
          events: { meta: fixture.events!.meta, events: [event] },
        };
        assert.equal(
          (await importBundle(pool!, patch, { commit: false })).changes.events
            ?.updated,
          1,
        );
        await importBundle(pool!, patch, { commit: true });
        assert.equal(
          (
            await pool!.query(
              "SELECT capacity FROM event_sessions WHERE id=$1",
              [session.id],
            )
          ).rows[0].capacity,
          7,
        );
        event.upcoming_sessions = [];
        await assert.rejects(
          importBundle(pool!, patch, { commit: true }),
          ImportError,
        );
        await pool!.query("DELETE FROM participations WHERE id=$1", [
          participation.id,
        ]);
        const future = {
          ...fixture.history![0]!,
          record_id: "FUTURE_INVALID",
          date: "2027-01-01",
        };
        await assert.rejects(
          importBundle(pool!, { history: [future] }, { commit: true }),
          ImportError,
        );
      },
    );
    await seedDemoAccounts(pool);
    const config: Config = {
      databaseUrl: databaseUrl!,
      port: 0,
      origin: "http://localhost:5173",
      demo: true,
      secure: false,
      datasetPath: "./data",
    };
    server = createApp(pool, config);
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const request = async (
      path: string,
      options: {
        method?: string;
        body?: unknown;
        cookie?: string;
        csrf?: string;
        origin?: string;
      } = {},
    ) => {
      const response = await fetch(base + path, {
        method: options.method ?? "GET",
        headers: {
          Origin: options.origin ?? config.origin,
          "Content-Type": "application/json",
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(options.csrf ? { "X-CSRF-Token": options.csrf } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      return {
        status: response.status,
        json: await response.json(),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
        setCookie: response.headers.get("set-cookie"),
      };
    };
    const login = async (role: string) => {
      const r = await request("/auth/login", {
        method: "POST",
        body: { login: `demo.${role}`, demo: true },
      });
      assert.equal(r.status, 200);
      return {
        cookie: r.cookie!,
        csrf: r.json.data.csrfToken as string,
        user: r.json.data.user,
      };
    };
    await t.test(
      "unauthenticated and cross-origin requests are rejected",
      async () => {
        assert.equal((await request("/workspace")).status, 401);
        assert.equal(
          (
            await request("/auth/login", {
              method: "POST",
              origin: "https://outside.invalid",
              body: { login: "demo.admin", demo: true },
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "employee cannot read another profile, expand list scope or import",
      async () => {
        const s = await login("employee");
        const list = await request("/employees?limit=50", s);
        assert.equal(list.json.meta.total, 1);
        assert.equal(list.json.data[0].id, s.user.employeeId);
        assert.equal((await request("/employees/E0002", s)).status, 404);
        assert.equal((await request("/imports", s)).status, 403);
        assert.equal(
          (
            await request("/imports/commit", {
              ...s,
              method: "POST",
              body: fixture,
            })
          ).status,
          403,
        );
        assert.equal(
          (await request("/workspace", s)).json.data.counts.employees,
          1,
        );
      },
    );
    await t.test(
      "manager sees self and direct reports only, HR sees organization",
      async () => {
        const s = await login("manager");
        const list = await request("/employees?limit=50", s);
        const expected = (
          await pool!.query(
            "SELECT employee_id FROM employees WHERE employee_id=$1 OR manager_id=$1",
            [s.user.employeeId],
          )
        ).rows
          .map((x) => x.employee_id)
          .sort();
        assert.deepEqual(
          list.json.data.map((x: { id: string }) => x.id).sort(),
          expected,
        );
        const outside = (
          await pool!.query(
            "SELECT employee_id FROM employees WHERE employee_id<>$1 AND manager_id IS DISTINCT FROM $1 LIMIT 1",
            [s.user.employeeId],
          )
        ).rows[0].employee_id;
        assert.equal((await request("/employees/" + outside, s)).status, 404);
        const hr = await login("hr");
        assert.equal((await request("/employees", hr)).json.meta.total, 201);
        assert.equal((await request("/imports", hr)).status, 403);
      },
    );
    await t.test(
      "admin import requires CSRF; valid import is audited",
      async () => {
        const s = await login("admin");
        assert.equal(
          (
            await request("/imports/preview", {
              cookie: s.cookie,
              method: "POST",
              body: fixture,
            })
          ).status,
          403,
        );
        const record = structuredClone(fixture.employees!.employees[0]!);
        record.employee_id = "JURY_002";
        const body = {
          employees: { meta: fixture.employees!.meta, employees: [record] },
        };
        assert.equal(
          (await request("/imports/preview", { ...s, method: "POST", body }))
            .json.data.committed,
          false,
        );
        assert.equal(
          (await request("/imports/commit", { ...s, method: "POST", body }))
            .json.data.committed,
          true,
        );
        assert.equal(
          (
            await pool!.query(
              "SELECT count(*)::int AS n FROM audit_log WHERE action='dataset.import' AND actor=$1",
              [s.user.id],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      "logout, expiry and disabled accounts invalidate sessions",
      async () => {
        const s = await login("employee");
        assert.equal(
          (await request("/auth/logout", { ...s, method: "POST" })).status,
          200,
        );
        assert.equal((await request("/auth/me", s)).status, 401);
        const expired = await login("employee");
        await pool!.query(
          "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
          [expired.user.id],
        );
        assert.equal((await request("/auth/me", expired)).status, 401);
        const disabled = await login("employee");
        await pool!.query("UPDATE user_accounts SET active=false WHERE id=$1", [
          disabled.user.id,
        ]);
        assert.equal((await request("/auth/me", disabled)).status, 401);
      },
    );
    await t.test(
      "normal password login works and tokens are stored hashed",
      async () => {
        await pool!.query(
          "INSERT INTO user_accounts(login,display_name,app_role,password_hash) VALUES('test.admin','Test','admin',$1)",
          [await hashPassword("long-test-password")],
        );
        const wrong = await request("/auth/login", {
          method: "POST",
          body: { login: "test.admin", password: "wrong" },
        });
        assert.equal(wrong.status, 401);
        const ok = await request("/auth/login", {
          method: "POST",
          body: { login: "test.admin", password: "long-test-password" },
        });
        assert.equal(ok.status, 200);
        assert.match(ok.setCookie!, /HttpOnly/);
        assert.match(ok.setCookie!, /SameSite=Lax/);
        assert.equal(
          (
            await pool!.query(
              "SELECT count(*)::int AS n FROM sessions WHERE token_hash=$1",
              [ok.cookie!.split("=")[1]],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      "DEMO_MODE=false blocks discovery, demo login and existing demo sessions",
      async () => {
        const s = await login("hr");
        config.demo = false;
        assert.deepEqual((await request("/auth/demo-accounts")).json.data, {
          enabled: false,
          accounts: [],
        });
        assert.equal(
          (
            await request("/auth/login", {
              method: "POST",
              body: { login: "demo.hr", demo: true },
            })
          ).status,
          401,
        );
        assert.equal((await request("/auth/me", s)).status, 401);
      },
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
