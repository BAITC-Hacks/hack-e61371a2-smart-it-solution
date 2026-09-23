import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Pool } from "pg";
export const appRoles = ["employee", "manager", "hr", "admin"] as const;
export type AppRole = (typeof appRoles)[number];
export type User = {
  id: string;
  login: string;
  displayName: string;
  role: AppRole;
  employeeId: string | null;
  demo: boolean;
};
const derive = promisify(scrypt);
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [algorithm, salt, key] = hash.split(":");
  if (algorithm !== "scrypt" || !salt || !key || key.length !== 128)
    return false;
  const actual = (await derive(password, salt, 64)) as Buffer;
  return timingSafeEqual(Buffer.from(key, "hex"), actual);
}
export const userColumns =
  'u.id,u.login,u.display_name AS "displayName",u.app_role AS role,u.employee_id AS "employeeId",u.demo_only AS demo';
export async function seedDemoAccounts(pool: Pool) {
  const first = (
    await pool.query(
      "SELECT employee_id,manager_id,full_name FROM employees WHERE manager_id IS NOT NULL ORDER BY employee_id LIMIT 1",
    )
  ).rows[0];
  if (!first) throw new Error("Import employees before creating demo accounts");
  const manager = (
    await pool.query(
      "SELECT employee_id,full_name FROM employees WHERE employee_id=$1",
      [first.manager_id],
    )
  ).rows[0];
  for (const a of [
    ["employee", first.employee_id, first.full_name],
    ["manager", manager.employee_id, manager.full_name],
    ["hr", null, "HR · Smart IT Solution"],
    ["admin", null, "Администратор · Smart IT Solution"],
  ])
    await pool.query(
      "INSERT INTO user_accounts(login,app_role,employee_id,display_name,demo_only) VALUES($1,$2,$3,$4,true) ON CONFLICT(login) DO NOTHING",
      [`demo.${a[0]}`, a[0], a[1], a[2]],
    );
}
export function scope(
  user: User,
  alias = "e",
): { sql: string; values: unknown[] } {
  if (user.role === "hr" || user.role === "admin")
    return { sql: "TRUE", values: [] };
  if (user.role === "manager")
    return {
      sql: `(${alias}.employee_id=$1 OR ${alias}.manager_id=$1)`,
      values: [user.employeeId],
    };
  return { sql: `${alias}.employee_id=$1`, values: [user.employeeId] };
}
