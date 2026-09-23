import { createHash } from "node:crypto";
import { z } from "zod";
import { readAiConfig } from "./ai-config.js";
import {
  HttpError,
  type Queryable,
  type RouteContext,
  requireEmployeeAccess,
  requireRole,
  snapshotDate,
  idempotent,
  idempotencyPayloadHash,
  audit,
} from "./http.js";
import {
  ALGORITHM_VERSION,
  GRADES,
  applyEffects,
  deriveLevels,
  progressFor,
  type SkillEffect,
  type Requirement,
  type Completion,
} from "./career-domain.js";

export type CareerProfile = {
  employee: {
    id: string;
    name: string;
    role: string;
    grade: string;
    department: string;
    managerId: string | null;
    lastReviewDate: string;
    [key: string]: unknown;
  };
  asOfDate: string;
  goal: {
    id?: string;
    targetRole: string;
    targetGrade: string;
    inferred: boolean;
  } | null;
  baselineLevels: Record<string, number>;
  effectiveLevels: Record<string, number>;
  requirements: Requirement[];
  skills: Array<
    Requirement & {
      name: string;
      type: string;
      baselineLevel: number;
      effectiveLevel: number;
      gap: number;
    }
  >;
  history: Array<
    Completion & {
      mandatory: boolean;
      title: string;
      completionPct: number;
      sessionId: string | null;
      score: number | null;
      feedbackRating: number | null;
    }
  >;
  changes: ReturnType<typeof deriveLevels>["changes"];
  progress: ReturnType<typeof progressFor>;
};
export type CareerEvent = {
  eventId: string;
  title: string;
  description: string;
  type: string;
  format: string;
  durationHours: number;
  mandatory: boolean;
  isActive: boolean;
  targetRoles: string[];
  targetGrades: string[];
  effects: SkillEffect[];
  prerequisites: Array<{ skillId: string; minLevel: number }>;
  sessions: Array<{
    id: string;
    date: string;
    capacity: number | null;
    occupied: number;
  }>;
};
export type Recommendation = {
  eventId: string;
  title: string;
  score: number;
  sessionId: string | null;
  durationHours: number;
  expectedGains: Array<{
    skillId: string;
    from: number;
    to: number;
    required: number;
    gapClosed: number;
    isCritical: boolean;
  }>;
  factors: Array<{ id: string; text: string }>;
  explanation: string;
  factorIds: string[];
  rank: number;
};

