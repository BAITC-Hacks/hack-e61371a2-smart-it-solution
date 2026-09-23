import { z } from "zod";
import { appRoles, hashPassword } from "./auth.js";
import {
  audit,
  HttpError,
  idempotent,
  requireRole,
  type RouteContext,
} from "./http.js";

export async function handleAdministration(
  ctx: RouteContext,
): Promise<boolean> {
  const { path, method, pool, user } = ctx;
  const translation = path.match(
    /^\/api\/v1\/events\/([^/]+)\/translations(?:\/(ru|kk|en))?$/,
  );
  if (translation) {
    if (method === "GET") {
      ctx.send(
        (
          await pool.query(
            'SELECT locale,title,description,approved_at AS "approvedAt" FROM event_translations WHERE event_id=$1 AND approved_at IS NOT NULL ORDER BY locale',
            [translation[1]],
          )
        ).rows,
      );
      return true;
    }
    if (method === "PUT" && translation[2]) {
      requireRole(user, "hr", "admin");
      const p = z
        .object({
          title: z.string().min(1).max(300),
          description: z.string().min(1).max(10000),
        })
        .strict()
        .parse(await ctx.body());
      ctx.send(
        await idempotent(ctx, path, p, async (c) => {
          if (
            !(
              await c.query("SELECT 1 FROM events WHERE event_id=$1", [
                translation[1],
              ])
            ).rowCount
          )
            throw new HttpError(404, "NOT_FOUND", "Мероприятие не найдено");
          await c.query(
            "INSERT INTO event_translations(event_id,locale,title,description,approved_by,approved_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(event_id,locale) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,approved_by=EXCLUDED.approved_by,approved_at=now()",
            [translation[1], translation[2], p.title, p.description, user.id],
          );
          await audit(
            c,
            user,
            "translation.approve",
            "events",
            translation[1]!,
            { locale: translation[2] },
            ctx.requestId,
          );
          return { saved: true, locale: translation[2] };
        }),
      );
      return true;
    }
  }
  if (path === "/api/v1/auth/sessions" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT id,expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM sessions WHERE user_id=$1 ORDER BY expires_at DESC LIMIT 100',
          [user.id],
        )
      ).rows,
    );
    return true;
  }
  const session = path.match(/^\/api\/v1\/auth\/sessions\/([^/]+)$/);
  if (session && method === "DELETE") {
    const r = await pool.query(
      "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id",
      [z.uuid().parse(session[1]), user.id],
    );
    if (!r.rowCount) throw new HttpError(404, "NOT_FOUND", "Сессия не найдена");
    ctx.send({ revoked: true });
    return true;
  }
  if (
    !/^\/api\/v1\/admin\/(accounts(?:\/[^/]+)?|audit|oidc-identities)$/.test(
      path,
    )
  )
    return false;
  requireRole(user, "admin");
  if (path === "/api/v1/admin/accounts" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT id,login,display_name AS "displayName",app_role AS role,employee_id AS "employeeId",active,demo_only AS demo FROM user_accounts ORDER BY login',
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/admin/accounts" && method === "POST") {
    const p = z
      .object({
        login: z.string().min(3).max(120),
        displayName: z.string().min(1).max(200),
        role: z.enum(appRoles),
        employeeId: z.string().min(1).max(120).nullable(),
        password: z.string().min(12).max(256),
      })
      .strict()
      .parse(await ctx.body());
    if (["employee", "manager"].includes(p.role) && !p.employeeId)
      throw new HttpError(422, "EMPLOYEE_REQUIRED", "Нужен профиль сотрудника");
    const passwordHash = await hashPassword(p.password);
    ctx.send(
      await idempotent(ctx, path, p, async (c) => {
        if (
          p.employeeId &&
          !(
            await c.query("SELECT 1 FROM employees WHERE employee_id=$1", [
              p.employeeId,
            ])
          ).rowCount
        )
          throw new HttpError(
            422,
            "EMPLOYEE_NOT_FOUND",
            "Нет профиля сотрудника",
          );
        if (
          (
            await c.query("SELECT 1 FROM user_accounts WHERE login=$1", [
              p.login,
            ])
          ).rowCount
        )
          throw new HttpError(409, "LOGIN_EXISTS", "Логин уже существует");
        const row = (
          await c.query(
            "INSERT INTO user_accounts(login,display_name,app_role,employee_id,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [p.login, p.displayName, p.role, p.employeeId, passwordHash],
          )
        ).rows[0];
        await audit(
          c,
          user,
          "account.create",
          "user_accounts",
          row.id,
          { login: p.login, role: p.role, employeeId: p.employeeId },
          ctx.requestId,
        );
        return row;
      }),
      201,
    );
    return true;
  }
  const account = path.match(/^\/api\/v1\/admin\/accounts\/([^/]+)$/);
  if (account && method === "PATCH") {
    const id = z.uuid().parse(account[1]);
    const p = z
      .object({
        active: z.boolean().optional(),
        role: z.enum(appRoles).optional(),
        employeeId: z.string().min(1).max(120).nullable().optional(),
        password: z.string().min(12).max(256).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0)
      .parse(await ctx.body());
    ctx.send(
      await idempotent(ctx, path, p, async (c) => {
        await c.query(
          "SELECT id FROM user_accounts WHERE app_role='admin' AND active ORDER BY id FOR UPDATE",
        );
        const row = (
          await c.query("SELECT * FROM user_accounts WHERE id=$1 FOR UPDATE", [
            id,
          ])
        ).rows[0];
        if (!row) throw new HttpError(404, "NOT_FOUND", "Аккаунт не найден");
        const active = p.active ?? row.active,
          role = p.role ?? row.app_role,
          employeeId =
            p.employeeId === undefined ? row.employee_id : p.employeeId;
        if (
          row.app_role === "admin" &&
          row.active &&
          (!active || role !== "admin") &&
          Number(
            (
              await c.query(
                "SELECT count(*) AS n FROM user_accounts WHERE app_role='admin' AND active",
              )
            ).rows[0].n,
          ) <= 1
        )
          throw new HttpError(
            409,
            "LAST_ADMIN",
            "Нельзя отключить последнего администратора",
          );
        if (["employee", "manager"].includes(role) && !employeeId)
          throw new HttpError(
            422,
            "EMPLOYEE_REQUIRED",
            "Нужен профиль сотрудника",
          );
        if (
          employeeId &&
          !(
            await c.query("SELECT 1 FROM employees WHERE employee_id=$1", [
              employeeId,
            ])
          ).rowCount
        )
          throw new HttpError(
            422,
            "EMPLOYEE_NOT_FOUND",
            "Нет профиля сотрудника",
          );
        const hash = p.password
          ? await hashPassword(p.password)
          : row.password_hash;
        await c.query(
          "UPDATE user_accounts SET active=$1,app_role=$2,employee_id=$3,password_hash=$4 WHERE id=$5",
          [active, role, employeeId, hash, id],
        );
        await c.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
          id,
        ]);
        await audit(
          c,
          user,
          "account.update",
          "user_accounts",
          id,
          { active, role, employeeId, passwordChanged: Boolean(p.password) },
          ctx.requestId,
        );
        return { id, active, role, employeeId, sessionsRevoked: true };
      }),
    );
    return true;
  }
  if (path === "/api/v1/admin/audit" && method === "GET") {
    const p = z
      .object({
        page: z.coerce.number().int().positive().default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        action: z.string().max(100).optional(),
      })
      .parse(Object.fromEntries(ctx.url.searchParams));
    const total = (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_log WHERE ($1::text IS NULL OR action=$1)",
        [p.action ?? null],
      )
    ).rows[0].n;
    ctx.send(
      (
        await pool.query(
          'SELECT id,actor,action,entity,entity_id AS "entityId",details,request_id AS "requestId",created_at AS "createdAt" FROM audit_log WHERE ($1::text IS NULL OR action=$1) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
          [p.action ?? null, p.limit, (p.page - 1) * p.limit],
        )
      ).rows,
      200,
      { total, page: p.page, limit: p.limit },
    );
    return true;
  }
  if (path === "/api/v1/admin/oidc-identities" && method === "PUT") {
    const p = z
      .object({
        issuer: z.url().refine((x) => x.startsWith("https://")),
        subject: z.string().min(1).max(300),
        userId: z.uuid(),
      })
      .strict()
      .parse(await ctx.body());
    ctx.send(
      await idempotent(ctx, path, p, async (c) => {
        if (
          !(
            await c.query(
              "SELECT 1 FROM user_accounts WHERE id=$1 AND NOT demo_only",
              [p.userId],
            )
          ).rowCount
        )
          throw new HttpError(422, "ACCOUNT_REQUIRED", "Нужен обычный аккаунт");
        const existing = (
          await c.query(
            "SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject=$2",
            [p.issuer, p.subject],
          )
        ).rows[0];
        if (existing && existing.user_id !== p.userId)
          throw new HttpError(
            409,
            "IDENTITY_CONFLICT",
            "Внешняя личность уже связана с другим аккаунтом",
          );
        const linked = (
          await c.query(
            "INSERT INTO oidc_identities VALUES($1,$2,$3) ON CONFLICT(issuer,subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING user_id",
            [p.issuer, p.subject, p.userId],
          )
        ).rows[0];
        if (linked.user_id !== p.userId)
          throw new HttpError(
            409,
            "IDENTITY_CONFLICT",
            "Внешняя личность уже связана с другим аккаунтом",
          );
        await audit(
          c,
          user,
          "oidc.link",
          "user_accounts",
          p.userId,
          { issuer: p.issuer },
          ctx.requestId,
        );
        return { linked: true };
      }),
    );
    return true;
  }
  return false;
}
