import { z } from "zod";
import { createHmac, createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  audit,
  HttpError,
  idempotent,
  requireRole,
  snapshotDate,
  transaction,
  type RouteContext,
} from "./http.js";
import { importBundle, parseBundle } from "./imports.js";
import { notificationText } from "./notification-copy.js";

const targetSchema = z.object({
  url: z.url().refine((v) => {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  }),
  secret: z.string().min(16),
});
export type IntegrationTarget = z.infer<typeof targetSchema>;
export function integrationTargets(
  source = process.env,
): Record<string, IntegrationTarget> {
  try {
    return z
      .record(z.string().regex(/^[a-z0-9_-]{1,40}$/), targetSchema)
      .parse(JSON.parse(source.INTEGRATION_TARGETS_JSON || "{}"));
  } catch {
    throw new HttpError(
      503,
      "INTEGRATION_CONFIG_INVALID",
      "Проверьте настройки интеграций",
    );
  }
}
export const webhookSignature = (
  secret: string,
  timestamp: string,
  body: string,
) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
export function icsEscape(text: string) {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}
export function calendarFile(
  events: { id: string; title: string; date: string; description?: string }[],
) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Smart IT Solution//Career Quest//RU",
    "CALSCALE:GREGORIAN",
  ];
  for (const event of events) {
    const day = event.date.replaceAll("-", "");
    const end = new Date(Date.parse(event.date + "T00:00:00Z") + 86400000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(event.id)}@career-quest`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${icsEscape(event.title)}`,
      `DESCRIPTION:${icsEscape(event.description ?? "Date-only session; confirm time with organizer")}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return (
    lines
      .map((line) => {
        const result: string[] = [];
        let current = "";
        for (const char of line) {
          if (Buffer.byteLength(current + char) > 73) {
            result.push(current);
            current = " " + char;
          } else current += char;
        }
        result.push(current);
        return result.join("\r\n");
      })
      .join("\r\n") + "\r\n"
  );
}
export async function processWebhooks(
  pool: Pool,
  targets = integrationTargets(),
  fetcher: typeof fetch = fetch,
) {
  await pool.query(`INSERT INTO webhook_deliveries(subscription_id,event_id)
 SELECT s.id,e.id FROM webhook_subscriptions s JOIN outbox_events e ON e.topic=ANY(s.topics)
 WHERE s.active AND e.created_at>=s.created_at
 AND (e.topic<>'notification.created' OR e.payload->>'targetKey'=s.target_key)
 ON CONFLICT DO NOTHING`);
  const claimed = await transaction(
    pool,
    async (c) =>
      (
        await c.query(`UPDATE webhook_deliveries SET status='sending',locked_until=now()+interval '3 minutes',attempts=attempts+1
 WHERE id IN (SELECT d.id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.active AND d.attempts<5 AND ((d.status IN ('pending','failed') AND d.next_attempt_at<=now()) OR (d.status='sending' AND d.locked_until<now())) ORDER BY d.next_attempt_at LIMIT 10 FOR UPDATE OF d SKIP LOCKED)
 RETURNING *`)
      ).rows,
  );
  let delivered = 0;
  let suppressed = 0;
  for (const d of claimed) {
    try {
      const row = (
        await pool.query(
          "SELECT s.target_key,e.id,e.topic,e.payload,e.created_at FROM webhook_subscriptions s JOIN outbox_events e ON e.id=$2 JOIN webhook_deliveries d ON d.id=$3 WHERE s.id=$1 AND s.active AND d.status='sending' AND d.attempts=$4",
          [d.subscription_id, d.event_id, d.id, d.attempts],
        )
      ).rows[0];
      if (!row) throw new Error("disabled");
      const target = targets[row.target_key];
      if (!target) throw new Error("not_configured");
      if (row.topic === "notification.created") {
        const p = messengerPayload.safeParse(row.payload);
        const approved =
          p.success &&
          p.data.targetKey === row.target_key &&
          p.data.targetKey === process.env.MESSENGER_TARGET_KEY &&
          (
            await pool.query(
              `SELECT n.id FROM notifications n JOIN notification_preferences prefs USING(employee_id)
           WHERE n.id=$1 AND n.employee_id=$2 AND prefs.messenger AND n.created_at>=prefs.messenger_enabled_at
           AND n.read_at IS NULL AND (n.kind<>'learning.reminder' OR prefs.reminders)
           AND (SELECT count(*) FROM integration_identities i WHERE i.provider_key=$3 AND i.entity_type='employee' AND i.local_id=n.employee_id)=1
           AND EXISTS(SELECT 1 FROM integration_identities i WHERE i.provider_key=$3 AND i.entity_type='employee' AND i.local_id=n.employee_id AND i.external_id=$4)`,
              [
                p.data.notificationId,
                p.data.employeeId,
                p.data.targetKey,
                p.data.recipientId,
              ],
            )
          ).rowCount === 1;
        if (!approved) {
          const changed = await pool.query(
            "UPDATE webhook_deliveries SET status='suppressed',locked_until=NULL,last_error='RECIPIENT_OR_CONSENT_CHANGED' WHERE id=$1 AND status='sending' AND attempts=$2",
            [d.id, d.attempts],
          );
          suppressed += changed.rowCount ?? 0;
          continue;
        }
      }
      const body = JSON.stringify({
        id: row.id,
        topic: row.topic,
        payload: row.payload,
        createdAt: row.created_at,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetcher(target.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": d.id,
          "X-Career-Quest-Timestamp": timestamp,
          "X-Career-Quest-Signature": webhookSignature(
            target.secret,
            timestamp,
            body,
          ),
        },
        body,
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error(`http_${response.status}`);
      const completed = await pool.query(
        "UPDATE webhook_deliveries SET status='delivered',delivered_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1 AND status='sending' AND attempts=$2",
        [d.id, d.attempts],
      );
      delivered += completed.rowCount ?? 0;
    } catch {
      await pool.query(
        "UPDATE webhook_deliveries SET status='failed',locked_until=NULL,last_error='DELIVERY_FAILED',next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*power(2,attempts)::int)) WHERE id=$1 AND status='sending' AND attempts=$2",
        [d.id, d.attempts],
      );
    }
  }
  return { processed: claimed.length, delivered, suppressed };
}
const messengerPayload = z
  .object({
    channel: z.literal("messenger"),
    targetKey: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    notificationId: z.uuid(),
    employeeId: z.string().min(1),
    recipientId: z.string().min(1),
  })
  .passthrough();
/** Persist recipient-specific outbox entries; this function never performs network requests. */
export async function enqueueMessengerNotifications(
  pool: Pool,
  targets = integrationTargets(),
) {
  const key = process.env.MESSENGER_TARGET_KEY;
  if (!key) return { configured: false, queued: 0 };
  if (!/^[a-z0-9_-]{1,40}$/.test(key) || !targets[key])
    throw new HttpError(
      503,
      "MESSENGER_NOT_CONFIGURED",
      "Настройте разрешённый адрес мессенджера",
    );
  const queued = await pool.query(
    `WITH eligible AS (
  SELECT n.*,i.recipient_id FROM notifications n JOIN notification_preferences p USING(employee_id)
  JOIN LATERAL (SELECT min(external_id) AS recipient_id FROM integration_identities
   WHERE provider_key=$1 AND entity_type='employee' AND local_id=n.employee_id HAVING count(*)=1) i ON true
  WHERE n.messenger_enqueued_at IS NULL AND n.read_at IS NULL AND p.messenger
   AND n.created_at>=p.messenger_enabled_at AND (n.kind<>'learning.reminder' OR p.reminders)
   AND EXISTS(SELECT 1 FROM webhook_subscriptions s WHERE s.active AND s.target_key=$1 AND 'notification.created'=ANY(s.topics))
  ORDER BY n.created_at,n.id LIMIT 100 FOR UPDATE OF n SKIP LOCKED
 ), published AS (
  INSERT INTO outbox_events(topic,payload)
  SELECT 'notification.created',jsonb_build_object('channel','messenger','targetKey',$1::text,'notificationId',id,'employeeId',employee_id,'recipientId',recipient_id,'kind',kind,'title',title,'body',body,'link',link)
  FROM eligible RETURNING payload->>'notificationId' AS notification_id
 ) UPDATE notifications SET messenger_enqueued_at=now() WHERE id IN (SELECT notification_id::uuid FROM published) RETURNING id`,
    [key],
  );
  return { configured: true, queued: queued.rowCount ?? 0 };
}
export async function createReminders(pool: Pool) {
  const date = await snapshotDate(pool);
  const rows = (
    await pool.query(
      `INSERT INTO notifications(employee_id,kind,title,body,link,dedupe_key)
 SELECT p.employee_id,'learning.reminder',COALESCE(tr.title,e.title),CASE emp.preferred_language WHEN 'kk' THEN $2 WHEN 'en' THEN $3 ELSE $4 END, '/events/'||e.event_id,'reminder:'||p.id::text||':'||$1
 FROM participations p JOIN events e USING(event_id) JOIN employees emp ON emp.employee_id=p.employee_id
 LEFT JOIN event_translations tr ON tr.event_id=e.event_id AND tr.locale=emp.preferred_language AND tr.approved_at IS NOT NULL
 LEFT JOIN event_sessions s ON s.id=p.session_id LEFT JOIN notification_preferences n ON n.employee_id=p.employee_id
 WHERE p.status IN ('registered','in_progress') AND COALESCE(s.session_date,p.due_date) BETWEEN $1::date AND $1::date+7
 AND COALESCE(n.reminders,true) AND (COALESCE(n.in_app,true) OR COALESCE(n.messenger,false))
 ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
      [
        date,
        notificationText("Предстоящая учебная активность", "kk"),
        notificationText("Предстоящая учебная активность", "en"),
        notificationText("Предстоящая учебная активность", "ru"),
      ],
    )
  ).rows;
  return { created: rows.length, asOfDate: date };
}
export async function handleIntegrations(ctx: RouteContext): Promise<boolean> {
  const { path, method, pool, user } = ctx;
  if (path === "/api/v1/notifications" && method === "GET") {
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(Object.fromEntries(ctx.url.searchParams));
    if (!user.employeeId) {
      ctx.send([], 200, { total: 0, ...q });
      return true;
    }
    const total = (
      await pool.query(
        "SELECT count(*)::int AS n FROM notifications WHERE employee_id=$1",
        [user.employeeId],
      )
    ).rows[0].n;
    const rows = (
      await pool.query(
        'SELECT id,kind,title,body,link,read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE employee_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',
        [user.employeeId, q.limit, (q.page - 1) * q.limit],
      )
    ).rows;
    ctx.send(rows, 200, { total, ...q });
    return true;
  }
  const notification = path.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/);
  if (notification && method === "POST") {
    const id = z.uuid().parse(notification[1]);
    const row = await pool.query(
      "UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND employee_id=$2 RETURNING id",
      [id, user.employeeId],
    );
    if (!row.rowCount)
      throw new HttpError(404, "NOT_FOUND", "Уведомление не найдено");
    ctx.send({ read: true });
    return true;
  }
  if (
    path === "/api/v1/notification-preferences" &&
    ["GET", "PUT"].includes(method)
  ) {
    if (!user.employeeId)
      throw new HttpError(
        409,
        "EMPLOYEE_REQUIRED",
        "У аккаунта нет профиля сотрудника",
      );
    if (method === "GET") {
      ctx.send(
        (
          await pool.query(
            'SELECT in_app AS "inApp",messenger,reminders FROM notification_preferences WHERE employee_id=$1',
            [user.employeeId],
          )
        ).rows[0] ?? { inApp: true, messenger: false, reminders: true },
      );
      return true;
    }
    const p = z
      .object({
        inApp: z.boolean(),
        messenger: z.boolean(),
        reminders: z.boolean(),
      })
      .strict()
      .parse(await ctx.body());
    await pool.query(
      `INSERT INTO notification_preferences(employee_id,in_app,messenger,reminders,messenger_enabled_at) VALUES($1,$2,$3,$4,CASE WHEN $3 THEN now() ELSE NULL END)
       ON CONFLICT(employee_id) DO UPDATE SET in_app=EXCLUDED.in_app,messenger=EXCLUDED.messenger,reminders=EXCLUDED.reminders,
        messenger_enabled_at=CASE WHEN NOT EXCLUDED.messenger THEN NULL WHEN NOT notification_preferences.messenger THEN now() ELSE notification_preferences.messenger_enabled_at END`,
      [user.employeeId, p.inApp, p.messenger, p.reminders],
    );
    ctx.send(p);
    return true;
  }
  if (path === "/api/v1/calendar" && method === "GET") {
    if (!user.employeeId)
      throw new HttpError(409, "EMPLOYEE_REQUIRED", "Нет профиля сотрудника");
    const rows = (
      await pool.query(
        "SELECT p.id,e.title,COALESCE(s.session_date,p.due_date,p.date)::text AS date,e.description FROM participations p JOIN events e USING(event_id) LEFT JOIN event_sessions s ON s.id=p.session_id WHERE p.employee_id=$1 AND p.status IN ('registered','in_progress') ORDER BY COALESCE(s.session_date,p.due_date,p.date),p.id",
        [user.employeeId],
      )
    ).rows;
    ctx.send({
      filename: "career-quest.ics",
      contentType: "text/calendar",
      content: calendarFile(
        rows as {
          id: string;
          title: string;
          date: string;
          description: string;
        }[],
      ),
      dateOnly: true,
    });
    return true;
  }
  if (path === "/api/v1/tickets" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT id,provider_key AS "providerKey",external_id AS "externalId",title,status,created_at AS "createdAt" FROM service_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
          [user.id],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/tickets" && method === "POST") {
    const p = z
      .object({
        providerKey: z.string().max(40),
        title: z.string().min(3).max(200),
        description: z.string().min(10).max(4000),
      })
      .strict()
      .parse(await ctx.body());
    const target = integrationTargets()[p.providerKey];
    if (!target)
      throw new HttpError(
        503,
        "INTEGRATION_NOT_CONFIGURED",
        "Система заявок не подключена",
      );
    const result = await idempotent(ctx, path, p, async (c) => {
      let response: Response;
      try {
        response = await fetch(target.url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            Authorization: `Bearer ${target.secret}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `${user.id}:${ctx.req.headers["idempotency-key"]}`,
          },
          body: JSON.stringify({
            title: p.title,
            description: p.description,
            employeeId: user.employeeId,
          }),
        });
      } catch {
        throw new HttpError(
          502,
          "TICKET_PROVIDER_UNAVAILABLE",
          "Система заявок недоступна",
        );
      }
      if (!response.ok)
        throw new HttpError(
          502,
          "TICKET_PROVIDER_UNAVAILABLE",
          "Система заявок не приняла обращение",
        );
      const remote = z
        .object({
          id: z.string().min(1).max(200),
          status: z.string().min(1).max(100),
        })
        .safeParse(await response.json());
      if (!remote.success)
        throw new HttpError(
          502,
          "TICKET_PROVIDER_INVALID",
          "Система заявок вернула некорректный результат",
        );
      const row = (
        await c.query(
          'INSERT INTO service_tickets(user_id,provider_key,external_id,title,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider_key,external_id) DO UPDATE SET status=EXCLUDED.status WHERE service_tickets.user_id=EXCLUDED.user_id RETURNING id,external_id AS "externalId",status',
          [user.id, p.providerKey, remote.data.id, p.title, remote.data.status],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(
          409,
          "TICKET_CONFLICT",
          "Конфликт внешнего идентификатора",
        );
      return row;
    });
    ctx.send(result, 201);
    return true;
  }
  const refresh = path.match(/^\/api\/v1\/tickets\/([^/]+)\/refresh$/);
  if (refresh && method === "POST") {
    const row = (
      await pool.query(
        "SELECT * FROM service_tickets WHERE id=$1 AND user_id=$2",
        [z.uuid().parse(refresh[1]), user.id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "NOT_FOUND", "Заявка не найдена");
    const target = integrationTargets()[row.provider_key];
    if (!target)
      throw new HttpError(
        503,
        "INTEGRATION_NOT_CONFIGURED",
        "Система заявок не подключена",
      );
    let remote: Response;
    try {
      const url = new URL(target.url);
      url.pathname =
        url.pathname.replace(/\/$/, "") +
        "/" +
        encodeURIComponent(row.external_id);
      remote = await fetch(url, {
        headers: { Authorization: `Bearer ${target.secret}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new HttpError(
        502,
        "TICKET_PROVIDER_UNAVAILABLE",
        "Система заявок недоступна",
      );
    }
    if (!remote.ok)
      throw new HttpError(
        502,
        "TICKET_PROVIDER_UNAVAILABLE",
        "Статус не получен",
      );
    const p = z
      .object({
        id: z.literal(row.external_id as string),
        status: z.string().min(1).max(100),
      })
      .safeParse(await remote.json());
    if (!p.success)
      throw new HttpError(
        502,
        "TICKET_PROVIDER_INVALID",
        "Некорректный ответ системы",
      );
    await pool.query("UPDATE service_tickets SET status=$1 WHERE id=$2", [
      p.data.status,
      row.id,
    ]);
    ctx.send({
      id: row.id,
      externalId: row.external_id,
      status: p.data.status,
    });
    return true;
  }
  if (
    path !== "/api/v1/integrations" &&
    !path.startsWith("/api/v1/integrations/")
  )
    return false;
  requireRole(user, "admin");
  if (path === "/api/v1/integrations" && method === "GET") {
    ctx.send({
      configuredTargets: Object.keys(integrationTargets()),
      ssoConfigured: Boolean(
        process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID,
      ),
      webhooksEnabled: process.env.WORKER_DELIVERY_ENABLED === "true",
      messengerTargetKey: process.env.MESSENGER_TARGET_KEY ?? null,
      nvidia: "deferred",
    });
    return true;
  }
  if (path === "/api/v1/integrations/webhooks" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT id,name,target_key AS "targetKey",topics,active FROM webhook_subscriptions ORDER BY created_at',
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/integrations/webhooks" && method === "POST") {
    const p = z
      .object({
        name: z.string().min(1).max(100),
        targetKey: z.string().max(40),
        topics: z
          .array(
            z.enum([
              "goal.changed",
              "participation.completed",
              "event.published",
              "notification.created",
            ]),
          )
          .min(1)
          .max(4),
      })
      .strict()
      .parse(await ctx.body());
    if (!integrationTargets()[p.targetKey])
      throw new HttpError(
        422,
        "TARGET_NOT_CONFIGURED",
        "Настройте разрешённый адрес на сервере",
      );
    ctx.send(
      await idempotent(ctx, path, p, async (c) => {
        if (p.topics.includes("notification.created")) {
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`messenger-subscription:${p.targetKey}`],
          );
          if (
            (
              await c.query(
                "SELECT 1 FROM webhook_subscriptions WHERE target_key=$1 AND active AND topics @> ARRAY['notification.created']::text[]",
                [p.targetKey],
              )
            ).rowCount
          )
            throw new HttpError(
              409,
              "MESSENGER_SUBSCRIPTION_EXISTS",
              "Для этого канала уже настроена активная подписка",
            );
        }
        const r = (
          await c.query(
            "INSERT INTO webhook_subscriptions(name,target_key,topics,created_by) VALUES($1,$2,$3,$4) RETURNING id",
            [p.name, p.targetKey, p.topics, user.id],
          )
        ).rows[0];
        await audit(
          c,
          user,
          "webhook.create",
          "webhook_subscriptions",
          r.id,
          { name: p.name, targetKey: p.targetKey, topics: p.topics },
          ctx.requestId,
        );
        return r;
      }),
      201,
    );
    return true;
  }
  const subscription = path.match(
    /^\/api\/v1\/integrations\/webhooks\/([^/]+)$/,
  );
  if (subscription && method === "PATCH") {
    const p = z
      .object({ active: z.boolean() })
      .strict()
      .parse(await ctx.body());
    const id = z.uuid().parse(subscription[1]);
    const result = await transaction(pool, async (c) => {
      const existing = (
        await c.query(
          "SELECT target_key,topics FROM webhook_subscriptions WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!existing)
        throw new HttpError(404, "NOT_FOUND", "Подписка не найдена");
      if (p.active && existing.topics.includes("notification.created")) {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `messenger-subscription:${existing.target_key}`,
        ]);
        if (
          (
            await c.query(
              "SELECT 1 FROM webhook_subscriptions WHERE target_key=$1 AND id<>$2 AND active AND topics @> ARRAY['notification.created']::text[]",
              [existing.target_key, id],
            )
          ).rowCount
        )
          throw new HttpError(
            409,
            "MESSENGER_SUBSCRIPTION_EXISTS",
            "Для этого канала уже настроена активная подписка",
          );
      }
      const r = await c.query(
        "UPDATE webhook_subscriptions SET active=$1 WHERE id=$2 RETURNING id",
        [p.active, id],
      );
      await audit(
        c,
        user,
        "webhook.update",
        "webhook_subscriptions",
        id,
        p,
        ctx.requestId,
      );
      return r.rows[0];
    });
    ctx.send(result);
    return true;
  }
  if (path === "/api/v1/integrations/deliveries" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT id,subscription_id AS "subscriptionId",event_id AS "eventId",status,attempts,next_attempt_at AS "nextAttemptAt",last_error AS "lastError" FROM webhook_deliveries ORDER BY next_attempt_at DESC LIMIT 100',
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/integrations/identities" && method === "GET") {
    const provider = ctx.url.searchParams.get("providerKey");
    ctx.send(
      (
        await pool.query(
          'SELECT provider_key AS "providerKey",entity_type AS "entityType",external_id AS "externalId",local_id AS "localId" FROM integration_identities WHERE ($1::text IS NULL OR provider_key=$1) ORDER BY provider_key,entity_type,external_id LIMIT 1000',
          [provider],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/integrations/identities" && method === "DELETE") {
    const p = z
      .object({
        providerKey: z.string().min(1).max(40),
        entityType: z.enum(["employee", "event"]),
        externalId: z.string().min(1).max(200),
      })
      .strict()
      .parse(await ctx.body());
    ctx.send(
      await idempotent(ctx, `${path}:delete`, p, async (c) => {
        await c.query(
          "DELETE FROM integration_identities WHERE provider_key=$1 AND entity_type=$2 AND external_id=$3",
          [p.providerKey, p.entityType, p.externalId],
        );
        await audit(
          c,
          user,
          "integration.unmap",
          "integration_identities",
          `${p.providerKey}:${p.entityType}:${p.externalId}`,
          {},
          ctx.requestId,
        );
        return { removed: true };
      }),
    );
    return true;
  }
  if (path === "/api/v1/integrations/identities" && method === "PUT") {
    const p = z
      .object({
        providerKey: z.string().min(1).max(40),
        entityType: z.enum(["employee", "event"]),
        externalId: z.string().min(1).max(200),
        localId: z.string().min(1).max(120),
      })
      .strict()
      .parse(await ctx.body());
    const table = p.entityType === "employee" ? "employees" : "events";
    const id = p.entityType === "employee" ? "employee_id" : "event_id";
    ctx.send(
      await idempotent(ctx, path, p, async (c) => {
        if (
          !(await c.query(`SELECT 1 FROM ${table} WHERE ${id}=$1`, [p.localId]))
            .rowCount
        )
          throw new HttpError(
            422,
            "UNKNOWN_LOCAL_ID",
            "Неизвестный локальный ID",
          );
        await c.query(
          "INSERT INTO integration_identities VALUES($1,$2,$3,$4) ON CONFLICT(provider_key,entity_type,external_id) DO UPDATE SET local_id=EXCLUDED.local_id",
          [p.providerKey, p.entityType, p.externalId, p.localId],
        );
        await audit(
          c,
          user,
          "integration.mapping",
          "integration_identities",
          `${p.providerKey}:${p.entityType}:${p.externalId}`,
          { localId: p.localId },
          ctx.requestId,
        );
        return { saved: true };
      }),
    );
    return true;
  }
  if (path === "/api/v1/integrations/import" && method === "POST") {
    const p = z
      .object({
        providerKey: z.string().min(1).max(40),
        messageId: z.string().min(8).max(160),
        historyCsv: z.string().optional(),
        employees: z.unknown().optional(),
        history: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .strict()
      .parse(await ctx.body(10 * 1024 * 1024));
    const hash = createHash("sha256").update(JSON.stringify(p)).digest("hex");
    const leaseToken = randomUUID();
    // A committed, fenced lease avoids reserving a pool connection while the importer obtains its own.
    const claimed = (
      await pool.query(
        `INSERT INTO integration_receipts(provider_key,message_id,payload_hash,result,lease_token,lease_expires_at)
     VALUES($1,$2,$3,'{"pending":true}'::jsonb,$4,now()+interval '10 minutes')
     ON CONFLICT(provider_key,message_id) DO UPDATE SET lease_token=EXCLUDED.lease_token,lease_expires_at=EXCLUDED.lease_expires_at
     WHERE integration_receipts.payload_hash=EXCLUDED.payload_hash AND integration_receipts.result->>'pending'='true'
       AND (integration_receipts.lease_expires_at IS NULL OR integration_receipts.lease_expires_at<=now())
     RETURNING normalized_payload`,
        [p.providerKey, p.messageId, hash, leaseToken],
      )
    ).rows[0];
    if (!claimed) {
      const previous = (
        await pool.query(
          "SELECT payload_hash,result FROM integration_receipts WHERE provider_key=$1 AND message_id=$2",
          [p.providerKey, p.messageId],
        )
      ).rows[0];
      if (previous?.payload_hash !== hash)
        throw new HttpError(
          409,
          "MESSAGE_CONFLICT",
          "Сообщение с таким ID уже получено",
        );
      if (!previous.result.pending) {
        ctx.send(previous.result);
        return true;
      }
      throw new HttpError(
        409,
        "IMPORT_IN_PROGRESS",
        "Сообщение уже обрабатывается. Повторите запрос позже",
      );
    }
    try {
      let data: ReturnType<typeof parseBundle>;
      if (claimed.normalized_payload)
        data = parseBundle(claimed.normalized_payload);
      else {
        const mapped = structuredClone(p.history ?? []);
        const identities = (
          await pool.query(
            "SELECT entity_type,external_id,local_id FROM integration_identities WHERE provider_key=$1",
            [p.providerKey],
          )
        ).rows;
        for (const h of mapped) {
          for (const kind of ["employee", "event"]) {
            const key = `${kind}_id`;
            const match = identities.find(
              (m) => m.entity_type === kind && m.external_id === h[key],
            );
            if (!match)
              throw new HttpError(
                422,
                "MAPPING_REQUIRED",
                `Нет сопоставления ${kind}`,
              );
            h[key] = match.local_id;
          }
        }
        if (p.historyCsv)
          throw new HttpError(
            422,
            "NORMALIZED_HISTORY_REQUIRED",
            "Для интеграции используйте history с внешними ID; CSV загружайте обычным импортом",
          );
        data = parseBundle({
          ...(p.employees ? { employees: p.employees } : {}),
          ...(p.history ? { history: mapped } : {}),
        });
        const saved = await pool.query(
          "UPDATE integration_receipts SET normalized_payload=$4 WHERE provider_key=$1 AND message_id=$2 AND lease_token=$3",
          [p.providerKey, p.messageId, leaseToken, JSON.stringify(data)],
        );
        if (!saved.rowCount)
          throw new HttpError(
            409,
            "IMPORT_LEASE_EXPIRED",
            "Срок обработки истёк. Повторите запрос",
          );
      }
      const result = await importBundle(pool, data, {
        commit: true,
        actor: user.id,
        requestId: ctx.requestId,
      });
      const completed = await pool.query(
        "UPDATE integration_receipts SET result=$3,lease_token=NULL,lease_expires_at=NULL WHERE provider_key=$1 AND message_id=$2 AND lease_token=$4",
        [p.providerKey, p.messageId, result, leaseToken],
      );
      if (!completed.rowCount)
        throw new HttpError(
          409,
          "IMPORT_LEASE_EXPIRED",
          "Срок обработки истёк. Повторите запрос",
        );
      ctx.send(result);
      return true;
    } catch (error) {
      await pool.query(
        "UPDATE integration_receipts SET lease_token=NULL,lease_expires_at=now() WHERE provider_key=$1 AND message_id=$2 AND lease_token=$3 AND result->>'pending'='true'",
        [p.providerKey, p.messageId, leaseToken],
      );
      throw error;
    }
  }
  return false;
}