export async function loadCareer(
  db: Queryable,
  employeeId: string,
): Promise<CareerProfile> {
  const e = (
    await db.query(
      `SELECT employee_id AS id,full_name AS name,role,grade,department,manager_id AS "managerId",last_review_date::text AS "lastReviewDate",hire_date::text AS "hireDate",tenure_months AS "tenureMonths",work_format AS "workFormat",preferred_language AS language FROM employees WHERE employee_id=$1`,
      [employeeId],
    )
  ).rows[0];
  if (!e) throw new HttpError(404, "NOT_FOUND", "Сотрудник не найден");
  const asOfDate = await snapshotDate(db);
  const active = (
    await db.query(
      'SELECT id,target_role AS "targetRole",target_grade AS "targetGrade" FROM career_goals WHERE employee_id=$1 AND status=\'active\'',
      [employeeId],
    )
  ).rows[0];
  const next = GRADES[GRADES.indexOf(e.grade) + 1];
  const goal = active
    ? { ...active, inferred: false }
    : next
      ? { targetRole: e.role, targetGrade: next, inferred: true }
      : null;
  const catalog = (
    await db.query(
      'SELECT skill_id AS "skillId",name,type FROM skills ORDER BY skill_id',
    )
  ).rows;
  const baselines = (
    await db.query(
      "SELECT skill_id,assessed_level FROM employee_skill_baselines WHERE employee_id=$1",
      [employeeId],
    )
  ).rows;
  const baselineLevels: Record<string, number> = Object.fromEntries(
    catalog.map((s) => [s.skillId, 0]),
  );
  for (const b of baselines) baselineLevels[b.skill_id] = b.assessed_level;
  const history = (
    await db.query(
      `SELECT p.id,p.event_id AS "eventId",p.date::text,p.status,COALESCE(p.effects_snapshot,'[]') AS effects,e.mandatory,e.title,p.completion_pct AS "completionPct",p.session_id AS "sessionId",p.score,p.feedback_rating AS "feedbackRating" FROM participations p JOIN events e USING(event_id) WHERE employee_id=$1 ORDER BY p.date,p.created_at,p.id`,
      [employeeId],
    )
  ).rows as CareerProfile["history"];
  const { levels: effectiveLevels, changes } = deriveLevels(
    baselineLevels,
    e.lastReviewDate,
    asOfDate,
    history,
  );
  const requirements: Requirement[] = goal
    ? (
        await db.query(
          'SELECT skill_id AS "skillId",required_level AS "requiredLevel",is_critical AS "isCritical" FROM role_requirements WHERE role=$1 AND grade=$2 ORDER BY skill_id',
          [goal.targetRole, goal.targetGrade],
        )
      ).rows
    : [];
  const skills = catalog.map((s) => {
    const r = requirements.find((r) => r.skillId === s.skillId);
    return {
      skillId: s.skillId,
      name: s.name,
      type: s.type,
      requiredLevel: r?.requiredLevel ?? 0,
      isCritical: r?.isCritical ?? false,
      baselineLevel: baselineLevels[s.skillId] ?? 0,
      effectiveLevel: effectiveLevels[s.skillId] ?? 0,
      gap: Math.max(
        0,
        (r?.requiredLevel ?? 0) - (effectiveLevels[s.skillId] ?? 0),
      ),
    };
  });
  return {
    employee: e,
    asOfDate,
    goal,
    baselineLevels,
    effectiveLevels,
    requirements,
    skills,
    history,
    changes,
    progress: progressFor(effectiveLevels, requirements),
  };
}
export async function loadEvents(db: Queryable): Promise<CareerEvent[]> {
  const [ev, roles, grades, effects, prereqs, sessions] = [
    await db.query(
      'SELECT event_id AS "eventId",title,description,type,format,duration_hours::float AS "durationHours",mandatory,is_active AS "isActive" FROM events ORDER BY event_id',
    ),
    await db.query(
      "SELECT event_id,role FROM event_target_roles ORDER BY event_id,role",
    ),
    await db.query(
      "SELECT event_id,grade FROM event_target_grades ORDER BY event_id,grade",
    ),
    await db.query(
      'SELECT event_id,skill_id AS "skillId",gain,max_level AS "maxLevel" FROM event_skill_effects ORDER BY event_id,skill_id',
    ),
    await db.query(
      'SELECT event_id,skill_id AS "skillId",min_level AS "minLevel" FROM event_prerequisites ORDER BY event_id,skill_id',
    ),
    await db.query(
      `SELECT s.event_id,s.id,s.session_date::text AS date,s.capacity,count(p.id) FILTER(WHERE p.status IN ('registered','in_progress','completed'))::int AS occupied FROM event_sessions s LEFT JOIN participations p ON p.session_id=s.id GROUP BY s.id ORDER BY s.session_date,s.id`,
    ),
  ];
  return ev.rows.map((e) => ({
    ...e,
    targetRoles: roles.rows
      .filter((r) => r.event_id === e.eventId)
      .map((r) => r.role),
    targetGrades: grades.rows
      .filter((r) => r.event_id === e.eventId)
      .map((r) => r.grade),
    effects: effects.rows
      .filter((r) => r.event_id === e.eventId)
      .map(({ event_id, ...r }) => r),
    prerequisites: prereqs.rows
      .filter((r) => r.event_id === e.eventId)
      .map(({ event_id, ...r }) => r),
    sessions: sessions.rows
      .filter((r) => r.event_id === e.eventId)
      .map(({ event_id, ...r }) => r),
  })) as CareerEvent[];
}
export function eligibility(
  event: CareerEvent,
  profile: CareerProfile,
  options: { allowWaitlist?: boolean; ignoreActive?: boolean } = {},
) {
  const reasons: string[] = [];
  if (!event.isActive) reasons.push("INACTIVE");
  if (!event.targetRoles.includes(profile.employee.role))
    reasons.push("ROLE_MISMATCH");
  if (!event.targetGrades.includes(profile.employee.grade))
    reasons.push("GRADE_MISMATCH");
  for (const p of event.prerequisites)
    if ((profile.effectiveLevels[p.skillId] ?? 0) < p.minLevel)
      reasons.push(`PREREQUISITE:${p.skillId}:${p.minLevel}`);
  const repeatable =
    event.eventId === "EV_036" ||
    (["EV_001", "EV_002", "EV_003"].includes(event.eventId) && event.mandatory);
  if (
    !repeatable &&
    profile.history.some(
      (p) => p.eventId === event.eventId && p.status === "completed",
    )
  )
    reasons.push("ALREADY_COMPLETED");
  if (
    !options.ignoreActive &&
    profile.history.some(
      (p) =>
        p.eventId === event.eventId &&
        ["registered", "in_progress", "waitlisted"].includes(p.status),
    )
  )
    reasons.push("ALREADY_ACTIVE");
  const upcoming = event.sessions.filter((s) => s.date > profile.asOfDate),
    available = upcoming.find(
      (s) => s.capacity === null || s.occupied < s.capacity,
    );
  if (event.format !== "self_paced" && !upcoming.length)
    reasons.push("NO_FUTURE_SESSION");
  else if (
    event.format !== "self_paced" &&
    !available &&
    !options.allowWaitlist
  )
    reasons.push("NO_CAPACITY");
  return {
    eligible: reasons.length === 0,
    reasons,
    sessionId:
      event.format === "self_paced"
        ? null
        : ((available ?? upcoming[0])?.id ?? null),
  };
}
export const DEFAULT_RECOMMENDATION_WEIGHTS = {
  critical: 0.35,
  other: 0.2,
  goal: 0.15,
  history: 0.15,
  availability: 0.15,
};
function readRecommendationWeights() {
  if (!process.env.RECOMMENDATION_WEIGHTS)
    return DEFAULT_RECOMMENDATION_WEIGHTS;
  const parsed = z
    .object({
      critical: z.number().nonnegative(),
      other: z.number().nonnegative(),
      goal: z.number().nonnegative(),
      history: z.number().nonnegative(),
      availability: z.number().nonnegative(),
    })
    .strict()
    .parse(JSON.parse(process.env.RECOMMENDATION_WEIGHTS));
  const total = Object.values(parsed).reduce((n, v) => n + v, 0);
  if (total <= 0)
    throw new Error("Recommendation weights must have a positive sum");
  return {
    critical: parsed.critical / total,
    other: parsed.other / total,
    goal: parsed.goal / total,
    history: parsed.history / total,
    availability: parsed.availability / total,
  };
}
export async function computeRecommendations(
  db: Queryable,
  employeeId: string,
  limit = 3,
  preloadedEvents?: CareerEvent[],
) {
  const weights = readRecommendationWeights();
  const profile = await loadCareer(db, employeeId),
    events = preloadedEvents ?? (await loadEvents(db));
  const excluded: Array<{ eventId: string; reasons: string[] }> = [],
    ranked: Recommendation[] = [];
  for (const e of events) {
    const valid = eligibility(e, profile),
      reasons = [...valid.reasons];
    if (e.mandatory) reasons.push("MANDATORY");
    if (!profile.goal) reasons.push("GOAL_REQUIRED");
    const after = applyEffects(profile.effectiveLevels, e.effects);
    const expectedGains = e.effects
      .map((f) => {
        const r = profile.requirements.find((r) => r.skillId === f.skillId),
          from = profile.effectiveLevels[f.skillId] ?? 0,
          to = after[f.skillId] ?? 0,
          required = r?.requiredLevel ?? 0;
        return {
          skillId: f.skillId,
          from,
          to,
          required,
          gapClosed: Math.min(Math.max(0, required - from), to - from),
          isCritical: r?.isCritical ?? false,
        };
      })
      .filter((g) => g.to > g.from);
    if (!expectedGains.length) reasons.push("NO_SKILL_GAIN");
    if (reasons.length) {
      excluded.push({ eventId: e.eventId, reasons });
      continue;
    }
    const criticalTotal = profile.requirements
      .filter((r) => r.isCritical)
      .reduce(
        (n, r) =>
          n +
          Math.max(
            0,
            r.requiredLevel - (profile.effectiveLevels[r.skillId] ?? 0),
          ),
        0,
      );
    const otherTotal = profile.requirements
      .filter((r) => !r.isCritical)
      .reduce(
        (n, r) =>
          n +
          Math.max(
            0,
            r.requiredLevel - (profile.effectiveLevels[r.skillId] ?? 0),
          ),
        0,
      );
    const critical = expectedGains
        .filter((g) => g.isCritical)
        .reduce((n, g) => n + g.gapClosed, 0),
      other = expectedGains
        .filter((g) => !g.isCritical)
        .reduce((n, g) => n + g.gapClosed, 0);
    const past = profile.history.filter((p) => p.eventId === e.eventId),
      negative = past.filter((p) =>
        ["no_show", "dropped", "declined"].includes(p.status),
      ).length;
    const rating = past.filter((p) => p.feedbackRating !== null),
      average = rating.length
        ? rating.reduce((n, p) => n + p.feedbackRating!, 0) / rating.length
        : 3;
    const history = Math.max(0, 1 - negative * 0.2) * (0.5 + average / 10),
      goalMatch = expectedGains.some((g) => g.required > 0) ? 1 : 0.3;
    const score =
      weights.critical * (criticalTotal ? critical / criticalTotal : 0) +
      weights.other * (otherTotal ? other / otherTotal : 0) +
      weights.goal * goalMatch +
      weights.history * history +
      weights.availability / (1 + e.durationHours / 8);
    const factors = [
      {
        id: "grade",
        text: `Текущая роль ${profile.employee.role}, грейд ${profile.employee.grade} входят в аудиторию мероприятия.`,
      },
      {
        id: "skill_gap",
        text: expectedGains
          .map(
            (g) =>
              `${g.skillId}: ${g.from} → ${g.to}, требование ${g.required}, сокращение разрыва ${g.gapClosed}`,
          )
          .join("; "),
      },
      {
        id: "history",
        text: `Предыдущих участий: ${past.length}; завершений: ${past.filter((p) => p.status === "completed").length}; отказов/пропусков: ${negative}.`,
      },
      {
        id: "goal",
        text: `${profile.goal!.inferred ? "Предложенная" : "Выбранная"} цель: ${profile.goal!.targetRole} / ${profile.goal!.targetGrade}. Критические разрывы сокращаются на ${critical}, прочие на ${other}.`,
      },
      {
        id: "duration",
        text: `Длительность: ${e.durationHours} ч.; формат: ${e.format}.`,
      },
    ];
    ranked.push({
      eventId: e.eventId,
      title: e.title,
      score: Number(score.toFixed(6)),
      sessionId: valid.sessionId,
      durationHours: e.durationHours,
      expectedGains,
      factors,
      factorIds: factors.map((f) => f.id),
      explanation: factors.map((f) => f.text).join(" "),
      rank: 0,
    });
  }
  ranked.sort(
    (a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId),
  );
  // Diversify near-ties by skill coverage without displacing a substantially better score.
  const ordered: Recommendation[] = [];
  const remaining = [...ranked];
  const covered = new Set<string>();
  while (remaining.length) {
    const top = remaining[0]!,
      near = remaining.filter((r) => top.score - r.score <= 0.025);
    near.sort(
      (a, b) =>
        b.expectedGains.filter((g) => !covered.has(g.skillId)).length -
          a.expectedGains.filter((g) => !covered.has(g.skillId)).length ||
        b.score - a.score ||
        a.eventId.localeCompare(b.eventId),
    );
    const selected = near[0]!;
    remaining.splice(remaining.indexOf(selected), 1);
    ordered.push({ ...selected, rank: ordered.length + 1 });
    for (const gain of selected.expectedGains) covered.add(gain.skillId);
  }
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        algorithm: ALGORITHM_VERSION,
        weights,
        employee: profile.employee,
        goal: profile.goal,
        asOfDate: profile.asOfDate,
        levels: profile.effectiveLevels,
        history: profile.history,
        requirements: profile.requirements,
        events,
      }),
    )
    .digest("hex");
  return {
    profile,
    weights,
    candidates: ordered.slice(0, Math.max(1, Math.min(100, limit))),
    excluded,
    algorithmVersion: ALGORITHM_VERSION,
    inputHash,
    totalCandidates: ordered.length,
  };
}
type RerankResult = Awaited<
  ReturnType<typeof import("./ai.js").rerankRecommendations>
