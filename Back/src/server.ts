import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import {
  scope,
  tokenHash,
  userColumns,
  verifyPassword,
  hashPassword,
  type User,
} from "./auth.js";
import { importBundle, ImportError, parseBundle } from "./imports.js";

import { HttpError, type RouteContext } from "./http.js";
import { handleCareer } from "./career.js";
import { handleGuide } from "./guide.js";
import { handleAssistant } from "./ai.js";
import { handleGrowth } from "./growth.js";
import { handleAnalytics } from "./analytics.js";
import { handleIntegrations } from "./integrations.js";
import { handleAdministration } from "./administration.js";
import { handleSso } from "./sso.js";

function cookieToken(req: IncomingMessage) {
  return (
    (req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("cq_session="))
      ?.slice(11) ?? ""
  );
}
async function body(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new HttpError(413, "BODY_TOO_LARGE", "Файл слишком большой");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Некорректный JSON");
  }
}
export function createApp(pool: Pool, config: Config) {
  const attempts = new Map<
    string,
    { count: number; expires: number; inFlight: number }
  >();
  const dummyHash = hashPassword(randomBytes(32).toString("hex"));
  const sessionCookie = (token: string, maxAge = 28800) =>
    `cq_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.secure ? "; Secure" : ""}`;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    const send = (data: unknown, status = 200, meta?: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ data, ...(meta ? { meta } : {}) }));
    };
    try {
      const url = new URL(req.url ?? "/", config.origin);
      const path = url.pathname.replace(/\/$/, "");
      const method = req.method ?? "GET";
      if (
        method !== "GET" &&
        method !== "HEAD" &&
        req.headers.origin !== config.origin
      )
        throw new HttpError(
          403,
          "ORIGIN_REJECTED",
          "Источник запроса не разрешён",
        );
      if (method === "GET" && path === "/api/v1/health/live") {
        send({ status: "ok" });
        return;
      }
      if (method === "GET" && path === "/api/v1/health/ready") {
        try {
          await pool.query("SELECT 1 FROM schema_migrations LIMIT 1");
        } catch {
          throw new HttpError(503, "NOT_READY", "База данных не готова");
        }
        send({ status: "ready" });
        return;
      }
      if (await handleSso(pool, config, req, res, url, send)) return;
      if (method === "GET" && path === "/api/v1/auth/demo-accounts") {
        const data = config.demo
          ? (
              await pool.query(
                `SELECT ${userColumns} FROM user_accounts u WHERE u.demo_only AND u.active ORDER BY CASE u.app_role WHEN 'employee' THEN 1 WHEN 'manager' THEN 2 WHEN 'hr' THEN 3 ELSE 4 END`,
              )
            ).rows
          : [];
        send({ enabled: config.demo, accounts: data });
        return;
      }
      if (method === "POST" && path === "/api/v1/auth/login") {
        const payload = z
          .object({
            login: z.string().min(1).max(120),
            password: z.string().max(256).optional(),
            demo: z.boolean().optional(),
          })
          .strict()
          .parse(await body(req, 65536));
        const now = Date.now();
        for (const [k, v] of attempts) if (v.expires < now) attempts.delete(k);
        const ip = req.socket.remoteAddress ?? "unknown";
        const rateKey = JSON.stringify([
          ip,
          payload.login.normalize("NFKC").toLowerCase(),
        ]);
        const rate = attempts.get(rateKey) ?? {
          count: 0,
          expires: now + 900000,
          inFlight: 0,
        };
        if (
          rate.count + rate.inFlight >= 20 ||
          (!attempts.has(rateKey) && attempts.size >= 10000)
        ) {
          res.setHeader(
            "Retry-After",
            rate.count >= 20 ? Math.ceil((rate.expires - now) / 1000) : 1,
          );
          throw new HttpError(
            429,
            "RATE_LIMITED",
            "Слишком много попыток входа. Попробуйте позже",
          );
        }
        rate.inFlight++;
        attempts.set(rateKey, rate);
        try {
          let row = (
            await pool.query(
              `SELECT ${userColumns},u.password_hash FROM user_accounts u WHERE login=$1 AND active`,
              [payload.login],
            )
          ).rows[0];
          const demoLogin = payload.demo === true;
          const allowed = demoLogin
            ? config.demo && row?.demo
            : !row?.demo &&
              (await verifyPassword(
                payload.password ?? "",
                row?.password_hash ?? (await dummyHash),
              ));
          if (!row || !allowed) {
            rate.count++;
            throw new HttpError(
              401,
              "INVALID_CREDENTIALS",
              "Неверный логин или пароль",
            );
          }
          const token = randomBytes(32).toString("hex");
          const csrfToken = randomBytes(32).toString("hex");
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const current = (
              await client.query(
                `SELECT ${userColumns},u.password_hash FROM user_accounts u WHERE u.id=$1 AND u.active FOR UPDATE`,
                [row.id],
              )
            ).rows[0];
            if (
              !current ||
              current.password_hash !== row.password_hash ||
              current.demo !== row.demo
            ) {
              rate.count++;
              throw new HttpError(
                401,
                "INVALID_CREDENTIALS",
                "Неверный логин или пароль",
              );
            }
            row = current;
            await client.query(
              "DELETE FROM sessions WHERE expires_at < now() OR revoked_at IS NOT NULL",
            );
            await client.query(
              "UPDATE sessions SET revoked_at=now() WHERE token_hash=$1",
              [tokenHash(cookieToken(req))],
            );
            await client.query(
              "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
              [row.id, tokenHash(token), csrfToken],
            );
            await client.query(
              "INSERT INTO audit_log(actor,action,entity,entity_id,request_id) VALUES($1,'auth.login','user_accounts',$3,$2)",
              [row.id, requestId, row.id],
            );
            await client.query("COMMIT");
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          } finally {
            client.release();
          }
          const { password_hash: _, ...user } = row;
          rate.count = 0;
          res.setHeader("Set-Cookie", sessionCookie(token));
          send({ user, csrfToken });
          return;
        } finally {
          rate.inFlight--;
          if (rate.inFlight === 0 && rate.count === 0) attempts.delete(rateKey);
        }
      }
      const session = (
        await pool.query(
          `SELECT ${userColumns},s.id AS "sessionId",s.csrf_token AS "csrfToken" FROM sessions s JOIN user_accounts u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND (NOT u.demo_only OR $2)`,
          [tokenHash(cookieToken(req)), config.demo],
        )
      ).rows[0];
      if (!session)
        throw new HttpError(401, "UNAUTHENTICATED", "Войдите в аккаунт");
      const { sessionId, csrfToken, ...user } = session as User & {
        sessionId: string;
        csrfToken: string;
      };
      if (method !== "GET" && req.headers["x-csrf-token"] !== csrfToken)
        throw new HttpError(
          403,
          "CSRF_REJECTED",
          "Обновите страницу и повторите действие",
        );
      if (method === "GET" && path === "/api/v1/auth/me") {
        send({ user, csrfToken });
        return;
      }
      if (method === "POST" && path === "/api/v1/auth/logout") {
        await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
          sessionId,
        ]);
        res.setHeader("Set-Cookie", sessionCookie("", 0));
        send({ loggedOut: true });
        return;
      }
      let parsedBody: Promise<unknown> | undefined;
      const context: RouteContext = {
        pool,
        config,
        user,
        path,
        method,
        url,
        req,
        requestId,
        send,
        body: (limit = 65536) => (parsedBody ??= body(req, limit)),
      };
      for (const handler of [
        handleAdministration,
        handleCareer,
        handleGuide,
        handleAssistant,
        handleGrowth,
        handleAnalytics,
        handleIntegrations,
      ]) {
        if (await handler(context)) return;
      }
      const access = scope(user);
      if (method === "GET" && path === "/api/v1/workspace") {
        const counts = (
          await pool.query(
            `SELECT (SELECT count(*)::int FROM employees e WHERE ${access.sql}) AS employees, (SELECT count(*)::int FROM skills) AS skills,(SELECT count(*)::int FROM events) AS events,(SELECT count(*)::int FROM participations p JOIN employees e USING(employee_id) WHERE ${access.sql}) AS participations`,
            access.values,
          )
        ).rows[0];
        const dataset =
          (
            await pool.query(
              'SELECT version,as_of_date::text AS "asOfDate",imported_at AS "importedAt" FROM dataset_batches ORDER BY imported_at DESC LIMIT 1',
            )
          ).rows[0] ?? null;
        send({
          counts,
          dataset,
          scope:
            user.role === "employee"
              ? "self"
              : user.role === "manager"
                ? "team"
                : "organization",
        });
        return;
      }
      if (method === "GET" && path === "/api/v1/employees") {
        const query = z
          .object({
            q: z.string().max(100).default(""),
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(50).default(12),
          })
          .parse(Object.fromEntries(url.searchParams));
        const values = [...access.values];
        values.push(`%${query.q.replace(/[\\%_]/g, "\\$&")}%`);
        const search = `(e.full_name ILIKE $${values.length} OR e.role ILIKE $${values.length} OR e.department ILIKE $${values.length})`;
        const total = (
          await pool.query(
            `SELECT count(*)::int AS total FROM employees e WHERE ${access.sql} AND ${search}`,
            values,
          )
        ).rows[0].total;
        values.push(query.limit, (query.page - 1) * query.limit);
        const rows = (
          await pool.query(
            `SELECT e.employee_id AS id,e.full_name AS name,e.role,e.grade,e.department,e.preferred_language AS language FROM employees e WHERE ${access.sql} AND ${search} ORDER BY e.employee_id LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values,
          )
        ).rows;
        send(rows, 200, { total, page: query.page, limit: query.limit });
        return;
      }
      const match = path.match(/^\/api\/v1\/employees\/([^/]+)$/);
      if (method === "GET" && match) {
        const values = [...access.values, decodeURIComponent(match[1]!)];
        const employee = (
          await pool.query(
            `SELECT e.employee_id AS id,e.full_name AS name,e.role,e.grade,e.department,e.manager_id AS "managerId",e.hire_date::text AS "hireDate",e.tenure_months AS "tenureMonths",e.work_format AS "workFormat",e.preferred_language AS language,e.last_review_date::text AS "lastReviewDate",g.target_role AS "targetRole",g.target_grade AS "targetGrade" FROM employees e LEFT JOIN career_goals g ON g.employee_id=e.employee_id AND g.status='active' WHERE ${access.sql} AND e.employee_id=$${values.length}`,
            values,
          )
        ).rows[0];
        if (!employee)
          throw new HttpError(
            404,
            "NOT_FOUND",
            "Профиль не найден или недоступен",
          );
        send(employee);
        return;
      }
      if (path.startsWith("/api/v1/imports")) {
        if (user.role !== "admin")
          throw new HttpError(
            403,
            "FORBIDDEN",
            "Импорт доступен администратору",
          );
        if (method === "GET" && path === "/api/v1/imports") {
          send(
            (
              await pool.query(
                'SELECT id,version,as_of_date::text AS "asOfDate",counts,imported_at AS "importedAt" FROM dataset_batches ORDER BY imported_at DESC LIMIT 30',
              )
            ).rows,
          );
          return;
        }
        if (
          method === "POST" &&
          (path === "/api/v1/imports/preview" ||
            path === "/api/v1/imports/commit")
        ) {
          const result = await importBundle(
            pool,
            parseBundle(await body(req, 10 * 1024 * 1024)),
            { commit: path.endsWith("/commit"), actor: user.id, requestId },
          );
          send(result);
          return;
        }
      }
      throw new HttpError(404, "NOT_FOUND", "Страница API не найдена");
    } catch (e) {
      let status = 500,
        code = "INTERNAL_ERROR",
        message = "Не удалось выполнить запрос",
        details: unknown;
      if (e instanceof HttpError) {
        status = e.status;
        code = e.code;
        message = e.message;
      } else if (e instanceof ImportError) {
        status = 422;
        code = "INVALID_DATASET";
        message = e.message;
        details = e.details;
      } else if (e instanceof z.ZodError) {
        status = 400;
        code = "VALIDATION_ERROR";
        message = "Проверьте поля запроса";
        details = e.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        }));
      } else if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        ["23505", "23503", "23514", "22P02"].includes(String(e.code))
      ) {
        status = e.code === "23505" ? 409 : 422;
        code = e.code === "23505" ? "CONFLICT" : "CONSTRAINT_VIOLATION";
        message =
          e.code === "23505"
            ? "Такая запись уже существует"
            : "Значение или ссылка не соответствует ограничениям данных";
      }
      if (status === 500)
        console.error(
          JSON.stringify({
            level: "error",
            requestId,
            code: "REQUEST_FAILED",
            cause: e instanceof Error ? e.name : "UnknownError",
            dbCode:
              typeof e === "object" && e !== null && "code" in e
                ? String(e.code)
                : undefined,
          }),
        );
      if (!res.headersSent) {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({ error: { code, message, details, requestId } }),
        );
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
