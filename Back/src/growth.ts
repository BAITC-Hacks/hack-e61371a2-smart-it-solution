import { z } from "zod";
import {
  loadCareer,
  loadEvents,
  eligibility,
  type CareerEvent,
  type CareerProfile,
} from "./career.js";
import {
  HttpError,
  audit,
  idempotent,
  requireRole,
  snapshotDate,
  transaction,
  type Queryable,
  type RouteContext,
} from "./http.js";

const uuid = z.string().uuid();
const employeeId = z.string().min(1).max(80);
const text = (max = 500) => z.string().trim().min(1).max(max);
const grade = z.enum(["Junior", "Middle", "Senior", "Lead"]);
const goalSchema = z
  .object({ targetRole: text(120), targetGrade: grade })
  .strict();
const preferencesSchema = z
  .object({
    weeklyHours: z.number().min(0.5).max(40),
    formats: z
      .array(z.enum(["online", "offline", "self_paced"]))
      .min(1)
      .max(3)
      .refine((a) => new Set(a).size === a.length),
  })
  .strict();
const horizon = z.union([z.literal(30), z.literal(90), z.literal(180)]);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "Некорректная дата",
  );
type Preferences = z.infer<typeof preferencesSchema>;
type Requirement = {
  skillId: string;
  requiredLevel: number;
  isCritical: boolean;
};
type Goal = z.infer<typeof goalSchema>;
function me(ctx: RouteContext): string {
  if (!ctx.user.employeeId)
    throw new HttpError(
      403,
      "EMPLOYEE_REQUIRED",
      "Нужен связанный профиль сотрудника",
    );
  return ctx.user.employeeId;
}
function missing(message = "Запись не найдена"): never {
  throw new HttpError(404, "NOT_FOUND", message);
}
function conflict(message: string): never {
  throw new HttpError(409, "STATE_CONFLICT", message);
}
function addDays(value: string, n: number) {
  const d = new Date(`${value}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
async function notify(
  db: Queryable,
  employee: string,
  kind: string,
  title: string,
  key: string,
  link: string,
) {
  await db.query(
    "INSERT INTO notifications(employee_id,kind,title,body,link,dedupe_key) VALUES($1,$2,$3,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING",
    [employee, kind, title, link, key],
  );
}
async function preferences(db: Queryable, id: string): Promise<Preferences> {
  const row = (
    await db.query(
      'SELECT weekly_hours::float8 AS "weeklyHours",formats FROM employee_preferences WHERE employee_id=$1',
      [id],
    )
  ).rows[0];
  return (
    row ?? { weeklyHours: 4, formats: ["online", "offline", "self_paced"] }
  );
}
async function requirements(
  db: Queryable,
  goal: { targetRole: string; targetGrade: string },
): Promise<Requirement[]> {
  if (
    !(
      await db.query("SELECT 1 FROM role_profiles WHERE role=$1 AND grade=$2", [
        goal.targetRole,
        goal.targetGrade,
      ])
    ).rowCount
  )
    throw new HttpError(400, "INVALID_GOAL", "Целевой профиль не найден");
  return (
    await db.query(
      'SELECT skill_id AS "skillId",required_level AS "requiredLevel",is_critical AS "isCritical" FROM role_requirements WHERE role=$1 AND grade=$2 ORDER BY skill_id',
      [goal.targetRole, goal.targetGrade],
    )
  ).rows;
}
export function simulateEffects(
  levels: Record<string, number>,
  effects: CareerEvent["effects"],
) {
  const result = { ...levels };
  const gains: Array<{ skillId: string; from: number; to: number }> = [];
  for (const effect of effects) {
    const from = result[effect.skillId] ?? 0;
    const to =
      from + Math.max(0, Math.min(effect.gain, effect.maxLevel - from));
    result[effect.skillId] = to;
    if (to > from) gains.push({ skillId: effect.skillId, from, to });
  }
  return { levels: result, gains };
}
function gaps(levels: Record<string, number>, reqs: Requirement[]) {
  return reqs
    .map((r) => ({
      ...r,
      currentLevel: levels[r.skillId] ?? 0,
      gap: Math.max(0, r.requiredLevel - (levels[r.skillId] ?? 0)),
    }))
    .filter((r) => r.gap > 0);
}
export function buildRoadmap(
  profile: CareerProfile,
  events: CareerEvent[],
  reqs: Requirement[],
  prefs: Preferences,
  days: 30 | 90 | 180,
) {
  let levels = { ...profile.effectiveLevels };
  let hours = 0;
  let previousDate = profile.asOfDate;
  const end = addDays(profile.asOfDate, days);
  const budget = (prefs.weeklyHours * days) / 7;
  const selected = new Set<string>();
  const steps: Array<{
    eventId: string;
    title: string;
    position: number;
    sessionId: string | null;
    scheduledDate: string;
    durationHours: number;
    gains: ReturnType<typeof simulateEffects>["gains"];
    prerequisites: CareerEvent["prerequisites"];
    alternatives: string[];
  }> = [];
  while (steps.length < 60) {
    const remaining = gaps(levels, reqs);
    if (!remaining.length) break;
    const needed = new Map(remaining.map((r) => [r.skillId, r.requiredLevel]));
    // Follow prerequisite chains recursively, including preparatory courses several steps away from the goal.
    for (let pass = 0; pass < 60; pass++) {
      let changed = false;
      for (const e of events.filter(
        (e) =>
          !e.mandatory &&
          e.isActive &&
          e.targetRoles.includes(profile.employee.role) &&
          e.targetGrades.includes(profile.employee.grade),
      )) {
        if (
          !e.effects.some(
            (f) =>
              (needed.get(f.skillId) ?? 0) > (levels[f.skillId] ?? 0) &&
              f.maxLevel > (levels[f.skillId] ?? 0),
          )
        )
          continue;
        for (const p of e.prerequisites)
          if (
            p.minLevel > (levels[p.skillId] ?? 0) &&
            p.minLevel > (needed.get(p.skillId) ?? 0)
          ) {
            needed.set(p.skillId, p.minLevel);
            changed = true;
          }
      }
      if (!changed) break;
    }
    const bridge = [...needed]
      .map(([skillId, minLevel]) => ({ skillId, minLevel }))
      .filter((p) => (levels[p.skillId] ?? 0) < p.minLevel);
    const options = events
      .filter(
        (e) =>
          !selected.has(e.eventId) &&
          !e.mandatory &&
          hours + e.durationHours <= budget,
      )
      .flatMap((e) => {
        const check = eligibility(e, {
          ...profile,
          asOfDate: previousDate,
          effectiveLevels: levels,
        });
        if (!check.eligible) return [];
        const sim = simulateEffects(levels, e.effects);
        if (!sim.gains.length) return [];
        const usefulGains = sim.gains.reduce(
          (sum, g) =>
            sum +
            remaining
              .filter((r) => r.skillId === g.skillId)
              .reduce(
                (a, r) =>
                  a + Math.min(r.gap, g.to - g.from) * (r.isCritical ? 3 : 1),
                0,
              ),
          0,
        );
        const bridgeGains = sim.gains.reduce(
          (sum, g) =>
            sum +
            bridge
              .filter((p) => p.skillId === g.skillId)
              .reduce(
                (a, p) => a + Math.min(p.minLevel - g.from, g.to - g.from),
                0,
              ),
          0,
        );
        if (usefulGains <= 0 && bridgeGains <= 0) return [];
        const earliest = addDays(
          previousDate,
          Math.max(1, Math.ceil((e.durationHours / prefs.weeklyHours) * 7)),
        );
        const session =
          e.format === "self_paced"
            ? null
            : e.sessions
                .filter(
                  (s) =>
                    s.date >= earliest &&
                    s.date <= end &&
                    (s.capacity === null || s.occupied < s.capacity),
                )
                .sort((a, b) => a.date.localeCompare(b.date))[0];
        if (e.format !== "self_paced" && !session) return [];
        const scheduledDate = session?.date ?? earliest;
        if (scheduledDate > end) return [];
        return [
          {
            event: e,
            sim,
            session,
            scheduledDate,
            score:
              ((usefulGains + bridgeGains * 0.4) / e.durationHours) *
              (prefs.formats.includes(
                e.format as Preferences["formats"][number],
              )
                ? 1.25
                : 1),
          },
        ];
      })
      .sort(
        (a, b) =>
          b.score - a.score || a.event.eventId.localeCompare(b.event.eventId),
      );
    const best = options[0];
    if (!best) break;
    const skillSet = new Set(best.sim.gains.map((g) => g.skillId));
    steps.push({
      eventId: best.event.eventId,
      title: best.event.title,
      position: steps.length + 1,
      sessionId: best.session?.id ?? null,
      scheduledDate: best.scheduledDate,
      durationHours: best.event.durationHours,
      gains: best.sim.gains,
      prerequisites: best.event.prerequisites,
      alternatives: options
        .slice(1)
        .filter((o) => o.sim.gains.some((g) => skillSet.has(g.skillId)))
        .slice(0, 3)
        .map((o) => o.event.eventId),
    });
    selected.add(best.event.eventId);
    hours += best.event.durationHours;
    levels = best.sim.levels;
    previousDate = best.scheduledDate;
  }
  return {
    startDate: profile.asOfDate,
    endDate: end,
    horizonDays: days,
    weeklyHours: prefs.weeklyHours,
    formats: prefs.formats,
    totalHours: hours,
    budgetHours: Number(budget.toFixed(2)),
    baselineLevels: profile.effectiveLevels,
    projectedLevels: levels,
    unmetRequirements: gaps(levels, reqs),
    steps,
    disclaimer:
      "Прогноз не гарантирует повышение. Сессии и места повторно проверяются при записи.",
  };
}
async function planInput(
  db: Queryable,
  id: string,
  goal: Goal | undefined,
  days: 30 | 90 | 180,
) {
  const profile = await loadCareer(db, id);
  const target = goal ?? profile.goal;
  if (!target)
    throw new HttpError(409, "GOAL_REQUIRED", "Выберите карьерную цель");
  const reqs = await requirements(db, target);
  const prefs = await preferences(db, id);
  return {
    target,
    roadmap: buildRoadmap(profile, await loadEvents(db), reqs, prefs, days),
  };
}
async function writeSteps(
  db: Queryable,
  id: string,
  roadmap: Awaited<ReturnType<typeof planInput>>["roadmap"],
) {
  await db.query("DELETE FROM development_plan_steps WHERE plan_id=$1", [id]);
  for (const s of roadmap.steps)
    await db.query(
      "INSERT INTO development_plan_steps(plan_id,position,event_id,session_id,scheduled_date,duration_hours,gains,prerequisites,alternatives) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        s.position,
        s.eventId,
        s.sessionId,
        s.scheduledDate,
        s.durationHours,
        JSON.stringify(s.gains),
        JSON.stringify(s.prerequisites),
        JSON.stringify(s.alternatives),
      ],
    );
}
async function readPlan(db: Queryable, id: string, employee: string) {
  const p = (
    await db.query(
      'SELECT id,employee_id AS "employeeId",target_role AS "targetRole",target_grade AS "targetGrade",horizon_days AS "horizonDays",start_date::text AS "startDate",status,weekly_hours::float8 AS "weeklyHours",formats,baseline_levels AS "baselineLevels",projected_levels AS "projectedLevels",unmet_requirements AS "unmetRequirements",total_hours::float8 AS "totalHours",version,created_at AS "createdAt",updated_at AS "updatedAt" FROM development_plans WHERE id=$1 AND employee_id=$2',
      [id, employee],
    )
  ).rows[0];
  if (!p) missing();
  const profile = await loadCareer(db, employee);
  const currentPreferences = await preferences(db, employee);
  p.goalChanged =
    profile.goal?.targetRole !== p.targetRole ||
    profile.goal?.targetGrade !== p.targetGrade;
  p.requiresRefresh =
    p.goalChanged ||
    currentPreferences.weeklyHours !== p.weeklyHours ||
    [...currentPreferences.formats].sort().join(",") !==
      [...p.formats].sort().join(",") ||
    Object.keys({ ...profile.effectiveLevels, ...p.baselineLevels }).some(
      (key) => profile.effectiveLevels[key] !== p.baselineLevels[key],
    );
  p.steps = (
    await db.query(
      `SELECT s.id,s.position,s.event_id AS "eventId",e.title,s.session_id AS "sessionId",s.scheduled_date::text AS "scheduledDate",s.duration_hours::float8 AS "durationHours",s.gains,s.prerequisites,s.alternatives,
 EXISTS(SELECT 1 FROM participations x WHERE x.employee_id=$2 AND x.event_id=s.event_id AND x.status='completed' AND x.date>=$3) AS completed
 FROM development_plan_steps s JOIN events e ON e.event_id=s.event_id WHERE s.plan_id=$1 ORDER BY position`,
      [id, employee, p.startDate],
    )
  ).rows;
  return p;
}
async function ensureSkillIds(db: Queryable, ids: string[]) {
  if (
    (
      await db.query(
        "SELECT skill_id FROM skills WHERE skill_id=ANY($1::text[])",
        [ids],
      )
    ).rowCount !== ids.length
  )
    throw new HttpError(
      400,
      "INVALID_SKILLS",
      "Навык не найден или указан повторно",
    );
}

/** Reconcile credits under a per-employee lock. Only server-recorded voluntary completions after policy activation earn points. */
export async function syncRewardLedger(db: Queryable, employee: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `rewards:${employee}`,
  ]);
  const policy = (
    await db.query("SELECT * FROM reward_policy WHERE singleton FOR SHARE")
  ).rows[0];
  const reversals = (
    await db.query(
      `SELECT l.* FROM reward_ledger l JOIN participations p ON p.id=l.participation_id JOIN events e ON e.event_id=p.event_id
 WHERE l.employee_id=$1 AND l.kind='earned' AND (p.status<>'completed' OR e.mandatory)
 AND NOT EXISTS(SELECT 1 FROM reward_ledger r WHERE r.source_key='reverse:'||l.id::text)`,
      [employee],
    )
  ).rows;
  for (const row of reversals)
    await db.query(
      "INSERT INTO reward_ledger(employee_id,delta,kind,participation_id,event_id,source_key) VALUES($1,$2,'reversed',$3,$4,$5) ON CONFLICT(source_key) DO NOTHING",
      [
        employee,
        -row.delta,
        row.participation_id,
        row.event_id,
        `reverse:${row.id}`,
      ],
    );
  if (policy.enabled) {
    const eligible = (
      await db.query(
        `SELECT DISTINCT ON(p.event_id) p.id,p.event_id FROM participations p JOIN events e ON e.event_id=p.event_id
   WHERE p.employee_id=$1 AND p.status='completed' AND NOT e.mandatory AND p.source_record_id IS NULL AND p.reward_completed_at>=$2
   AND NOT EXISTS(SELECT 1 FROM reward_ledger l WHERE l.employee_id=$1 AND l.event_id=p.event_id AND l.kind='earned') ORDER BY p.event_id,p.created_at,p.id`,
        [employee, policy.effective_from],
      )
    ).rows;
    let earned = Number(
      (
        await db.query(
          "SELECT coalesce(sum(delta),0)::int AS n FROM reward_ledger WHERE employee_id=$1 AND kind='earned' AND created_at>=date_trunc('month',now())",
          [employee],
        )
      ).rows[0].n,
    );
    for (const p of eligible) {
      if (earned + policy.points_per_event > policy.monthly_cap) break;
      await db.query(
        "INSERT INTO reward_ledger(employee_id,delta,kind,participation_id,event_id,source_key) VALUES($1,$2,'earned',$3,$4,$5) ON CONFLICT(source_key) DO NOTHING",
        [
          employee,
          policy.points_per_event,
          p.id,
          p.event_id,
          `completion:${p.id}`,
        ],
      );
      earned += policy.points_per_event;
    }
  }
  const balance = Number(
    (
      await db.query(
        "SELECT coalesce(sum(delta),0)::int AS balance FROM reward_ledger WHERE employee_id=$1",
        [employee],
      )
    ).rows[0].balance,
  );
  return {
    enabled: policy.enabled,
    balance,
    spendableBalance: Math.max(0, balance),
    rules: policy.rules_text,
    pointsPerEvent: policy.points_per_event,
    monthlyCap: policy.monthly_cap,
  };
}

export async function handleGrowth(ctx: RouteContext): Promise<boolean> {
  const { pool, path, method, user } = ctx;
  if (path === "/api/v1/me/preferences" && method === "GET") {
    ctx.send(await preferences(pool, me(ctx)));
    return true;
  }
  if (path === "/api/v1/me/preferences" && method === "PUT") {
    const id = me(ctx);
    const p = preferencesSchema.parse(await ctx.body());
    await pool.query(
      "INSERT INTO employee_preferences(employee_id,weekly_hours,formats) VALUES($1,$2,$3) ON CONFLICT(employee_id) DO UPDATE SET weekly_hours=excluded.weekly_hours,formats=excluded.formats,updated_at=now()",
      [id, p.weeklyHours, p.formats],
    );
    ctx.send(p);
    return true;
  }
  if (path === "/api/v1/me/growth/compare" && method === "POST") {
    const id = me(ctx);
    const p = z
      .object({
        goals: z.array(goalSchema).min(2).max(4),
        horizonDays: horizon.default(90),
      })
      .strict()
      .parse(await ctx.body());
    const results = [];
    for (const goal of p.goals) {
      const input = await planInput(pool, id, goal, p.horizonDays);
      results.push({ ...goal, ...input.roadmap });
    }
    ctx.send(results);
    return true;
  }
  if (path === "/api/v1/me/growth/simulate" && method === "POST") {
    const id = me(ctx);
    const p = z
      .object({
        eventIds: z
          .array(text(80))
          .min(1)
          .max(30)
          .refine((a) => new Set(a).size === a.length),
        goal: goalSchema.optional(),
      })
      .strict()
      .parse(await ctx.body());
    const profile = await loadCareer(pool, id);
    const events = await loadEvents(pool);
    let levels = { ...profile.effectiveLevels };
    const steps = [];
    let asOfDate = profile.asOfDate;
    for (const eventId of p.eventIds) {
      const e = events.find((e) => e.eventId === eventId);
      if (!e)
        throw new HttpError(
          400,
          "INVALID_EVENT",
          `Мероприятие ${eventId} не найдено`,
        );
      if (e.mandatory)
        throw new HttpError(
          400,
          "VOLUNTARY_ONLY",
          "Для симуляции доступны добровольные мероприятия",
        );
      const check = eligibility(e, {
        ...profile,
        effectiveLevels: levels,
        asOfDate,
      });
      if (!check.eligible)
        throw new HttpError(
          409,
          "EVENT_NOT_ELIGIBLE",
          `${eventId}: ${check.reasons.join(", ")}`,
        );
      const simulated = simulateEffects(levels, e.effects);
      levels = simulated.levels;
      const session = e.sessions.find((s) => s.id === check.sessionId);
      if (session) asOfDate = session.date;
      steps.push({
        eventId,
        gains: simulated.gains,
        sessionId: check.sessionId,
      });
    }
    const target = p.goal ?? profile.goal;
    const reqs = target ? await requirements(pool, target) : [];
    ctx.send({
      baselineLevels: profile.effectiveLevels,
      projectedLevels: levels,
      unmetRequirements: gaps(levels, reqs),
      steps,
      persisted: false,
    });
    return true;
  }
  if (path === "/api/v1/me/plans" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT id,target_role AS "targetRole",target_grade AS "targetGrade",horizon_days AS "horizonDays",status,total_hours::float8 AS "totalHours",version,created_at AS "createdAt" FROM development_plans WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 100',
          [me(ctx)],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/me/plans" && method === "POST") {
    const employee = me(ctx);
    const p = z
      .object({ horizonDays: horizon, goal: goalSchema.optional() })
      .strict()
      .parse(await ctx.body());
    const result = await idempotent(
      ctx,
      "growth.plan.create",
      p,
      async (db) => {
        const { target, roadmap: r } = await planInput(
          db,
          employee,
          p.goal,
          p.horizonDays,
        );
        const row = (
          await db.query(
            "INSERT INTO development_plans(employee_id,target_role,target_grade,horizon_days,start_date,weekly_hours,formats,baseline_levels,projected_levels,unmet_requirements,total_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
            [
              employee,
              target.targetRole,
              target.targetGrade,
              p.horizonDays,
              r.startDate,
              r.weeklyHours,
              r.formats,
              JSON.stringify(r.baselineLevels),
              JSON.stringify(r.projectedLevels),
              JSON.stringify(r.unmetRequirements),
              r.totalHours,
            ],
          )
        ).rows[0];
        await writeSteps(db, row.id, r);
        await audit(
          db,
          user,
          "plan.create",
          "development_plan",
          row.id,
          { employeeId: employee },
          ctx.requestId,
        );
        return readPlan(db, row.id, employee);
      },
    );
    ctx.send(result, 201);
    return true;
  }
  const planMatch = path.match(
    /^\/api\/v1\/me\/plans\/([^/]+)(?:\/(regenerate|archive))?$/,
  );
  if (planMatch) {
    const id = uuid.parse(planMatch[1]);
    const employee = me(ctx);
    if (method === "GET" && !planMatch[2]) {
      ctx.send(await readPlan(pool, id, employee));
      return true;
    }
    if (method === "POST" && planMatch[2]) {
      const p = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(await ctx.body());
      const result = await idempotent(
        ctx,
        `growth.plan.${planMatch[2]}.${id}`,
        p,
        async (db) => {
          const row = (
            await db.query(
              "SELECT * FROM development_plans WHERE id=$1 AND employee_id=$2 FOR UPDATE",
              [id, employee],
            )
          ).rows[0];
          if (!row) missing();
          if (row.version !== p.expectedVersion)
            conflict("План изменился. Обновите страницу");
          if (planMatch[2] === "archive")
            await db.query(
              "UPDATE development_plans SET status='archived',version=version+1,updated_at=now() WHERE id=$1",
              [id],
            );
          else {
            if (row.status !== "active")
              conflict("Архивный план нельзя пересчитать");
            const { target, roadmap: r } = await planInput(
              db,
              employee,
              undefined,
              row.horizon_days,
            );
            await db.query(
              "UPDATE development_plans SET target_role=$2,target_grade=$3,start_date=$4,weekly_hours=$5,formats=$6,baseline_levels=$7,projected_levels=$8,unmet_requirements=$9,total_hours=$10,version=version+1,updated_at=now() WHERE id=$1",
              [
                id,
                target.targetRole,
                target.targetGrade,
                r.startDate,
                r.weeklyHours,
                r.formats,
                JSON.stringify(r.baselineLevels),
                JSON.stringify(r.projectedLevels),
                JSON.stringify(r.unmetRequirements),
                r.totalHours,
              ],
            );
            await writeSteps(db, id, r);
          }
          await audit(
            db,
            user,
            `plan.${planMatch[2]}`,
            "development_plan",
            id,
            { version: p.expectedVersion },
            ctx.requestId,
          );
          return readPlan(db, id, employee);
        },
      );
      ctx.send(result);
      return true;
    }
  }
  if (path === "/api/v1/colleagues" && method === "GET") {
    const q = z
      .string()
      .trim()
      .min(2)
      .max(80)
      .parse(ctx.url.searchParams.get("q"));
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    ctx.send(
      (
        await pool.query(
          'SELECT employee_id AS "employeeId",full_name AS "fullName",department FROM employees WHERE full_name ILIKE $1 ORDER BY full_name LIMIT 20',
          [`%${escaped}%`],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/mentors/me" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT employee_id AS "employeeId",headline,skill_ids AS "skillIds",capacity,enabled,approved_at AS "approvedAt" FROM mentor_profiles WHERE employee_id=$1',
          [me(ctx)],
        )
      ).rows[0] ?? null,
    );
    return true;
  }
  if (path === "/api/v1/mentors/me" && method === "PUT") {
    const employee = me(ctx);
    const p = z
      .object({
        headline: text(300),
        skillIds: z.array(text(80)).min(1).max(15),
        capacity: z.number().int().min(1).max(20),
        enabled: z.boolean(),
      })
      .strict()
      .parse(await ctx.body());
    await ensureSkillIds(pool, p.skillIds);
    const result = await transaction(pool, async (db) => {
      const row = (
        await db.query(
          'INSERT INTO mentor_profiles(employee_id,headline,skill_ids,capacity,enabled) VALUES($1,$2,$3,$4,$5) ON CONFLICT(employee_id) DO UPDATE SET headline=excluded.headline,skill_ids=excluded.skill_ids,capacity=excluded.capacity,enabled=excluded.enabled,approved_by=NULL,approved_at=NULL,updated_at=now() RETURNING employee_id AS "employeeId",headline,skill_ids AS "skillIds",capacity,enabled,approved_at AS "approvedAt"',
          [employee, p.headline, p.skillIds, p.capacity, p.enabled],
        )
      ).rows[0];
      await audit(
        db,
        user,
        "mentor.opt_in",
        "employee",
        employee,
        { enabled: p.enabled },
        ctx.requestId,
      );
      return row;
    });
    ctx.send(result);
    return true;
  }
  if (path === "/api/v1/mentors" && method === "GET") {
    const skill = ctx.url.searchParams.get("skillId");
    ctx.send(
      (
        await pool.query(
          `SELECT m.employee_id AS "employeeId",e.full_name AS "fullName",m.headline,m.skill_ids AS "skillIds",m.capacity,
   (SELECT count(*)::int FROM mentorship_requests r WHERE r.mentor_id=m.employee_id AND r.status='accepted') AS "activeMentees"
   FROM mentor_profiles m JOIN employees e USING(employee_id) WHERE m.enabled AND m.approved_at IS NOT NULL AND ($1::text IS NULL OR $1=ANY(m.skill_ids)) ORDER BY e.full_name LIMIT 100`,
          [skill],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/admin/mentors" && method === "GET") {
    requireRole(user, "hr", "admin");
    ctx.send(
      (
        await pool.query(
          "SELECT m.*,e.full_name FROM mentor_profiles m JOIN employees e USING(employee_id) ORDER BY m.updated_at DESC LIMIT 100",
        )
      ).rows,
    );
    return true;
  }
  const approval = path.match(/^\/api\/v1\/admin\/mentors\/([^/]+)$/);
  if (approval && method === "PATCH") {
    requireRole(user, "hr", "admin");
    const id = employeeId.parse(approval[1]);
    const p = z
      .object({ approved: z.boolean() })
      .strict()
      .parse(await ctx.body());
    await transaction(pool, async (db) => {
      const row = await db.query(
        "UPDATE mentor_profiles SET approved_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END,approved_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE employee_id=$1 RETURNING employee_id",
        [id, p.approved, user.id],
      );
      if (!row.rowCount) missing();
      await audit(db, user, "mentor.review", "employee", id, p, ctx.requestId);
    });
    ctx.send({ approved: p.approved });
    return true;
  }
  if (path === "/api/v1/me/mentorships" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT r.id,r.mentee_id AS "menteeId",r.mentor_id AS "mentorId",r.message,r.status,r.created_at AS "createdAt",a.full_name AS "menteeName",b.full_name AS "mentorName" FROM mentorship_requests r JOIN employees a ON a.employee_id=r.mentee_id JOIN employees b ON b.employee_id=r.mentor_id WHERE r.mentee_id=$1 OR r.mentor_id=$1 ORDER BY r.created_at DESC LIMIT 100',
          [me(ctx)],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/me/mentorships" && method === "POST") {
    const mentee = me(ctx);
    const p = z
      .object({ mentorId: employeeId, message: text(2000) })
      .strict()
      .parse(await ctx.body());
    if (p.mentorId === mentee)
      throw new HttpError(
        400,
        "SELF_REQUEST",
        "Нельзя выбрать себя наставником",
      );
    const result = await idempotent(ctx, "mentorship.create", p, async (db) => {
      const mentor = (
        await db.query(
          "SELECT * FROM mentor_profiles WHERE employee_id=$1 AND enabled AND approved_at IS NOT NULL FOR UPDATE",
          [p.mentorId],
        )
      ).rows[0];
      if (!mentor) missing("Наставник недоступен");
      if (
        (
          await db.query(
            "SELECT 1 FROM mentorship_requests WHERE mentee_id=$1 AND mentor_id=$2 AND status IN ('pending','accepted')",
            [mentee, p.mentorId],
          )
        ).rowCount
      )
        conflict("Активный запрос уже существует");
      const n = Number(
        (
          await db.query(
            "SELECT count(*) FROM mentorship_requests WHERE mentor_id=$1 AND status='accepted'",
            [p.mentorId],
          )
        ).rows[0].count,
      );
      if (n >= mentor.capacity) conflict("У наставника нет свободных мест");
      const r = (
        await db.query(
          "INSERT INTO mentorship_requests(mentee_id,mentor_id,message) VALUES($1,$2,$3) RETURNING id,status",
          [mentee, p.mentorId, p.message],
        )
      ).rows[0];
      await notify(
        db,
        p.mentorId,
        "mentorship",
        "Новый запрос на наставничество",
        `mentorship:${r.id}:pending`,
        "/mentorships",
      );
      return r;
    });
    ctx.send(result, 201);
    return true;
  }
  const mentorship = path.match(/^\/api\/v1\/me\/mentorships\/([^/]+)$/);
  if (mentorship && method === "PATCH") {
    const id = uuid.parse(mentorship[1]);
    const employee = me(ctx);
    const p = z
      .object({
        status: z.enum(["accepted", "declined", "cancelled", "completed"]),
      })
      .strict()
      .parse(await ctx.body());
    const result = await transaction(pool, async (db) => {
      const current = (
        await db.query(
          "SELECT * FROM mentorship_requests WHERE id=$1 AND (mentor_id=$2 OR mentee_id=$2)",
          [id, employee],
        )
      ).rows[0];
      if (!current) missing();
      const mentor = (
        await db.query(
          "SELECT * FROM mentor_profiles WHERE employee_id=$1 FOR UPDATE",
          [current.mentor_id],
        )
      ).rows[0];
      const r = (
        await db.query(
          "SELECT * FROM mentorship_requests WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (p.status === r.status) return { id, status: r.status };
      if (p.status === "accepted" || p.status === "declined") {
        if (employee !== r.mentor_id)
          throw new HttpError(
            403,
            "FORBIDDEN",
            "Ответить может только наставник",
          );
        if (r.status !== "pending") conflict("Запрос уже обработан");
      }
      if (p.status === "accepted") {
        if (!mentor?.enabled || !mentor.approved_at)
          conflict("Профиль наставника недоступен");
        const n = Number(
          (
            await db.query(
              "SELECT count(*) FROM mentorship_requests WHERE mentor_id=$1 AND status='accepted'",
              [r.mentor_id],
            )
          ).rows[0].count,
        );
        if (n >= mentor.capacity) conflict("У наставника нет свободных мест");
      }
      if (
        p.status === "cancelled" &&
        !["pending", "accepted"].includes(r.status)
      )
        conflict("Запрос уже закрыт");
      if (p.status === "completed" && r.status !== "accepted")
        conflict("Завершить можно только согласованное наставничество");
      await db.query(
        "UPDATE mentorship_requests SET status=$2,updated_at=now() WHERE id=$1",
        [id, p.status],
      );
      await notify(
        db,
        employee === r.mentor_id ? r.mentee_id : r.mentor_id,
        "mentorship",
        "Статус наставничества обновлён",
        `mentorship:${id}:${p.status}`,
        "/mentorships",
      );
      await audit(
        db,
        user,
        "mentorship.status",
        "mentorship",
        id,
        p,
        ctx.requestId,
      );
      return { id, status: p.status };
    });
    ctx.send(result);
    return true;
  }
  if (path === "/api/v1/me/tasks" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT id,title,skill_id AS "skillId",target_level AS "targetLevel",due_date::text AS "dueDate",status,created_at AS "createdAt",completed_at AS "completedAt" FROM personal_tasks WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 100',
          [me(ctx)],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/me/tasks" && method === "POST") {
    const employee = me(ctx);
    const p = z
      .object({
        title: text(200),
        skillId: text(80).optional(),
        targetLevel: z.number().int().min(1).max(5).optional(),
        dueDate: date.optional(),
      })
      .strict()
      .refine(
        (p) => Boolean(p.skillId) === (p.targetLevel !== undefined),
        "Навык и уровень задаются вместе",
      )
      .parse(await ctx.body());
    if (p.skillId) await ensureSkillIds(pool, [p.skillId]);
    const result = await idempotent(
      ctx,
      "task.create",
      p,
      async (db) =>
        (
          await db.query(
            "INSERT INTO personal_tasks(employee_id,title,skill_id,target_level,due_date) VALUES($1,$2,$3,$4,$5) RETURNING id,title,status",
            [
              employee,
              p.title,
              p.skillId ?? null,
              p.targetLevel ?? null,
              p.dueDate ?? null,
            ],
          )
        ).rows[0],
    );
    ctx.send(result, 201);
    return true;
  }
  const task = path.match(/^\/api\/v1\/me\/tasks\/([^/]+)$/);
  if (task && method === "PATCH") {
    const employee = me(ctx);
    const id = uuid.parse(task[1]);
    const p = z
      .object({ status: z.enum(["completed", "cancelled"]) })
      .strict()
      .parse(await ctx.body());
    const result = await transaction(pool, async (db) => {
      const r = (
        await db.query(
          "SELECT * FROM personal_tasks WHERE id=$1 AND employee_id=$2 FOR UPDATE",
          [id, employee],
        )
      ).rows[0];
      if (!r) missing();
      if (r.status === p.status) return { id, status: r.status };
      if (r.status !== "active") conflict("Задание уже закрыто");
      if (p.status === "completed" && r.skill_id) {
        const profile = await loadCareer(db, employee);
        if ((profile.effectiveLevels[r.skill_id] ?? 0) < r.target_level)
          conflict("Целевой уровень навыка ещё не достигнут");
      }
      await db.query(
        "UPDATE personal_tasks SET status=$2,completed_at=CASE WHEN $2='completed' THEN now() ELSE NULL END WHERE id=$1",
        [id, p.status],
      );
      return { id, status: p.status, pointsAwarded: 0 };
    });
    ctx.send(result);
    return true;
  }
  if (path === "/api/v1/me/achievements" && method === "GET") {
    const employee = me(ctx);
    const n = Number(
      (
        await pool.query(
          "SELECT count(DISTINCT p.event_id) AS n FROM participations p JOIN events e USING(event_id) WHERE p.employee_id=$1 AND p.status='completed' AND NOT e.mandatory",
          [employee],
        )
      ).rows[0].n,
    );
    const profile = await loadCareer(pool, employee);
    const definitions = [
      { id: "first_learning", title: "Первый шаг", target: 1 },
      { id: "five_activities", title: "Пять шагов развития", target: 5 },
      { id: "ten_activities", title: "Продолжаю учиться", target: 10 },
    ];
    ctx.send({
      visibility: "private",
      achievements: definitions.map((d) => ({
        ...d,
        current: Math.min(n, d.target),
        achieved: n >= d.target,
      })),
      goalReady:
        profile.requirements.length > 0 &&
        gaps(profile.effectiveLevels, profile.requirements).length === 0,
      pointsAwarded: 0,
    });
    return true;
  }
  if (path === "/api/v1/me/recognitions" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          'SELECT r.id,r.sender_id AS "senderId",r.recipient_id AS "recipientId",r.message,r.status,a.full_name AS "senderName",b.full_name AS "recipientName",r.created_at AS "createdAt" FROM recognitions r JOIN employees a ON a.employee_id=r.sender_id JOIN employees b ON b.employee_id=r.recipient_id WHERE (r.sender_id=$1 OR r.recipient_id=$1) AND r.status<>\'hidden\' ORDER BY r.created_at DESC LIMIT 100',
          [me(ctx)],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/me/recognitions" && method === "POST") {
    const sender = me(ctx);
    const p = z
      .object({ recipientId: employeeId, message: text(1000) })
      .strict()
      .parse(await ctx.body());
    if (sender === p.recipientId)
      throw new HttpError(
        400,
        "SELF_RECOGNITION",
        "Благодарность адресуется коллеге",
      );
    const result = await idempotent(
      ctx,
      "recognition.create",
      p,
      async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `recognition:${sender}`,
        ]);
        if (
          !(
            await db.query("SELECT 1 FROM employees WHERE employee_id=$1", [
              p.recipientId,
            ])
          ).rowCount
        )
          missing("Получатель не найден");
        const n = Number(
          (
            await db.query(
              "SELECT count(*) FROM recognitions WHERE sender_id=$1 AND created_at>now()-interval '1 day'",
              [sender],
            )
          ).rows[0].count,
        );
        if (n >= 5)
          throw new HttpError(
            429,
            "RATE_LIMITED",
            "Не более пяти благодарностей в день",
          );
        const r = (
          await db.query(
            "INSERT INTO recognitions(sender_id,recipient_id,message) VALUES($1,$2,$3) RETURNING id,status",
            [sender, p.recipientId, p.message],
          )
        ).rows[0];
        await notify(
          db,
          p.recipientId,
          "recognition",
          "Вам отправили благодарность",
          `recognition:${r.id}`,
          "/recognitions",
        );
        return r;
      },
    );
    ctx.send(result, 201);
    return true;
  }
  const recognition = path.match(/^\/api\/v1\/me\/recognitions\/([^/]+)$/);
  if (recognition && method === "PATCH") {
    const id = uuid.parse(recognition[1]);
    const recipient = me(ctx);
    const p = z
      .object({ status: z.enum(["accepted", "declined", "reported"]) })
      .strict()
      .parse(await ctx.body());
    const r = await pool.query(
      "UPDATE recognitions SET status=$3,updated_at=now() WHERE id=$1 AND recipient_id=$2 AND status IN ('pending','accepted') RETURNING id,status",
      [id, recipient, p.status],
    );
    if (!r.rowCount) conflict("Благодарность недоступна или уже обработана");
    ctx.send(r.rows[0]);
    return true;
  }
  if (path === "/api/v1/admin/recognitions" && method === "GET") {
    requireRole(user, "hr", "admin");
    ctx.send(
      (
        await pool.query(
          'SELECT id,sender_id AS "senderId",recipient_id AS "recipientId",message,status,created_at AS "createdAt" FROM recognitions WHERE status=\'reported\' ORDER BY created_at LIMIT 100',
        )
      ).rows,
    );
    return true;
  }
  const moderation = path.match(/^\/api\/v1\/admin\/recognitions\/([^/]+)$/);
  if (moderation && method === "PATCH") {
    requireRole(user, "hr", "admin");
    const id = uuid.parse(moderation[1]);
    const p = z
      .object({ note: text(1000) })
      .strict()
      .parse(await ctx.body());
    await transaction(pool, async (db) => {
      const r = await db.query(
        "UPDATE recognitions SET status='hidden',moderation_note=$2,moderated_by=$3,updated_at=now() WHERE id=$1 AND status='reported' RETURNING id",
        [id, p.note, user.id],
      );
      if (!r.rowCount) missing();
      await audit(
        db,
        user,
        "recognition.moderate",
        "recognition",
        id,
        p,
        ctx.requestId,
      );
    });
    ctx.send({ id, status: "hidden" });
    return true;
  }
  if (path === "/api/v1/team-challenges" && method === "GET") {
    const employee = me(ctx);
    ctx.send(
      (
        await pool.query(
          `SELECT c.id,c.title,c.description,c.starts_on::text AS "startsOn",c.ends_on::text AS "endsOn",c.status,
   EXISTS(SELECT 1 FROM team_challenge_members m WHERE m.challenge_id=c.id AND m.employee_id=$1) AS joined,
   (SELECT count(*)::int FROM team_challenge_members m WHERE m.challenge_id=c.id) AS "memberCount",
   (SELECT count(*)::int FROM team_challenge_members m WHERE m.challenge_id=c.id AND NOT EXISTS(SELECT 1 FROM team_challenge_events ce WHERE ce.challenge_id=c.id AND NOT EXISTS(SELECT 1 FROM participations p WHERE p.employee_id=m.employee_id AND p.event_id=ce.event_id AND p.status='completed' AND p.date BETWEEN c.starts_on AND c.ends_on))) AS "completedMembers",
   (SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',ce.event_id,'title',e.title,'completed',EXISTS(SELECT 1 FROM participations p WHERE p.employee_id=$1 AND p.event_id=ce.event_id AND p.status='completed' AND p.date BETWEEN c.starts_on AND c.ends_on))),'[]'::jsonb) FROM team_challenge_events ce JOIN events e USING(event_id) WHERE ce.challenge_id=c.id) AS events
   FROM team_challenges c WHERE c.manager_id IS NULL OR c.manager_id=$1 OR c.manager_id=(SELECT manager_id FROM employees WHERE employee_id=$1) ORDER BY c.created_at DESC LIMIT 100`,
          [employee],
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/team-challenges" && method === "POST") {
    requireRole(user, "manager", "hr", "admin");
    const p = z
      .object({
        title: text(200),
        description: text(2000),
        startsOn: date,
        endsOn: date,
        eventIds: z
          .array(text(80))
          .min(1)
          .max(10)
          .refine((a) => new Set(a).size === a.length),
      })
      .strict()
      .refine((p) => p.endsOn >= p.startsOn, "Дата окончания раньше начала")
      .parse(await ctx.body());
    const result = await idempotent(ctx, "challenge.create", p, async (db) => {
      const events = (
        await db.query(
          "SELECT event_id,mandatory,is_active FROM events WHERE event_id=ANY($1::text[])",
          [p.eventIds],
        )
      ).rows;
      if (
        events.length !== p.eventIds.length ||
        events.some((e) => e.mandatory || !e.is_active)
      )
        throw new HttpError(
          400,
          "VOLUNTARY_ONLY",
          "Нужны активные добровольные мероприятия",
        );
      const r = (
        await db.query(
          "INSERT INTO team_challenges(title,description,created_by,manager_id,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,status",
          [
            p.title,
            p.description,
            user.id,
            user.role === "manager" ? me(ctx) : null,
            p.startsOn,
            p.endsOn,
          ],
        )
      ).rows[0];
      for (const eventId of p.eventIds)
        await db.query(
          "INSERT INTO team_challenge_events(challenge_id,event_id) VALUES($1,$2)",
          [r.id, eventId],
        );
      await audit(
        db,
        user,
        "challenge.create",
        "team_challenge",
        r.id,
        p,
        ctx.requestId,
      );
      return r;
    });
    ctx.send(result, 201);
    return true;
  }
  const challenge = path.match(
    /^\/api\/v1\/team-challenges\/([^/]+)(?:\/(join|leave|archive))$/,
  );
  if (challenge && method === "POST") {
    const id = uuid.parse(challenge[1]);
    const action = challenge[2];
    await transaction(pool, async (db) => {
      const c = (
        await db.query(
          'SELECT *,ends_on::text AS "endDate" FROM team_challenges WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!c) missing();
      if (action === "archive") {
        if (c.created_by !== user.id && !["hr", "admin"].includes(user.role))
          throw new HttpError(403, "FORBIDDEN", "Недостаточно прав");
        await db.query(
          "UPDATE team_challenges SET status='archived' WHERE id=$1",
          [id],
        );
        await audit(
          db,
          user,
          "challenge.archive",
          "team_challenge",
          id,
          {},
          ctx.requestId,
        );
        return;
      }
      const employee = me(ctx);
      if (
        c.manager_id &&
        c.manager_id !== employee &&
        !(
          await db.query(
            "SELECT 1 FROM employees WHERE employee_id=$1 AND manager_id=$2",
            [employee, c.manager_id],
          )
        ).rowCount
      )
        missing();
      if (action === "leave") {
        await db.query(
          "DELETE FROM team_challenge_members WHERE challenge_id=$1 AND employee_id=$2",
          [id, employee],
        );
        return;
      }
      if (c.status !== "active" || c.endDate < (await snapshotDate(db)))
        conflict("Активность завершена");
      await db.query(
        "INSERT INTO team_challenge_members(challenge_id,employee_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, employee],
      );
    });
    ctx.send({ id, action });
    return true;
  }
  if (path === "/api/v1/rewards/catalog" && method === "GET") {
    ctx.send(
      (
        await pool.query(
          "SELECT id,title,description,cost,stock FROM reward_catalog WHERE active AND (SELECT enabled FROM reward_policy WHERE singleton) ORDER BY cost,title LIMIT 100",
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/me/rewards/sync" && method === "POST") {
    const employee = me(ctx);
    const p = z
      .object({})
      .strict()
      .parse(await ctx.body());
    ctx.send(
      await idempotent(ctx, "reward.sync", p, (db) =>
        syncRewardLedger(db, employee),
      ),
    );
    return true;
  }
  if (path === "/api/v1/me/rewards" && method === "GET") {
    const employee = me(ctx);
    const result = await transaction(pool, async (db) => {
      const policy = (
        await db.query(
          "SELECT enabled,rules_text,points_per_event,monthly_cap FROM reward_policy WHERE singleton",
        )
      ).rows[0];
      const balance = Number(
        (
          await db.query(
            "SELECT coalesce(sum(delta),0)::int AS balance FROM reward_ledger WHERE employee_id=$1",
            [employee],
          )
        ).rows[0].balance,
      );
      const wallet = {
        enabled: policy.enabled,
        balance,
        spendableBalance: Math.max(0, balance),
        rules: policy.rules_text,
        pointsPerEvent: policy.points_per_event,
        monthlyCap: policy.monthly_cap,
      };
      const ledger = (
        await db.query(
          'SELECT id,delta,kind,event_id AS "eventId",redemption_id AS "redemptionId",created_at AS "createdAt" FROM reward_ledger WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 100',
          [employee],
        )
      ).rows;
      const redemptions = (
        await db.query(
          'SELECT r.id,r.reward_id AS "rewardId",c.title,r.cost,r.status,r.created_at AS "createdAt" FROM reward_redemptions r JOIN reward_catalog c ON c.id=r.reward_id WHERE r.employee_id=$1 ORDER BY r.created_at DESC LIMIT 100',
          [employee],
        )
      ).rows;
      return { ...wallet, ledger, redemptions };
    });
    ctx.send(result);
    return true;
  }
  if (path === "/api/v1/me/rewards/redeem" && method === "POST") {
    const employee = me(ctx);
    const p = z
      .object({ rewardId: uuid })
      .strict()
      .parse(await ctx.body());
    const result = await idempotent(ctx, "reward.redeem", p, async (db) => {
      const wallet = await syncRewardLedger(db, employee);
      if (!wallet.enabled) conflict("Награды ещё не включены");
      const reward = (
        await db.query(
          "SELECT * FROM reward_catalog WHERE id=$1 AND active FOR UPDATE",
          [p.rewardId],
        )
      ).rows[0];
      if (!reward) missing("Награда недоступна");
      if (reward.stock === 0) conflict("Награды закончились");
      if (wallet.spendableBalance < reward.cost)
        conflict("Недостаточно баллов");
      const r = (
        await db.query(
          "INSERT INTO reward_redemptions(employee_id,reward_id,cost) VALUES($1,$2,$3) RETURNING id,status,cost",
          [employee, reward.id, reward.cost],
        )
      ).rows[0];
      await db.query(
        "INSERT INTO reward_ledger(employee_id,delta,kind,redemption_id,source_key) VALUES($1,$2,'redeemed',$3,$4)",
        [employee, -reward.cost, r.id, `redeem:${r.id}`],
      );
      if (reward.stock !== null)
        await db.query("UPDATE reward_catalog SET stock=stock-1 WHERE id=$1", [
          reward.id,
        ]);
      await audit(
        db,
        user,
        "reward.redeem",
        "redemption",
        r.id,
        { rewardId: reward.id, cost: r.cost },
        ctx.requestId,
      );
      return r;
    });
    ctx.send(result, 201);
    return true;
  }
  if (path === "/api/v1/admin/rewards/policy" && method === "GET") {
    requireRole(user, "admin");
    ctx.send(
      (
        await pool.query(
          'SELECT enabled,points_per_event AS "pointsPerEvent",monthly_cap AS "monthlyCap",rules_text AS "rulesText",effective_from AS "effectiveFrom",updated_at AS "updatedAt" FROM reward_policy',
        )
      ).rows[0],
    );
    return true;
  }
  if (path === "/api/v1/admin/rewards/policy" && method === "PUT") {
    requireRole(user, "admin");
    const p = z
      .object({
        enabled: z.boolean(),
        pointsPerEvent: z.number().int().min(1).max(1000),
        monthlyCap: z.number().int().min(1).max(10000),
        rulesText: text(4000),
      })
      .strict()
      .refine(
        (p) => p.monthlyCap >= p.pointsPerEvent,
        "Месячный лимит меньше одного начисления",
      )
      .parse(await ctx.body());
    await transaction(pool, async (db) => {
      await db.query(
        "UPDATE reward_policy SET enabled=$1,points_per_event=$2,monthly_cap=$3,rules_text=$4,effective_from=CASE WHEN $1 AND NOT enabled THEN now() ELSE effective_from END,approved_by=$5,updated_at=now() WHERE singleton",
        [p.enabled, p.pointsPerEvent, p.monthlyCap, p.rulesText, user.id],
      );
      await audit(
        db,
        user,
        "reward.policy",
        "reward_policy",
        "singleton",
        p,
        ctx.requestId,
      );
    });
    ctx.send(p);
    return true;
  }
  if (path === "/api/v1/admin/rewards/catalog" && method === "GET") {
    requireRole(user, "hr", "admin");
    ctx.send(
      (
        await pool.query(
          "SELECT * FROM reward_catalog ORDER BY created_at DESC LIMIT 100",
        )
      ).rows,
    );
    return true;
  }
  if (path === "/api/v1/admin/rewards/catalog" && method === "POST") {
    requireRole(user, "admin");
    const p = z
      .object({
        title: text(200),
        description: text(2000),
        cost: z.number().int().min(1).max(100000),
        stock: z.number().int().min(0).max(100000).nullable(),
      })
      .strict()
      .parse(await ctx.body());
    const result = await idempotent(
      ctx,
      "reward.catalog.create",
      p,
      async (db) => {
        const r = (
          await db.query(
            "INSERT INTO reward_catalog(title,description,cost,stock) VALUES($1,$2,$3,$4) RETURNING id,title,cost,stock,active",
            [p.title, p.description, p.cost, p.stock],
          )
        ).rows[0];
        await audit(
          db,
          user,
          "reward.catalog.create",
          "reward",
          r.id,
          p,
          ctx.requestId,
        );
        return r;
      },
    );
    ctx.send(result, 201);
    return true;
  }
  const rewardItem = path.match(
    /^\/api\/v1\/admin\/rewards\/catalog\/([^/]+)$/,
  );
  if (rewardItem && method === "PATCH") {
    requireRole(user, "admin");
    const id = uuid.parse(rewardItem[1]);
    const p = z
      .object({
        title: text(200),
        description: text(2000),
        cost: z.number().int().min(1).max(100000),
        stock: z.number().int().min(0).max(100000).nullable(),
        active: z.boolean(),
      })
      .strict()
      .parse(await ctx.body());
    await transaction(pool, async (db) => {
      const r = await db.query(
        "UPDATE reward_catalog SET title=$2,description=$3,cost=$4,stock=$5,active=$6,updated_at=now() WHERE id=$1 RETURNING id",
        [id, p.title, p.description, p.cost, p.stock, p.active],
      );
      if (!r.rowCount) missing();
      await audit(
        db,
        user,
        "reward.catalog.update",
        "reward",
        id,
        p,
        ctx.requestId,
      );
    });
    ctx.send({ id, ...p });
    return true;
  }
  if (path === "/api/v1/admin/rewards/redemptions" && method === "GET") {
    requireRole(user, "hr", "admin");
    ctx.send(
      (
        await pool.query(
          'SELECT r.id,r.employee_id AS "employeeId",e.full_name AS "fullName",r.reward_id AS "rewardId",c.title,r.cost,r.status,r.created_at AS "createdAt" FROM reward_redemptions r JOIN employees e USING(employee_id) JOIN reward_catalog c ON c.id=r.reward_id ORDER BY r.created_at DESC LIMIT 100',
        )
      ).rows,
    );
    return true;
  }
  const redemption = path.match(
    /^\/api\/v1\/(me|admin)\/rewards\/redemptions\/([^/]+)$/,
  );
  if (redemption && method === "PATCH") {
    const id = uuid.parse(redemption[2]);
    const isAdmin = redemption[1] === "admin";
    if (isAdmin) requireRole(user, "hr", "admin");
    const p = z
      .object({ status: z.enum(["fulfilled", "cancelled"]) })
      .strict()
      .parse(await ctx.body());
    if (!isAdmin && p.status !== "cancelled")
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Выдачу подтверждает ответственный",
      );
    const result = await transaction(pool, async (db) => {
      const ref = (
        await db.query(
          "SELECT employee_id FROM reward_redemptions WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!ref || (!isAdmin && ref.employee_id !== me(ctx))) missing();
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `rewards:${ref.employee_id}`,
      ]);
      const r = (
        await db.query(
          "SELECT * FROM reward_redemptions WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (r.status === p.status) return { id, status: r.status };
      if (r.status !== "pending") conflict("Заявка уже закрыта");
      await db.query(
        "UPDATE reward_redemptions SET status=$2,fulfilled_by=$3,updated_at=now() WHERE id=$1",
        [id, p.status, isAdmin ? user.id : null],
      );
      if (p.status === "cancelled") {
        await db.query(
          "INSERT INTO reward_ledger(employee_id,delta,kind,redemption_id,source_key) VALUES($1,$2,'refunded',$3,$4)",
          [r.employee_id, r.cost, id, `refund:${id}`],
        );
        await db.query(
          "UPDATE reward_catalog SET stock=stock+1 WHERE id=$1 AND stock IS NOT NULL",
          [r.reward_id],
        );
      }
      await audit(
        db,
        user,
        `reward.${p.status}`,
        "redemption",
        id,
        {},
        ctx.requestId,
      );
      await notify(
        db,
        r.employee_id,
        "reward",
        "Статус награды обновлён",
        `reward:${id}:${p.status}`,
        "/rewards",
      );
      return { id, status: p.status };
    });
    ctx.send(result);
    return true;
  }
  return false;
}
