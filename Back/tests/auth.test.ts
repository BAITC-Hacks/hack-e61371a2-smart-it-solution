import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, scope, type User } from "../src/auth.js";
import { parseBundle, ImportError } from "../src/imports.js";
test("password hashes are salted and verify without storing plaintext", async () => {
  const a = await hashPassword("a long test password");
  const b = await hashPassword("a long test password");
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("a long test password", a));
  assert.equal(await verifyPassword("wrong", a), false);
});
test("employee scope is parameterized and manager scope includes only direct reports", () => {
  const user: User = {
    id: "1",
    login: "test",
    displayName: "Test",
    role: "employee",
    employeeId: "E0001",
    demo: true,
  };
  assert.deepEqual(scope(user), { sql: "e.employee_id=$1", values: ["E0001"] });
  assert.match(scope({ ...user, role: "manager" }).sql, /manager_id=\$1/);
});
test("import rejects missing numeric fields and out-of-range history", () => {
  assert.throws(
    () =>
      parseBundle({
        historyCsv:
          "record_id,employee_id,event_id,date,due_date,status,completion_pct,score,feedback_rating,assigned_by\nR,E,V,2026-01-01,,completed,,,5,self",
      }),
    ImportError,
  );
  assert.throws(
    () => parseBundle({ employees: { meta: {}, employees: [] } }),
    ImportError,
  );
});