>;
const rerankInFlight = new Map<string, Promise<RerankResult>>();
function recommendationRunVersion(useAi: boolean) {
  if (!useAi) return ALGORITHM_VERSION + "-fallback";
  const c = readAiConfig();
  return (
    ALGORITHM_VERSION +
    "-ai-" +
    createHash("sha256")
      .update(
        JSON.stringify({
          enabled: c.enabled,
          model: c.recommendModel,
          maxOutput: c.maxOutput,
          maxInput: c.maxInputBytes,
        }),
      )
      .digest("hex")
      .slice(0, 12)
  );
}
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/);
const grade = z.enum(GRADES);
const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const eventSchema = z
  .object({
    eventId: id,
    title: z.string().trim().min(1).max(300),
    description: z.string().max(10000),
    type: z.enum([
      "compliance",
      "onboarding",
      "course",
      "workshop",
      "mentoring",
      "certification",
      "meetup",
    ]),
    format: z.enum(["online", "offline", "self_paced"]),
    durationHours: z.number().positive().max(1000),
    mandatory: z.boolean(),
    isActive: z.boolean().default(true),
    targetRoles: z.array(z.string().min(1).max(100)).min(1).max(100),
    targetGrades: z.array(grade).min(1).max(4),
    effects: z
      .array(
        z.object({
          skillId: id,
          gain: z.number().int().min(1).max(5),
          maxLevel: z.number().int().min(0).max(5),
        }),
      )
      .max(200),
    prerequisites: z
      .array(
        z.object({ skillId: id, minLevel: z.number().int().min(0).max(5) }),
      )
      .max(200),
    sessions: z
      .array(
        z.object({
          date: z.iso.date(),
          capacity: z
            .number()
            .int()
            .positive()
            .max(100000)
            .nullable()
            .default(null),
        }),
      )
      .max(500),
  })
  .strict();
async function emit(db: Queryable, topic: string, payload: unknown) {
  await db.query("INSERT INTO outbox_events(topic,payload) VALUES($1,$2)", [
    topic,
    JSON.stringify(payload),
  ]);
}
async function lockEmployee(db: Queryable, employeeId: string) {
  await db.query(
    "SELECT employee_id FROM employees WHERE employee_id=$1 FOR UPDATE",
    [employeeId],
  );
}
async function eventById(db: Queryable, eventId: string) {
  const event = (await loadEvents(db)).find((e) => e.eventId === eventId);
  if (!event) throw new HttpError(404, "NOT_FOUND", "Мероприятие не найдено");
  return event;
}
const rowDto = (p: Record<string, unknown>) => ({
  id: p.id,
  employeeId: p.employee_id,
  eventId: p.event_id,
  status: p.status,
  sessionId: p.session_id,
  date: p.date,
  completionPct: p.completion_pct,
  score: p.score,
  feedbackRating: p.feedback_rating,
});

