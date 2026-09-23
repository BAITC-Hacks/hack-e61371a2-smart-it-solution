import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { User } from "../src/auth.js";
import { additionalCareerFacts } from "../src/assistant-context.js";
import { createPool, migrate } from "../src/db.js";
import { readBundle, importBundle } from "../src/imports.js";
import { eligibility, loadCareer, loadEvents } from "../src/career.js";

const account = (employeeId: string | null): User => ({
  id: randomUUID(), login: "assistant-context-test", displayName: "Test",
  role: "admin", employeeId, demo: true,
});

test("assistant career context never queries personal data without a linked employee", async () => {
  const pool = { query: () => { throw new Error("Unexpected access"); } } as unknown as Pool;
  assert.deepEqual(await additionalCareerFacts(pool, account(null), "ru"), []);
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test("assistant context uses own plans/history and only eligible recommendations", { skip: !databaseUrl }, async () => {
  const schema = `assistant_context_${randomUUID().replaceAll("-", "")}`;
  const admin = createPool(databaseUrl!);
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = createPool(url.toString());
    await migrate(pool);
    await importBundle(pool, await readBundle("./data"), { commit: true });
    const employees = (await pool.query("SELECT employee_id,role,grade FROM employees ORDER BY employee_id LIMIT 2")).rows;
    const planIds: string[] = [];
    for (const employee of employees) {
      const plan = await pool.query(`INSERT INTO development_plans(employee_id,target_role,target_grade,horizon_days,start_date,weekly_hours,formats,baseline_levels,projected_levels,unmet_requirements,total_hours)
        VALUES($1,$2,$3,30,'2026-10-01',4,ARRAY['online'],'{}','{}','[]',0) RETURNING id`,
        [employee.employee_id, employee.role, employee.grade]);
      planIds.push(plan.rows[0].id);
    }
    const employeeId = employees[0]!.employee_id;
    const profile = await loadCareer(pool, employeeId);
    const events = await loadEvents(pool);
    for (const locale of ["ru", "kk", "en"] as const) {
      const facts = await additionalCareerFacts(pool, account(employeeId), locale);
      assert.ok(facts.some((fact) => fact.id === `plan:${planIds[0]}`));
      assert.ok(!facts.some((fact) => fact.id === `plan:${planIds[1]}`));
      assert.ok(facts.length <= 10);
      assert.ok(facts.every((fact) => fact.text.length <= 400));
      for (const fact of facts) {
        if (/^(event|recommendation):/.test(fact.id)) {
          const event = events.find((item) => item.eventId === fact.id.split(":")[1]);
          assert.ok(event);
          assert.equal(eligibility(event, profile).eligible, true);
        }
        if (fact.id.startsWith("participation:")) {
          assert.ok(profile.history.some((item) => fact.id === `participation:${item.id}`));
        }
      }
    }
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
