import type { IncomingMessage } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { Config } from "./config.js";
import { scope, type User } from "./auth.js";
import { createHash } from "node:crypto";
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export type RouteContext = {
  pool: Pool;
  config: Config;
  user: User;
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  requestId: string;
  body: (limit?: number) => Promise<unknown>;
  send: (data: unknown, status?: number, meta?: unknown) => void;
};
export type Queryable = Pick<PoolClient, "query">;
export function requireRole(user: User, ...roles: User["role"][]) {
  if (!roles.includes(user.role))
    throw new HttpError(403, "FORBIDDEN", "Недостаточно прав");
}
export async function requireEmployeeAccess(
  db: Queryable,
  user: User,
  id: string,
  write = false,
) {
  const s = scope(user);
  const row = (
    await db.query(
      `SELECT e.* FROM employees e WHERE ${s.sql} AND e.employee_id=$${s.values.length + 1}`,
      [...s.values, id],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(404, "NOT_FOUND", "Профиль не найден или недоступен");
  if (write && user.employeeId !== id && !["hr", "admin"].includes(user.role))
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Изменение чужого профиля недоступно",
    );
  return row;
}
export async function transaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function snapshotDate(db: Queryable): Promise<string> {
  const row = (
    await db.query(
      "SELECT as_of_date::text AS date FROM dataset_batches ORDER BY imported_at DESC LIMIT 1",
    )
  ).rows[0];
  if (!row)
    throw new HttpError(409, "DATASET_REQUIRED", "Сначала импортируйте данные");
  return row.date;
}
export async function audit(
  db: Queryable,
  user: User,
  action: string,
  entity: string,
  id: string,
  details: unknown,
  requestId: string,
) {
  await db.query(
    "INSERT INTO audit_log(actor,action,entity,entity_id,details,request_id) VALUES($1,$2,$3,$4,$5,$6)",
    [user.id, action, entity, id, details, requestId],
  );
}
export function idempotencyPayloadHash(user: User, payload: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify({ role: user.role, employeeId: user.employeeId, payload }),
    )
    .digest("hex");
}
export async function idempotent<T>(
  ctx: RouteContext,
  operation: string,
  payload: unknown,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const key = ctx.req.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8 || key.length > 160)
    throw new HttpError(
      400,
      "IDEMPOTENCY_REQUIRED",
      "Нужен Idempotency-Key длиной 8–160 символов",
    );
  const hash = idempotencyPayloadHash(ctx.user, payload);
  return transaction(ctx.pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${ctx.user.id}:${operation}:${key}`,
    ]);
    const previous = (
      await c.query(
        "SELECT payload_hash,response FROM idempotency_records WHERE user_id=$1 AND operation=$2 AND key=$3",
        [ctx.user.id, operation, key],
      )
    ).rows[0];
    if (previous) {
      if (previous.payload_hash !== hash)
        throw new HttpError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Ключ уже использован для другого запроса",
        );
      return previous.response as T;
    }
    const value = await fn(c);
    await c.query(
      "INSERT INTO idempotency_records(user_id,operation,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)",
      [ctx.user.id, operation, key, hash, JSON.stringify(value)],
    );
    return value;
  });
}