async function assertCompletionAllowed(
  db: Queryable,
  employeeId: string,
  eventId: string,
  participationId: string,
) {
  const event = await eventById(db, eventId);
  if (
    eventId === "EV_036" ||
    (event.mandatory && ["EV_001", "EV_002", "EV_003"].includes(eventId))
  )
    return;
  if (
    (
      await db.query(
        "SELECT 1 FROM participations WHERE employee_id=$1 AND event_id=$2 AND id<>$3 AND status='completed' LIMIT 1",
        [employeeId, eventId, participationId],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "ALREADY_COMPLETED",
      "Добровольное мероприятие уже было завершено",
    );
}
async function saveEvent(
  db: Queryable,
  input: z.infer<typeof eventSchema>,
  update: boolean,
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `career.event:${input.eventId}`,
  ]);
  const ids = [
    ...input.effects.map((e) => e.skillId),
    ...input.prerequisites.map((e) => e.skillId),
  ];
  if (
    new Set(input.effects.map((e) => e.skillId)).size !==
      input.effects.length ||
    new Set(input.prerequisites.map((e) => e.skillId)).size !==
      input.prerequisites.length ||
    new Set(input.sessions.map((s) => s.date)).size !== input.sessions.length
  )
    throw new HttpError(
      400,
      "DUPLICATE_VALUE",
      "Повтор навыка или даты сессии",
    );
  if (
    (
      await db.query("SELECT role FROM roles WHERE role=ANY($1::text[])", [
        input.targetRoles,
      ])
    ).rowCount !== new Set(input.targetRoles).size ||
    (
      await db.query(
        "SELECT skill_id FROM skills WHERE skill_id=ANY($1::text[])",
        [ids],
      )
    ).rowCount !== new Set(ids).size
  )
    throw new HttpError(400, "UNKNOWN_REFERENCE", "Неизвестная роль или навык");
  if (update) {
    await db.query("SELECT event_id FROM events WHERE event_id=$1 FOR UPDATE", [
      input.eventId,
    ]);
    const original = await eventById(db, input.eventId);
    if (
      original.format !== input.format &&
      (
        await db.query(
          "SELECT 1 FROM participations WHERE event_id=$1 LIMIT 1",
          [input.eventId],
        )
      ).rowCount
    )
      throw new HttpError(
        409,
        "EVENT_IN_USE",
        "Нельзя менять формат мероприятия с историей участия",
      );
  } else if (
    (await db.query("SELECT 1 FROM events WHERE event_id=$1", [input.eventId]))
      .rowCount
  )
    throw new HttpError(409, "EVENT_EXISTS", "Этот ID уже существует");
  await db.query(
    `INSERT INTO events(event_id,title,description,type,format,duration_hours,mandatory,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,type=EXCLUDED.type,format=EXCLUDED.format,duration_hours=EXCLUDED.duration_hours,mandatory=EXCLUDED.mandatory,is_active=EXCLUDED.is_active`,
    [
      input.eventId,
      input.title,
      input.description,
      input.type,
      input.format,
      input.durationHours,
      input.mandatory,
      input.isActive,
    ],
  );
  for (const table of [
    "event_target_roles",
    "event_target_grades",
    "event_skill_effects",
    "event_prerequisites",
  ])
    await db.query(`DELETE FROM ${table} WHERE event_id=$1`, [input.eventId]);
  for (const role of new Set(input.targetRoles))
    await db.query("INSERT INTO event_target_roles VALUES($1,$2)", [
      input.eventId,
      role,
    ]);
  for (const g of new Set(input.targetGrades))
    await db.query("INSERT INTO event_target_grades VALUES($1,$2)", [
      input.eventId,
      g,
    ]);
  for (const e of input.effects)
    await db.query("INSERT INTO event_skill_effects VALUES($1,$2,$3,$4)", [
      input.eventId,
      e.skillId,
      e.gain,
      e.maxLevel,
    ]);
  for (const p of input.prerequisites)
    await db.query("INSERT INTO event_prerequisites VALUES($1,$2,$3)", [
      input.eventId,
      p.skillId,
      p.minLevel,
    ]);
  const existing = (
    await db.query(
      "SELECT id,session_date::text AS date FROM event_sessions WHERE event_id=$1 FOR UPDATE",
      [input.eventId],
    )
  ).rows;
  for (const s of existing)
    if (!input.sessions.some((n) => n.date === s.date)) {
      if (
        (
          await db.query(
            "SELECT 1 FROM participations WHERE session_id=$1 LIMIT 1",
            [s.id],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          "SESSION_IN_USE",
          "Нельзя удалить сессию с участниками",
        );
      await db.query("DELETE FROM event_sessions WHERE id=$1", [s.id]);
    }
  for (const s of input.sessions) {
    const current = existing.find((e) => e.date === s.date);
    if (current && s.capacity !== null) {
      const occupied = (
        await db.query(
          "SELECT count(*)::int AS n FROM participations WHERE session_id=$1 AND status IN ('registered','in_progress','completed')",
          [current.id],
        )
      ).rows[0].n;
      if (occupied > s.capacity)
        throw new HttpError(
          409,
          "CAPACITY_BELOW_OCCUPIED",
          "Вместимость меньше числа занятых мест",
        );
    }
    await db.query(
      "INSERT INTO event_sessions(event_id,session_date,capacity) VALUES($1,$2,$3) ON CONFLICT(event_id,session_date) DO UPDATE SET capacity=EXCLUDED.capacity",
      [input.eventId, s.date, s.capacity],
    );
  }
  const asOfDate = await snapshotDate(db);
  for (const session of (
    await db.query(
      "SELECT id FROM event_sessions WHERE event_id=$1 ORDER BY id",
      [input.eventId],
    )
  ).rows) {
    while (await promoteWaiter(db, session.id, asOfDate)) {
      /* Fill newly available seats in queue order. */
    }
  }
  return eventById(db, input.eventId);
}

async function stage(
  db: Queryable,
  employeeId: string,
  eventId: string,
  kind: string,
  date: string,
  participationId: string | null = null,
  runId: string | null = null,
) {
  await db.query(
    "INSERT INTO career_activity_log(employee_id,event_id,stage,date,participation_id,run_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    [employeeId, eventId, kind, date, participationId, runId],
  );
}
async function promoteWaiter(
  db: Queryable,
  sessionId: string,
  asOfDate: string,
) {
  const session = (
    await db.query(
      "SELECT id,session_date::text AS date,capacity FROM event_sessions WHERE id=$1 FOR UPDATE",
      [sessionId],
    )
  ).rows[0];
  if (!session || session.date <= asOfDate) return false;
  const occupied = (
    await db.query(
      "SELECT count(*)::int AS n FROM participations WHERE session_id=$1 AND status IN ('registered','in_progress','completed')",
      [sessionId],
    )
  ).rows[0].n;
  if (session.capacity !== null && occupied >= session.capacity) return false;
  const waiters = (
    await db.query(
      "SELECT * FROM participations WHERE session_id=$1 AND status='waitlisted' ORDER BY created_at,id FOR UPDATE",
      [sessionId],
    )
  ).rows;
  for (const waiter of waiters) {
    const profile = await loadCareer(db, waiter.employee_id),
      event = await eventById(db, waiter.event_id);
    if (
      !eligibility(event, profile, { ignoreActive: true, allowWaitlist: true })
        .eligible
    )
      continue;
    await db.query(
      "UPDATE participations SET status='registered' WHERE id=$1",
      [waiter.id],
    );
    await stage(
      db,
      waiter.employee_id,
      waiter.event_id,
      "registered",
      asOfDate,
      waiter.id,
    );
    await db.query(
      "INSERT INTO notifications(employee_id,kind,title,body,link,dedupe_key) VALUES($1,'waitlist','Место освободилось','Вы переведены из очереди в список участников',$2,$3) ON CONFLICT(dedupe_key) DO NOTHING",
      [
        waiter.employee_id,
        `/events/${waiter.event_id}`,
        `waitlist:${waiter.id}`,
      ],
    );
    return true;
  }
  return false;
}
export async function handleCareer(ctx: RouteContext): Promise<boolean> {
  const { pool, user, path, method, url, send } = ctx;
  if (method === "GET" && path === "/api/v1/role-profiles") {
    const data = (
      await pool.query(
        `SELECT rp.role,rp.grade,COALESCE(jsonb_agg(jsonb_build_object('skillId',r.skill_id,'requiredLevel',r.required_level,'isCritical',r.is_critical) ORDER BY r.skill_id) FILTER(WHERE r.skill_id IS NOT NULL),'[]') AS requirements FROM role_profiles rp LEFT JOIN role_requirements r USING(role,grade) WHERE ($1::text IS NULL OR rp.role=$1) AND ($2::text IS NULL OR rp.grade=$2) GROUP BY rp.role,rp.grade ORDER BY rp.role,array_position(ARRAY['Junior','Middle','Senior','Lead'],rp.grade::text)`,
        [url.searchParams.get("role"), url.searchParams.get("grade")],
      )
    ).rows;
    send(data);
    return true;
  }
  if (method === "GET" && path === "/api/v1/skills") {
    send(
      (
        await pool.query(
          "SELECT skill_id AS id,name,type,category,description FROM skills ORDER BY category,name",
        )
      ).rows,
    );
    return true;
  }
  const employeeRoute = path.match(
    /^\/api\/v1\/employees\/([^/]+)(?:\/(skills|history|goals|goal|progress|recommendations)(?:\/(latest))?)?$/,
  );
  if (employeeRoute) {
    const employeeId = id.parse(decodeURIComponent(employeeRoute[1]!)),
      section = employeeRoute[2],
      latest = employeeRoute[3];
    if (method === "GET") {
      await requireEmployeeAccess(pool, user, employeeId);
      const profile = await loadCareer(pool, employeeId);
      if (!section) {
        send({
          ...profile.employee,
          targetRole: profile.goal?.targetRole ?? null,
          targetGrade: profile.goal?.targetGrade ?? null,
          goal: profile.goal,
          progress: profile.progress,
          asOfDate: profile.asOfDate,
        });
        return true;
      }
      if (section === "skills") {
        send(profile.skills, 200, {
          lastReviewDate: profile.employee.lastReviewDate,
          asOfDate: profile.asOfDate,
          scale: { min: 0, max: 5 },
          goal: profile.goal,
        });
        return true;
      }
      if (section === "progress") {
        send({
          goal: profile.goal,
          progress: profile.progress,
          changes: profile.changes,
          asOfDate: profile.asOfDate,
          promotionDecision: false,
        });
        return true;
      }
      if (section === "goals") {
        const goals = (
          await pool.query(
            'SELECT id,target_role AS "targetRole",target_grade AS "targetGrade",status,created_at AS "createdAt" FROM career_goals WHERE employee_id=$1 ORDER BY created_at DESC',
            [employeeId],
          )
        ).rows;
        send({ active: profile.goal, history: goals });
        return true;
      }
      if (section === "history") {
        const q = pagination
          .extend({
            status: z
              .enum([
                "registered",
                "waitlisted",
                "completed",
                "in_progress",
                "dropped",
                "no_show",
                "declined",
                "overdue",
              ])
              .optional(),
            mandatory: z.enum(["true", "false"]).optional(),
          })
          .parse(Object.fromEntries(url.searchParams));
        const rows = profile.history
          .filter(
            (p) =>
              (!q.status || p.status === q.status) &&
              (!q.mandatory || p.mandatory === (q.mandatory === "true")),
          )
          .reverse();
        send(rows.slice((q.page - 1) * q.limit, q.page * q.limit), 200, {
          total: rows.length,
          page: q.page,
          limit: q.limit,
        });
        return true;
      }
      if (section === "recommendations" && latest) {
        const run = (
          await pool.query(
            'SELECT id AS "runId",input_hash AS "inputHash",algorithm_version AS "algorithmVersion",source,model,result,created_at AS "createdAt" FROM recommendation_runs WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 1',
            [employeeId],
          )
        ).rows[0];
        if (!run) {
          send({ run: null, stale: true, reason: "NOT_CALCULATED" });
          return true;
        }
        const current = await computeRecommendations(pool, employeeId);
        send({
          ...run.result,
          runId: run.runId,
          source: run.source,
          model: run.model,
          createdAt: run.createdAt,
          stale:
            run.inputHash !== current.inputHash ||
            ![
              recommendationRunVersion(false),
              recommendationRunVersion(true),
            ].includes(run.algorithmVersion) ||
            (run.algorithmVersion.includes("-ai-") &&
              Date.now() - new Date(run.createdAt).getTime() > 15 * 60 * 1000),
        });
        return true;
      }
    }
    if (method === "PUT" && section === "goal") {
      await requireEmployeeAccess(pool, user, employeeId, true);
      const input = z
        .object({ targetRole: z.string().min(1).max(100), targetGrade: grade })
        .strict()
        .parse(await ctx.body());
      const result = await idempotent(
        ctx,
        `goal:${employeeId}`,
        input,
        async (db) => {
          await requireEmployeeAccess(db, user, employeeId, true);
          await lockEmployee(db, employeeId);
          if (
            !(
              await db.query(
                "SELECT 1 FROM role_profiles WHERE role=$1 AND grade=$2",
                [input.targetRole, input.targetGrade],
              )
            ).rowCount
          )
            throw new HttpError(
              400,
              "UNKNOWN_ROLE_PROFILE",
              "Такого профиля роли и грейда нет",
            );
          await db.query(
            "UPDATE career_goals SET status='archived' WHERE employee_id=$1 AND status='active'",
            [employeeId],
          );
          const goal = (
            await db.query(
              'INSERT INTO career_goals(employee_id,target_role,target_grade) VALUES($1,$2,$3) RETURNING id,target_role AS "targetRole",target_grade AS "targetGrade"',
              [employeeId, input.targetRole, input.targetGrade],
            )
          ).rows[0];
          await audit(
            db,
            user,
            "goal.changed",
            "employee",
            employeeId,
            input,
            ctx.requestId,
          );
          await emit(db, "goal.changed", { employeeId, goal });
          return {
            goal: { ...goal, inferred: false },
            progress: (await loadCareer(db, employeeId)).progress,
          };
        },
      );
      send(result);
      return true;
    }
    if (method === "DELETE" && section === "goal") {
      await requireEmployeeAccess(pool, user, employeeId, true);
      const result = await idempotent(
        ctx,
        `goal.clear:${employeeId}`,
        {},
        async (db) => {
          await requireEmployeeAccess(db, user, employeeId, true);
          await lockEmployee(db, employeeId);
          await db.query(
            "UPDATE career_goals SET status='archived' WHERE employee_id=$1 AND status='active'",
            [employeeId],
          );
          await audit(
            db,
            user,
            "goal.cleared",
            "employee",
            employeeId,
            {},
            ctx.requestId,
          );
          await emit(db, "goal.changed", { employeeId, goal: null });
          return { goal: (await loadCareer(db, employeeId)).goal };
        },
      );
      send(result);
      return true;
    }
    if (method === "POST" && section === "recommendations" && !latest) {
      const input = z
        .object({
          goalId: z.uuid().optional(),
          useAi: z.boolean().default(false),
        })
        .strict()
        .parse(await ctx.body());
      await requireEmployeeAccess(pool, user, employeeId);
      const key = ctx.req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 8 || key.length > 160)
        throw new HttpError(
          400,
          "IDEMPOTENCY_REQUIRED",
          "Нужен Idempotency-Key длиной 8–160 символов",
        );
      const previous = (
        await pool.query(
          "SELECT payload_hash,response FROM idempotency_records WHERE user_id=$1 AND operation=$2 AND key=$3",
          [user.id, `recommendations:${employeeId}`, key],
        )
      ).rows[0];
      if (previous) {
        if (previous.payload_hash !== idempotencyPayloadHash(user, input))
          throw new HttpError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Ключ уже использован для другого запроса",
          );
        send(previous.response);
        return true;
      }
      let preparedAi: { inputHash: string; response: RerankResult } | undefined;
      const start = Date.now();
      let flightKey: string | undefined;
      if (input.useAi) {
        const initial = await computeRecommendations(pool, employeeId, 8);
        if (input.goalId && initial.profile.goal?.id !== input.goalId)
          throw new HttpError(
            409,
            "GOAL_CHANGED",
            "Выбранная цель больше не активна",
          );
        const cached = (
          await pool.query(
            "SELECT id FROM recommendation_runs WHERE employee_id=$1 AND input_hash=$2 AND algorithm_version=$3 AND created_at>now()-interval '15 minutes' LIMIT 1",
            [employeeId, initial.inputHash, recommendationRunVersion(true)],
          )
        ).rowCount;
        if (!cached && initial.candidates.length) {
          flightKey = `${user.id}:${employeeId}:${initial.inputHash}`;
          let pending = rerankInFlight.get(flightKey);
          if (!pending) {
            const { rerankRecommendations } = await import("./ai.js");
            pending = rerankRecommendations({
              pool,
              userId: user.id,
              candidates: initial.candidates.map((c) => ({
                eventId: c.eventId,
                facts: c.factors,
              })),
              context: {
                role: initial.profile.employee.role,
                grade: initial.profile.employee.grade,
                goal: initial.profile.goal,
                asOfDate: initial.profile.asOfDate,
              },
            });
            rerankInFlight.set(flightKey, pending);
          }
          try {
            preparedAi = {
              inputHash: initial.inputHash,
              response: await pending,
            };
          } catch (error) {
            rerankInFlight.delete(flightKey);
            throw error;
          }
        }
      }
      try {
        const result = await idempotent(
          ctx,
          `recommendations:${employeeId}`,
          input,
          async (db) => {
            await requireEmployeeAccess(db, user, employeeId);
            const calculated = await computeRecommendations(db, employeeId, 8);
            if (input.goalId && calculated.profile.goal?.id !== input.goalId)
              throw new HttpError(
                409,
                "GOAL_CHANGED",
                "Выбранная цель больше не активна",
              );
            const cacheVersion = recommendationRunVersion(input.useAi);
            await db.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
              [
                `recommendations:${employeeId}:${calculated.inputHash}:${cacheVersion}`,
              ],
            );
            const cached = (
              await db.query(
                "SELECT id,result,created_at AS \"createdAt\",source FROM recommendation_runs WHERE employee_id=$1 AND input_hash=$2 AND algorithm_version=$3 AND (NOT $4::boolean OR created_at>now()-interval '15 minutes') ORDER BY created_at DESC LIMIT 1",
                [employeeId, calculated.inputHash, cacheVersion, input.useAi],
              )
            ).rows[0];
            if (cached)
              return {
                ...cached.result,
                runId: cached.id,
                createdAt: cached.createdAt,
                cached: true,
                stale: false,
              };
            let candidates = calculated.candidates.slice(0, 3),
              source: "ai" | "fallback" = "fallback";
            const ai = preparedAi?.response,
              contextMatches = preparedAi?.inputHash === calculated.inputHash;
            // Paid calls happen before this transaction so their budget ledger cannot roll back with a failed career write.
            if (ai?.source === "ai" && contextMatches) {
              const selected = ai.eventIds
                .map((id) =>
                  calculated.candidates.find((c) => c.eventId === id),
                )
                .filter((c): c is Recommendation => !!c);
              if (
                selected.length &&
                selected.length <= 3 &&
                new Set(selected.map((c) => c.eventId)).size === selected.length
              ) {
                candidates = selected;
                source = "ai";
              }
            }
            const usage = ai?.usageId
              ? (
                  await db.query(
                    "SELECT model,COALESCE(input_tokens,0)+COALESCE(output_tokens,0) AS tokens,cost_microusd::float/1000000 AS cost FROM ai_usage WHERE id=$1",
                    [ai.usageId],
                  )
                ).rows[0]
              : null;
            const data = {
              employeeId,
              goal: calculated.profile.goal,
              recommendations: candidates.map((r, i) => ({
                ...r,
                rank: i + 1,
              })),
              excluded: calculated.excluded,
              source,
              model: usage?.model ?? null,
              usageId: ai?.usageId ?? null,
              fallbackReason:
                preparedAi && !contextMatches
                  ? "CONTEXT_CHANGED"
                  : (ai?.fallbackReason ?? null),
              algorithmVersion: ALGORITHM_VERSION,
              asOfDate: calculated.profile.asOfDate,
              emptyReason: !candidates.length
                ? calculated.profile.goal
                  ? "NO_ELIGIBLE_EVENTS"
                  : "GOAL_REQUIRED"
                : null,
            };
            const run = (
              await db.query(
                'INSERT INTO recommendation_runs(employee_id,input_hash,algorithm_version,source,allowed_ids,result,latency_ms,model,tokens,cost_usd) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,result,created_at AS "createdAt"',
                [
                  employeeId,
                  calculated.inputHash,
                  cacheVersion,
                  source,
                  JSON.stringify(calculated.candidates.map((r) => r.eventId)),
                  JSON.stringify(data),
                  Date.now() - start,
                  usage?.model ?? null,
                  usage?.tokens ?? 0,
                  usage?.cost ?? 0,
                ],
              )
            ).rows[0];
            for (const candidate of candidates)
              await stage(
                db,
                employeeId,
                candidate.eventId,
                "offered",
                calculated.profile.asOfDate,
                null,
                run.id,
              );
            return {
              ...run.result,
              runId: run.id,
              createdAt: run.createdAt,
              cached: false,
              stale: false,
            };
          },
        );
        send(result);
        return true;
      } finally {
        if (flightKey) rerankInFlight.delete(flightKey);
      }
    }
  }
  if (
    method === "GET" &&
    (path === "/api/v1/events" ||
      /^\/api\/v1\/events\/[^/]+(?:\/sessions)?$/.test(path))
  ) {
    const eventId = path.split("/")[4],
      sessionOnly = path.endsWith("/sessions"),
      employeeId = url.searchParams.get("employeeId") ?? user.employeeId;
    let profile: CareerProfile | undefined;
    if (employeeId) {
      await requireEmployeeAccess(pool, user, employeeId);
      profile = await loadCareer(pool, employeeId);
    }
    const catalog = await loadEvents(pool),
      asOfDate = profile?.asOfDate ?? (await snapshotDate(pool));
    const present = (event: CareerEvent) => ({
      ...event,
      ...(profile
        ? {
            eligibility: eligibility(event, profile),
            waitlistEligibility: eligibility(event, profile, {
              allowWaitlist: true,
            }),
          }
        : {}),
      sessions: event.sessions.map((s) => ({
        ...s,
        future: s.date > asOfDate,
        available:
          s.capacity === null ? null : Math.max(0, s.capacity - s.occupied),
      })),
    });
    if (eventId) {
      const event = catalog.find(
        (e) => e.eventId === decodeURIComponent(eventId),
      );
      if (!event)
        throw new HttpError(404, "NOT_FOUND", "Мероприятие не найдено");
      send(sessionOnly ? present(event).sessions : present(event));
      return true;
    }
    const q = pagination
      .extend({
        q: z.string().max(150).default(""),
        role: z.string().optional(),
        grade: z.string().optional(),
        skillId: z.string().optional(),
        type: z.string().optional(),
        format: z.string().optional(),
        maxHours: z.coerce.number().positive().optional(),
        available: z.enum(["true", "false"]).optional(),
        mandatory: z.enum(["true", "false"]).optional(),
        includeInactive: z.enum(["true", "false"]).optional(),
      })
      .parse(Object.fromEntries(url.searchParams));
    if (q.available && !profile)
      throw new HttpError(
        400,
        "EMPLOYEE_REQUIRED",
        "Для фильтра доступности выберите сотрудника",
      );
    const rows = catalog.filter(
      (e) =>
        ((q.includeInactive === "true" &&
          ["hr", "admin"].includes(user.role)) ||
          e.isActive) &&
        (!q.q ||
          `${e.title} ${e.description}`
            .toLocaleLowerCase()
            .includes(q.q.toLocaleLowerCase())) &&
        (!q.role || e.targetRoles.includes(q.role)) &&
        (!q.grade || e.targetGrades.includes(q.grade)) &&
        (!q.skillId || e.effects.some((s) => s.skillId === q.skillId)) &&
        (!q.type || e.type === q.type) &&
        (!q.format || e.format === q.format) &&
        (!q.maxHours || e.durationHours <= q.maxHours) &&
        (!q.mandatory || e.mandatory === (q.mandatory === "true")) &&
        (!q.available ||
          eligibility(e, profile!).eligible === (q.available === "true")),
    );
    send(
      rows.slice((q.page - 1) * q.limit, q.page * q.limit).map(present),
      200,
      { total: rows.length, page: q.page, limit: q.limit, asOfDate },
    );
    return true;
  }
  const eventWrite = path.match(
    /^\/api\/v1\/events(?:\/([^/]+))?(?:\/(preview))?$/,
  );
  if (
    eventWrite &&
    (method === "POST" || method === "PUT" || method === "PATCH")
  ) {
    requireRole(user, "hr", "admin");
    const existingId =
        eventWrite[1] && eventWrite[1] !== "preview"
          ? decodeURIComponent(eventWrite[1])
          : null,
      isPreview = eventWrite[1] === "preview" || !!eventWrite[2];
    const raw = await ctx.body();
    let input: z.infer<typeof eventSchema>;
    if ((method === "PATCH" || method === "PUT") && existingId) {
      const existing = await eventById(pool, existingId);
      input = eventSchema.parse({
        ...existing,
        sessions: existing.sessions.map((s) => ({
          date: s.date,
          capacity: s.capacity,
        })),
        ...z.record(z.string(), z.unknown()).parse(raw),
        eventId: existingId,
      });
    } else input = eventSchema.parse(raw);
    if (isPreview) {
      const employeeId = url.searchParams.get("employeeId") ?? user.employeeId;
      if (!employeeId)
        throw new HttpError(
          400,
          "EMPLOYEE_REQUIRED",
          "Для предпросмотра выберите сотрудника",
        );
      await requireEmployeeAccess(pool, user, employeeId);
      const profile = await loadCareer(pool, employeeId);
      send({
        eligibility: eligibility(
          {
            ...input,
            sessions: input.sessions.map((s, i) => ({
              ...s,
              id: `preview-${i}`,
              occupied: 0,
            })),
          },
          profile,
        ),
        expectedLevels: applyEffects(profile.effectiveLevels, input.effects),
      });
      return true;
    }
    const result = await idempotent(
      ctx,
      `event.save:${input.eventId}`,
      input,
      async (db) => {
        const event = await saveEvent(db, input, !!existingId);
        await audit(
          db,
          user,
          existingId ? "event.updated" : "event.created",
          "event",
          input.eventId,
          input,
          ctx.requestId,
        );
        if (input.isActive)
          await emit(db, "event.published", { eventId: input.eventId });
        return event;
      },
    );
    send(result, existingId ? 200 : 201);
    return true;
  }
  if (method === "POST" && path === "/api/v1/participations") {
    const input = z
      .object({
        employeeId: id,
        eventId: id,
        sessionId: z.uuid().optional(),
        joinWaitlist: z.boolean().default(false),
      })
      .strict()
      .parse(await ctx.body());
    await requireEmployeeAccess(pool, user, input.employeeId, true);
    const result = await idempotent(
      ctx,
      "participation.register",
      input,
      async (db) => {
        await requireEmployeeAccess(db, user, input.employeeId, true);
        await lockEmployee(db, input.employeeId);
        await db.query(
          "SELECT event_id FROM events WHERE event_id=$1 FOR SHARE",
          [input.eventId],
        );
        const profile = await loadCareer(db, input.employeeId),
          event = await eventById(db, input.eventId),
          allowed = eligibility(event, profile, {
            allowWaitlist: input.joinWaitlist,
          });
        if (!allowed.eligible)
          throw new HttpError(
            409,
            "EVENT_INELIGIBLE",
            `Мероприятие недоступно: ${allowed.reasons.join(", ")}`,
          );
        let sessionId: string | null = null,
          status = "registered";
        if (event.format === "self_paced" && input.sessionId)
          throw new HttpError(
            400,
            "SESSION_NOT_APPLICABLE",
            "Для самостоятельного обучения сессия не требуется",
          );
        if (event.format !== "self_paced") {
          sessionId = input.sessionId ?? allowed.sessionId;
          const selected = (
            await db.query(
              "SELECT id,session_date::text AS date,capacity FROM event_sessions WHERE id=$1 AND event_id=$2 FOR UPDATE",
              [sessionId, input.eventId],
            )
          ).rows[0];
          if (!selected || selected.date <= profile.asOfDate)
            throw new HttpError(
              409,
              "SESSION_UNAVAILABLE",
              "Выберите будущую сессию этого мероприятия",
            );
          const occupied = (
            await db.query(
              "SELECT count(*)::int AS n FROM participations WHERE session_id=$1 AND status IN ('registered','in_progress','completed')",
              [sessionId],
            )
          ).rows[0].n;
          if (selected.capacity !== null && occupied >= selected.capacity) {
            if (!input.joinWaitlist)
              throw new HttpError(
                409,
                "SESSION_FULL",
                "Мест нет; можно записаться в очередь",
              );
            status = "waitlisted";
          }
        }
        const p = (
          await db.query(
            "INSERT INTO participations(employee_id,event_id,date,status,completion_pct,assigned_by,session_id) VALUES($1,$2,$3,$4,0,$5,$6) RETURNING *,date::text",
            [
              input.employeeId,
              input.eventId,
              profile.asOfDate,
              status,
              user.employeeId === input.employeeId ? "self" : "hr",
              sessionId,
            ],
          )
        ).rows[0];
        await audit(
          db,
          user,
          "participation.registered",
          "participation",
          p.id,
          { employeeId: input.employeeId, eventId: input.eventId, status },
          ctx.requestId,
        );
        if (status === "registered")
          await stage(
            db,
            input.employeeId,
            input.eventId,
            "registered",
            profile.asOfDate,
            p.id,
          );
        return rowDto(p);
      },
    );
    send(result, 201);
    return true;
  }
  const participationRoute = path.match(
    /^\/api\/v1\/participations\/([\w-]+)(?:\/(start|complete|drop|reschedule))?$/,
  );
  if (participationRoute && ["POST", "PATCH", "GET"].includes(method)) {
    const participationId = z.uuid().parse(participationRoute[1]),
      action = participationRoute[2];
    const p = (
      await pool.query("SELECT *,date::text FROM participations WHERE id=$1", [
        participationId,
      ])
    ).rows[0];
    if (!p) throw new HttpError(404, "NOT_FOUND", "Участие не найдено");
    await requireEmployeeAccess(pool, user, p.employee_id, method !== "GET");
    if (method === "GET" && !action) {
      send(rowDto(p));
      return true;
    }
    if (method === "PATCH" && !action) {
      requireRole(user, "hr", "admin");
      const input = z
        .object({
          status: z.enum([
            "completed",
            "in_progress",
            "dropped",
            "no_show",
            "declined",
            "overdue",
          ]),
          date: z.iso.date().optional(),
          completionPct: z.number().int().min(0).max(100).optional(),
          score: z.number().int().min(0).max(100).nullable().optional(),
          feedbackRating: z.number().int().min(1).max(5).nullable().optional(),
          reason: z.string().trim().min(5).max(1000),
        })
        .strict()
        .parse(await ctx.body());
      const result = await idempotent(
        ctx,
        `participation.correct:${participationId}`,
        input,
        async (db) => {
          await lockEmployee(db, p.employee_id);
          await db.query(
            "SELECT event_id FROM events WHERE event_id=$1 FOR SHARE",
            [p.event_id],
          );
          const before = (
              await db.query(
                "SELECT *,date::text FROM participations WHERE id=$1 FOR UPDATE",
                [participationId],
              )
            ).rows[0],
            asOfDate = await snapshotDate(db),
            date = input.date ?? before.date;
          if (date > asOfDate)
            throw new HttpError(
              400,
              "FUTURE_COMPLETION",
              "Дата не может быть позже даты среза",
            );
          if (before.session_id) {
            const session = (
              await db.query(
                "SELECT id,session_date::text AS date FROM event_sessions WHERE id=$1 FOR UPDATE",
                [before.session_id],
              )
            ).rows[0];
            if (
              ["completed", "in_progress"].includes(input.status) &&
              session.date > date
            )
              throw new HttpError(
                409,
                "SESSION_NOT_STARTED",
                "Дата исправления раньше сессии",
              );
          }
          if (
            input.status === "in_progress" &&
            (
              await db.query(
                "SELECT 1 FROM participations WHERE employee_id=$1 AND event_id=$2 AND id<>$3 AND status IN ('registered','waitlisted','in_progress') LIMIT 1",
                [p.employee_id, p.event_id, participationId],
              )
            ).rowCount
          )
            throw new HttpError(
              409,
              "ALREADY_ACTIVE",
              "У сотрудника уже есть активное участие",
            );
          if (
            ["completed", "in_progress"].includes(input.status) &&
            !["completed", "registered", "in_progress"].includes(
              before.status,
            ) &&
            before.session_id
          ) {
            const session = (
              await db.query(
                "SELECT capacity,(SELECT count(*)::int FROM participations WHERE session_id=$1 AND status IN ('registered','in_progress','completed')) AS occupied FROM event_sessions WHERE id=$1",
                [before.session_id],
              )
            ).rows[0];
            if (
              session.capacity !== null &&
              session.occupied >= session.capacity
            )
              throw new HttpError(
                409,
                "SESSION_FULL",
                "Нет свободного места для восстановления участия",
              );
          }
          if (input.status === "completed" && before.status !== "completed")
            await assertCompletionAllowed(
              db,
              p.employee_id,
              p.event_id,
              participationId,
            );
          const changed = (
            await db.query(
              "UPDATE participations SET status=$2,date=$3,completion_pct=$4,score=$5,feedback_rating=$6 WHERE id=$1 RETURNING *,date::text",
              [
                participationId,
                input.status,
                date,
                input.status === "completed"
                  ? 100
                  : (input.completionPct ??
                    (before.status === "completed"
                      ? 0
                      : before.completion_pct)),
                input.score === undefined ? before.score : input.score,
                input.feedbackRating === undefined
                  ? before.feedback_rating
                  : input.feedbackRating,
              ],
            )
          ).rows[0];
          await audit(
            db,
            user,
            "participation.corrected",
            "participation",
            participationId,
            {
              before: rowDto(before),
              after: rowDto(changed),
              reason: input.reason,
            },
            ctx.requestId,
          );
          if (input.status === "completed" && before.status !== "completed") {
            await stage(
              db,
              p.employee_id,
              p.event_id,
              "completed",
              date,
              participationId,
            );
            await emit(db, "participation.completed", {
              employeeId: p.employee_id,
              eventId: p.event_id,
              participationId,
              corrected: true,
            });
          }
          if (
            before.session_id &&
            ["completed", "registered", "in_progress"].includes(
              before.status,
            ) &&
            !["completed", "in_progress"].includes(input.status)
          )
            await promoteWaiter(db, before.session_id, asOfDate);
          return {
            participation: rowDto(changed),
            progress: (await loadCareer(db, p.employee_id)).progress,
          };
        },
      );
      send(result);
      return true;
    }
    if (method === "POST" && action) {
      const input = z
        .object({
          date: z.iso.date().optional(),
          score: z.number().int().min(0).max(100).optional(),
          feedbackRating: z.number().int().min(1).max(5).optional(),
          sessionId: z.uuid().optional(),
        })
        .strict()
        .parse(await ctx.body());
      const result = await idempotent(
        ctx,
        `participation.${action}:${participationId}`,
        input,
        async (db) => {
          await lockEmployee(db, p.employee_id);
          await db.query(
            "SELECT event_id FROM events WHERE event_id=$1 FOR SHARE",
            [p.event_id],
          );
          const current = (
            await db.query(
              "SELECT *,date::text FROM participations WHERE id=$1 FOR UPDATE",
              [participationId],
            )
          ).rows[0];
          const asOfDate = await snapshotDate(db),
            date = input.date ?? asOfDate;
          if (date > asOfDate || date < current.date)
            throw new HttpError(
              400,
              "INVALID_ACTION_DATE",
              "Дата должна быть между датой регистрации и датой среза",
            );
          if (action === "complete" && current.status === "completed")
            return {
              participation: rowDto(current),
              progress: (await loadCareer(db, p.employee_id)).progress,
              alreadyCompleted: true,
            };
          if (action === "start" && current.status === "in_progress")
            return { participation: rowDto(current) };
          if (
            action === "drop" &&
            ["dropped", "declined"].includes(current.status)
          )
            return { participation: rowDto(current) };
          if (action === "reschedule") {
            if (
              !eligibility(
                await eventById(db, current.event_id),
                await loadCareer(db, current.employee_id),
                { ignoreActive: true, allowWaitlist: true },
              ).eligible
            )
              throw new HttpError(
                409,
                "EVENT_INELIGIBLE",
                "Мероприятие больше недоступно этому сотруднику",
              );
            if (
              !["registered", "waitlisted"].includes(current.status) ||
              !input.sessionId
            )
              throw new HttpError(
                409,
                "INVALID_TRANSITION",
                "Перенос доступен до начала; нужна новая сессия",
              );
            await db.query(
              "SELECT id FROM event_sessions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
              [[current.session_id, input.sessionId].filter(Boolean)],
            );
            const next = (
              await db.query(
                "SELECT *,session_date::text AS date FROM event_sessions WHERE id=$1 AND event_id=$2",
                [input.sessionId, current.event_id],
              )
            ).rows[0];
            if (!next || next.date <= asOfDate)
              throw new HttpError(
                409,
                "SESSION_UNAVAILABLE",
                "Будущая сессия не найдена",
              );
            const occupied = (
              await db.query(
                "SELECT count(*)::int AS n FROM participations WHERE session_id=$1 AND status IN ('registered','in_progress','completed') AND id<>$2",
                [input.sessionId, participationId],
              )
            ).rows[0].n;
            if (next.capacity !== null && occupied >= next.capacity)
              throw new HttpError(
                409,
                "SESSION_FULL",
                "В выбранной сессии нет места",
              );
            const changed = (
              await db.query(
                "UPDATE participations SET session_id=$2,status='registered' WHERE id=$1 RETURNING *,date::text",
                [participationId, input.sessionId],
              )
            ).rows[0];
            if (current.session_id && current.session_id !== input.sessionId)
              await promoteWaiter(db, current.session_id, asOfDate);
            await audit(
              db,
              user,
              "participation.rescheduled",
              "participation",
              participationId,
              { from: current.session_id, to: input.sessionId },
              ctx.requestId,
            );
            await stage(
              db,
              p.employee_id,
              p.event_id,
              "registered",
              asOfDate,
              participationId,
            );
            return { participation: rowDto(changed) };
          }
          if (
            !["registered", "in_progress", "waitlisted"].includes(
              current.status,
            ) ||
            (action === "complete" && current.status === "waitlisted") ||
            (action === "start" && current.status !== "registered")
          )
            throw new HttpError(
              409,
              "INVALID_TRANSITION",
              "Такой переход статуса недоступен",
            );
          if (current.session_id) {
            const s = (
              await db.query(
                "SELECT session_date::text AS date FROM event_sessions WHERE id=$1 FOR UPDATE",
                [current.session_id],
              )
            ).rows[0];
            if (action !== "drop" && s.date > date)
              throw new HttpError(
                409,
                "SESSION_NOT_STARTED",
                "Сессия ещё не наступила",
              );
          }
          if (action === "complete")
            await assertCompletionAllowed(
              db,
              p.employee_id,
              p.event_id,
              participationId,
            );
          const status =
            action === "start"
              ? "in_progress"
              : action === "complete"
                ? "completed"
                : current.status === "in_progress"
                  ? "dropped"
                  : "declined";
          await db.query(
            "SELECT event_id FROM events WHERE event_id=$1 FOR SHARE",
            [current.event_id],
          );
          const changed = (
            await db.query(
              "UPDATE participations SET status=$2,date=$3,completion_pct=$4,score=COALESCE($5,score),feedback_rating=COALESCE($6,feedback_rating) WHERE id=$1 RETURNING *,date::text",
              [
                participationId,
                status,
                date,
                status === "completed" ? 100 : current.completion_pct,
                input.score ?? null,
                input.feedbackRating ?? null,
              ],
            )
          ).rows[0];
          await audit(
            db,
            user,
            `participation.${action}`,
            "participation",
            participationId,
            { before: current.status, after: status },
            ctx.requestId,
          );
          if (action === "start")
            await stage(
              db,
              p.employee_id,
              p.event_id,
              "started",
              date,
              participationId,
            );
          if (action === "complete") {
            await stage(
              db,
              p.employee_id,
              p.event_id,
              "completed",
              date,
              participationId,
            );
            await emit(db, "participation.completed", {
              employeeId: p.employee_id,
              eventId: p.event_id,
              participationId,
              date,
            });
          }
          if (action === "drop" && current.session_id)
            await promoteWaiter(db, current.session_id, asOfDate);
          return {
            participation: rowDto(changed),
            ...(action === "complete"
              ? { progress: (await loadCareer(db, p.employee_id)).progress }
              : {}),
          };
        },
      );
      send(result);
      return true;
    }
  }
  const feedback = path.match(
    /^\/api\/v1\/recommendations\/([\w-]+)\/feedback$/,
  );
  if (method === "POST" && feedback) {
    const runId = z.uuid().parse(feedback[1]),
      input = z
        .object({
          eventId: id,
          helpful: z.boolean(),
          reason: z.string().max(1000).optional(),
        })
        .strict()
        .parse(await ctx.body());
    const feedbackOwner = (
      await pool.query(
        "SELECT employee_id FROM recommendation_runs WHERE id=$1",
        [runId],
      )
    ).rows[0];
    if (!feedbackOwner || feedbackOwner.employee_id !== user.employeeId)
      throw new HttpError(
        404,
        "NOT_FOUND",
        "Рекомендация не найдена или недоступна",
      );
    const result = await idempotent(
      ctx,
      `recommendation.feedback:${runId}`,
      input,
      async (db) => {
        const run = (
          await db.query(
            "SELECT employee_id,result FROM recommendation_runs WHERE id=$1",
            [runId],
          )
        ).rows[0];
        if (!run || run.employee_id !== user.employeeId)
          throw new HttpError(
            404,
            "NOT_FOUND",
            "Рекомендация не найдена или недоступна",
          );
        if (
          !run.result.recommendations.some(
            (r: { eventId: string }) => r.eventId === input.eventId,
          )
        )
          throw new HttpError(
            400,
            "EVENT_NOT_RECOMMENDED",
            "Мероприятие отсутствует в этой рекомендации",
          );
        return (
          await db.query(
            "INSERT INTO recommendation_feedback(run_id,user_id,event_id,helpful,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,user_id,event_id) DO UPDATE SET helpful=EXCLUDED.helpful,reason=EXCLUDED.reason RETURNING id,helpful,reason",
            [
              runId,
              user.id,
              input.eventId,
              input.helpful,
              input.reason ?? null,
            ],
          )
        ).rows[0];
      },
    );
    send(result);
    return true;
  }
  return false;
}
