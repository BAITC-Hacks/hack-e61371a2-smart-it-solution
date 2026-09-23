import { z } from "zod";
import type { Pool } from "pg";
import { scope } from "./auth.js";
import {
  audit,
  HttpError,
  idempotent,
  requireRole,
  snapshotDate,
  type RouteContext,
} from "./http.js";
import { loadCareer, computeRecommendations, loadEvents } from "./career.js";

const filters = z.object({
  department: z.string().max(120).optional(),
  role: z.string().max(120).optional(),
  grade: z.enum(["Junior", "Middle", "Senior", "Lead"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
const cache = new WeakMap<Pool, Map<string, { at: number; value: unknown }>>();
async function mapLimited<T, R>(values: T[], fn: (v: T) => Promise<R>) {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, values.length) }, async () => {
      while (next < values.length) {
        const i = next++;
        results[i] = await fn(values[i]!);
      }
    }),
  );
  return results;
}
export async function hrOverview(ctx: RouteContext) {
  const f = filters.parse(Object.fromEntries(ctx.url.searchParams));
  if (f.from && f.to && f.from > f.to)
    throw new HttpError(400, "INVALID_PERIOD", "Начало периода позже конца");
  const snapshot = await snapshotDate(ctx.pool);
  const to = f.to ?? snapshot;
  const from =
    f.from ??
    new Date(Date.parse(snapshot + "T00:00:00Z") - 90 * 86400000)
      .toISOString()
      .slice(0, 10);
  const access = scope(ctx.user);
  const values = [...access.values];
  const where = [access.sql];
  for (const [key, value] of Object.entries({
    department: f.department,
    role: f.role,
    grade: f.grade,
  }))
    if (value) {
      values.push(value);
      where.push(`e.${key}=$${values.length}`);
    }
  const employees = (
    await ctx.pool.query(
      `SELECT e.employee_id AS id,e.full_name AS name,e.role,e.grade,e.department FROM employees e WHERE ${where.join(" AND ")} ORDER BY e.employee_id`,
      values,
    )
  ).rows;
  const revision = (
    await ctx.pool.query(
      "SELECT count(*)::text AS n,max(created_at)::text AS latest FROM audit_log",
    )
  ).rows[0];
  const key = JSON.stringify([
    f,
    ctx.user.role,
    ctx.user.employeeId,
    employees.map((e) => e.id),
    revision,
  ]);
  let entries = cache.get(ctx.pool);
  if (!entries) {
    entries = new Map();
    cache.set(ctx.pool, entries);
  }
  const cached = entries.get(key);
  if (cached && Date.now() - cached.at < 15000) return cached.value;
  const catalog = await loadEvents(ctx.pool);
  const rows = await mapLimited(employees, async (e) => {
    const r = await computeRecommendations(ctx.pool, e.id, 3, catalog);
    return {
      employee: e,
      profile: r.profile,
      candidates: r.candidates,
      excluded: r.excluded,
    };
  });
  const gaps = new Map<
    string,
    {
      skillId: string;
      name: string;
      employees: number;
      totalGap: number;
      criticalEmployees: number;
    }
  >();
  for (const r of rows)
    for (const s of r.profile.skills)
      if (s.gap > 0) {
        const value = gaps.get(s.skillId) ?? {
          skillId: s.skillId,
          name: s.name,
          employees: 0,
          totalGap: 0,
          criticalEmployees: 0,
        };
        value.employees++;
        value.totalGap += s.gap;
        if (s.isCritical) value.criticalEmployees++;
        gaps.set(s.skillId, value);
      }
  const ids = employees.map((e) => e.id);
  const participation = (
    await ctx.pool.query(
      `SELECT ev.event_id AS "eventId",ev.title,ev.mandatory,
 count(*)::int AS records,count(DISTINCT p.employee_id)::int AS participants,
 count(*) FILTER(WHERE p.status='registered')::int AS registered,
 count(*) FILTER(WHERE p.status='in_progress')::int AS started,
 count(*) FILTER(WHERE p.status='completed')::int AS completed,
 count(*) FILTER(WHERE p.status IN ('dropped','no_show','declined','overdue'))::int AS incomplete,
 round(avg(p.feedback_rating),2)::float AS "averageRating"
 FROM participations p JOIN events ev USING(event_id) WHERE p.employee_id=ANY($1::text[]) AND p.date BETWEEN $2 AND $3
 GROUP BY ev.event_id ORDER BY completed DESC,ev.event_id`,
      [ids, from, to],
    )
  ).rows;
  const noNextStep = rows
    .filter((r) => !r.candidates.length)
    .map((r) => ({
      ...r.employee,
      reasons: r.excluded
        .flatMap((e) => e.reasons)
        .filter((v, i, a) => a.indexOf(v) === i),
    }));
  const programGains = new Map<
    string,
    {
      observedSkillPoints: number;
      observedGapClosure: number;
      employees: Set<string>;
    }
  >();
  for (const r of rows)
    for (const change of r.profile.changes)
      if (change.date >= from && change.date <= to) {
        const item = programGains.get(change.eventId) ?? {
          observedSkillPoints: 0,
          observedGapClosure: 0,
          employees: new Set<string>(),
        };
        const required =
          r.profile.requirements.find((q) => q.skillId === change.skillId)
            ?.requiredLevel ?? 0;
        item.observedSkillPoints += change.to - change.from;
        item.observedGapClosure +=
          Math.min(required, change.to) - Math.min(required, change.from);
        item.employees.add(r.employee.id);
        programGains.set(change.eventId, item);
      }
  const programs = participation.map((p) => {
    const gain = programGains.get(p.eventId);
    return {
      ...p,
      observedSkillPoints: gain?.observedSkillPoints ?? 0,
      observedGapClosure: gain?.observedGapClosure ?? 0,
      employeesWithObservedGain: gain?.employees.size ?? 0,
      methodology:
        "Modeled gains from completion snapshots after each employee last assessment, relative to current goal; not an independent causal evaluation",
    };
  });
  const result = {
    asOfDate: snapshot,
    period: { from, to },
    scope: ctx.user.role === "manager" ? "team" : "organization",
    employees: employees.length,
    skillGaps: [...gaps.values()].sort(
      (a, b) =>
        b.criticalEmployees - a.criticalEmployees || b.totalGap - a.totalGap,
    ),
    noNextStep,
    participation,
    programs,
    summaries: rows.map((r) => ({
      ...r.employee,
      goal: r.profile.goal,
      gapTotal: r.profile.skills.reduce((sum, s) => sum + s.gap, 0),
      nextSteps: r.candidates.map((c) => c.eventId),
    })),
    methodology:
      "Effective skills after last assessment. Participation period applies to activity records, not current skill gaps. No-next-step is computed from current eligibility.",
  };
  if (entries.size > 30) entries.clear();
  entries.set(key, { at: Date.now(), value: result });
  return result;
}
export async function handleAnalytics(ctx: RouteContext): Promise<boolean> {
  const { path, method, pool, user } = ctx;
  if (!path.startsWith("/api/v1/hr/") && !path.startsWith("/api/v1/manager/"))
    return false;
  if (path.startsWith("/api/v1/manager/"))
    requireRole(user, "manager", "hr", "admin");
  else requireRole(user, "hr", "admin");
  if (
    method === "GET" &&
    [
      "/api/v1/hr/overview",
      "/api/v1/hr/skill-gaps",
      "/api/v1/hr/participation",
      "/api/v1/hr/no-next-step",
      "/api/v1/manager/overview",
      "/api/v1/hr/programs",
    ].includes(path)
  ) {
    const data = (await hrOverview(ctx)) as {
      skillGaps: unknown;
      participation: unknown;
      programs: unknown;
      noNextStep: unknown;
    };
    ctx.send(
      path.endsWith("/skill-gaps")
        ? data.skillGaps
        : path.endsWith("/participation")
          ? data.participation
          : path.endsWith("/programs")
            ? data.programs
            : path.endsWith("/no-next-step")
              ? data.noNextStep
              : data,
    );
    return true;
  }
  if (method === "GET" && path === "/api/v1/hr/funnel") {
    const f = filters.parse(Object.fromEntries(ctx.url.searchParams));
    const to = f.to ?? (await snapshotDate(pool)),
      from =
        f.from ??
        new Date(Date.parse(to + "T00:00:00Z") - 90 * 86400000)
          .toISOString()
          .slice(0, 10);
    if (from > to)
      throw new HttpError(400, "INVALID_PERIOD", "Начало периода позже конца");
    const rows = (
      await pool.query(
        `SELECT a.stage,count(*)::int AS records,count(DISTINCT a.employee_id)::int AS employees,
   count(DISTINCT (a.employee_id,a.event_id))::int AS "employeeEventPairs"
   FROM career_activity_log a JOIN employees e USING(employee_id) WHERE a.date BETWEEN $1 AND $2
   AND ($3::text IS NULL OR e.department=$3) AND ($4::text IS NULL OR e.role=$4) AND ($5::text IS NULL OR e.grade=$5) GROUP BY a.stage`,
        [from, to, f.department ?? null, f.role ?? null, f.grade ?? null],
      )
    ).rows;
    ctx.send({
      period: { from, to },
      stages: ["offered", "registered", "started", "completed"].map(
        (stage) =>
          rows.find((r) => r.stage === stage) ?? {
            stage,
            records: 0,
            employees: 0,
            employeeEventPairs: 0,
          },
      ),
      methodology:
        "Observed platform stage events within period; imported historical completions do not imply an offer, registration or start. Counts are not a cohort conversion rate.",
    });
    return true;
  }
  if (method === "GET" && path === "/api/v1/hr/trends") {
    const f = filters.parse(Object.fromEntries(ctx.url.searchParams));
    const values: unknown[] = [];
    const conditions = ["TRUE"];
    if (f.from && f.to && f.from > f.to)
      throw new HttpError(400, "INVALID_PERIOD", "Начало периода позже конца");
    for (const [k, v] of Object.entries({
      department: f.department,
      role: f.role,
      grade: f.grade,
    }))
      if (v) {
        values.push(v);
        conditions.push(`e.${k}=$${values.length}`);
      }
    if (f.from) {
      values.push(f.from);
      conditions.push(`s.assessed_on>=$${values.length}`);
    }
    if (f.to) {
      values.push(f.to);
      conditions.push(`s.assessed_on<=$${values.length}`);
    }
    const rows = (
      await pool.query(
        `SELECT s.employee_id AS "employeeId",s.assessed_on::text AS date,s.skills,s.captured_at AS "capturedAt" FROM assessment_snapshots s JOIN employees e USING(employee_id) WHERE ${conditions.join(" AND ")} ORDER BY s.assessed_on,s.captured_at`,
        values,
      )
    ).rows;
    ctx.send({
      snapshots: rows,
      methodology:
        "Imported assessment baselines, not inferred learning gains. Same-day corrections replace the earlier assessment when plotting.",
      hasLongitudinalData: rows.some((r, i) =>
        rows
          .slice(0, i)
          .some((p) => p.employeeId === r.employeeId && p.date !== r.date),
      ),
    });
    return true;
  }
  if (method === "POST" && path === "/api/v1/hr/team-simulation") {
    const payload = z
      .object({
        employeeIds: z.array(z.string().min(1)).min(1).max(100),
        eventIds: z.array(z.string().min(1)).min(1).max(30),
      })
      .strict()
      .parse(await ctx.body());
    const unique = [...new Set(payload.eventIds)];
    const events = (
      await pool.query(
        "SELECT event_id FROM events WHERE event_id=ANY($1::text[])",
        [unique],
      )
    ).rows;
    if (events.length !== unique.length)
      throw new HttpError(422, "UNKNOWN_EVENT", "Неизвестное мероприятие");
    const effects = (
      await pool.query(
        "SELECT event_id,skill_id,gain,max_level FROM event_skill_effects WHERE event_id=ANY($1::text[])",
        [unique],
      )
    ).rows;
    const result = await mapLimited(
      [...new Set(payload.employeeIds)],
      async (id) => {
        const p = await loadCareer(pool, id);
        const levels = { ...p.effectiveLevels };
        for (const eventId of unique)
          for (const e of effects.filter((x) => x.event_id === eventId)) {
            const old = levels[e.skill_id] ?? 0;
            levels[e.skill_id] = Math.min(
              5,
              old + Math.max(0, Math.min(e.gain, e.max_level - old)),
            );
          }
        return {
          employeeId: id,
          gapBefore: p.skills.reduce((s, x) => s + x.gap, 0),
          gapAfter: p.requirements.reduce(
            (s, r) =>
              s + Math.max(0, r.requiredLevel - (levels[r.skillId] ?? 0)),
            0,
          ),
        };
      },
    );
    ctx.send({
      simulation: true,
      eligibilityChecked: false,
      assumption:
        "Hypothetical effect if every listed event is completed; enrollment eligibility must be checked separately",
      employees: result,
    });
    return true;
  }
  if (method === "GET" && path === "/api/v1/hr/engagement-signals") {
    const snapshot = await snapshotDate(pool);
    const f = filters.parse(Object.fromEntries(ctx.url.searchParams));
    const to = f.to ?? snapshot,
      from =
        f.from ??
        new Date(Date.parse(to + "T00:00:00Z") - 90 * 86400000)
          .toISOString()
          .slice(0, 10);
    if (from > to)
      throw new HttpError(400, "INVALID_PERIOD", "Начало периода позже конца");
    const rows = (
      await pool.query(
        `SELECT e.employee_id AS "employeeId",e.full_name AS name,
 count(p.id) FILTER(WHERE NOT ev.mandatory)::int AS "voluntaryRecords",
 count(p.id) FILTER(WHERE NOT ev.mandatory AND p.status='completed')::int AS completed,
 count(p.id) FILTER(WHERE NOT ev.mandatory AND p.status IN ('no_show','dropped'))::int AS interruptions
 FROM employees e LEFT JOIN participations p ON p.employee_id=e.employee_id AND p.date BETWEEN $1::date AND $2::date
 LEFT JOIN events ev USING(event_id) WHERE ($3::text IS NULL OR e.department=$3) AND ($4::text IS NULL OR e.role=$4) AND ($5::text IS NULL OR e.grade=$5) GROUP BY e.employee_id ORDER BY e.employee_id`,
        [from, to, f.department ?? null, f.role ?? null, f.grade ?? null],
      )
    ).rows;
    ctx.send({
      asOfDate: snapshot,
      period: { from, to },
      signals: rows.map((r) => ({
        ...r,
        signal:
          r.voluntaryRecords === 0
            ? "no_recent_voluntary_activity"
            : r.interruptions >= 2
              ? "repeated_interruptions"
              : "none",
      })),
      usage:
        "A discussion signal only; not attrition probability or automated personnel assessment",
      attrition: {
        available: false,
        reason:
          "Labeled attrition outcomes and fairness evaluation are not provided",
      },
    });
    return true;
  }
  const costMatch = path.match(/^\/api\/v1\/hr\/program-financials\/([^/]+)$/);
  if (method === "PUT" && costMatch) {
    const payload = z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        cost: z.number().nonnegative().max(1e12),
        measuredBenefit: z.number().nonnegative().max(1e12).nullable(),
        methodology: z.string().min(20).max(4000),
      })
      .strict()
      .parse(await ctx.body());
    ctx.send(
      await idempotent(ctx, path, payload, async (c) => {
        if (
          !(
            await c.query("SELECT 1 FROM events WHERE event_id=$1", [
              costMatch[1],
            ])
          ).rowCount
        )
          throw new HttpError(404, "NOT_FOUND", "Мероприятие не найдено");
        await c.query(
          "INSERT INTO program_financials(event_id,currency,cost,measured_benefit,methodology,approved_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO UPDATE SET currency=EXCLUDED.currency,cost=EXCLUDED.cost,measured_benefit=EXCLUDED.measured_benefit,methodology=EXCLUDED.methodology,approved_by=EXCLUDED.approved_by,approved_at=now()",
          [
            costMatch[1],
            payload.currency,
            payload.cost,
            payload.measuredBenefit,
            payload.methodology,
            user.id,
          ],
        );
        await audit(
          c,
          user,
          "program.financials",
          "events",
          costMatch[1]!,
          payload,
          ctx.requestId,
        );
        return { saved: true };
      }),
    );
    return true;
  }
  if (method === "GET" && path === "/api/v1/hr/roi") {
    const rows = (
      await pool.query(
        'SELECT f.event_id AS "eventId",e.title,f.currency,f.cost::float,f.measured_benefit::float AS "measuredBenefit",f.methodology,f.approved_at AS "approvedAt",CASE WHEN f.cost>0 AND f.measured_benefit IS NOT NULL THEN round((f.measured_benefit-f.cost)/f.cost*100,2)::float END AS "roiPercent" FROM program_financials f JOIN events e USING(event_id) ORDER BY f.event_id',
      )
    ).rows;
    ctx.send({
      available: rows.length > 0,
      programs: rows,
      methodology:
        "ROI only from human-approved monetary costs and measured benefits; no synthetic financial claims",
    });
    return true;
  }
  return false;
}
