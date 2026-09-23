import type { Pool } from "pg";
import type { User } from "./auth.js";
import type { Locale } from "./guide.js";
import { computeRecommendations, eligibility, loadEvents } from "./career.js";

type CareerFact = { id: string; text: string; href: string };

const labels = {
  ru: {
    recommendation: "Рекомендация", available: "Доступное обучение",
    duration: "часов", format: "формат", gains: "ожидаемое изменение навыков",
    session: "ближайшая доступная дата", history: "История участия",
    completed: "завершено", registered: "записан", in_progress: "в процессе",
    waitlisted: "лист ожидания", cancelled: "отменено", no_show: "неявка",
    plan: "Активный план", days: "дней", start: "начало", weekly: "часов в неделю",
    steps: "первые шаги плана", planned: "Это сохранённый план; доступность записи проверяется отдельно",
    asOf: "Доступность рассчитана на дату набора данных",
  },
  kk: {
    recommendation: "Ұсыныс", available: "Қолжетімді оқу",
    duration: "сағат", format: "формат", gains: "дағдылардың күтілетін өзгерісі",
    session: "ең жақын қолжетімді күн", history: "Қатысу тарихы",
    completed: "аяқталды", registered: "тіркелді", in_progress: "орындалуда",
    waitlisted: "күту тізімі", cancelled: "бас тартылды", no_show: "келмеді",
    plan: "Белсенді жоспар", days: "күн", start: "басталуы", weekly: "аптасына сағат",
    steps: "жоспардың алғашқы қадамдары", planned: "Бұл сақталған жоспар; тіркелу қолжетімділігі бөлек тексеріледі",
    asOf: "Қолжетімділік деректер жинағының күніне есептелген",
  },
  en: {
    recommendation: "Recommendation", available: "Available learning",
    duration: "hours", format: "format", gains: "expected skill changes",
    session: "next available date", history: "Participation history",
    completed: "completed", registered: "registered", in_progress: "in progress",
    waitlisted: "waitlisted", cancelled: "cancelled", no_show: "no show",
    plan: "Active plan", days: "days", start: "start", weekly: "hours per week",
    steps: "first planned steps", planned: "This is a saved plan; enrollment availability must be checked separately",
    asOf: "Availability calculated at the dataset date",
  },
} as const;

/** Read-only context for the authenticated person's own learning journey. */
export async function additionalCareerFacts(
  pool: Pool,
  user: User,
  locale: Locale,
): Promise<CareerFact[]> {
  // Even HR/admin callers do not receive other employees' personal context.
  const employeeId = user.employeeId;
  if (!employeeId) return [];
  const lang = labels[locale];
  const events = await loadEvents(pool);
  // Reuse the deterministic ranking and the enrollment eligibility rules.
  // This helper performs no writes, AI reranking or external requests.
  const { profile, candidates } = await computeRecommendations(pool, employeeId, 3, events);
  const facts: CareerFact[] = [];
  const selected = new Set<string>();
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  for (const item of candidates) {
    selected.add(item.eventId);
    const event = eventById.get(item.eventId)!;
    const date = event.sessions.find((session) => session.id === item.sessionId)?.date;
    const gains = item.expectedGains.slice(0, 3).map((gain) => {
      const name = profile.skills.find((skill) => skill.skillId === gain.skillId)?.name ?? gain.skillId;
      return `${name}: ${gain.from} → ${gain.to} (${gain.required})`;
    }).join("; ");
    facts.push({
      id: `recommendation:${item.eventId}`,
      text: `${lang.recommendation} #${item.rank}: ${item.title}; ${item.durationHours} ${lang.duration}; ${lang.format}: ${event.format}. ${lang.gains}: ${gains}.${date ? ` ${lang.session}: ${date}.` : ""} ${lang.asOf}: ${profile.asOfDate}.`,
      href: `/events/${encodeURIComponent(item.eventId)}`,
    });
  }
  for (const event of events.filter((item) => !selected.has(item.eventId) && eligibility(item, profile).eligible).slice(0, 5 - candidates.length)) {
    const allowed = eligibility(event, profile);
    const date = event.sessions.find((session) => session.id === allowed.sessionId)?.date;
    facts.push({
      id: `event:${event.eventId}`,
      text: `${lang.available}: ${event.title}; ${event.durationHours} ${lang.duration}; ${lang.format}: ${event.format}.${date ? ` ${lang.session}: ${date}.` : ""} ${lang.asOf}: ${profile.asOfDate}.`,
      href: `/events/${encodeURIComponent(event.eventId)}`,
    });
  }
  for (const item of [...profile.history].reverse().slice(0, 3)) {
    const status = lang[item.status as keyof typeof lang] ?? item.status;
    facts.push({
      id: `participation:${item.id}`,
      text: `${lang.history}: ${item.title}; ${item.date}; ${status}; ${item.completionPct}%.`,
      href: "/history",
    });
  }
  const plans = await pool.query<{
    id: string; target_role: string; target_grade: string; horizon_days: number;
    start_date: string; weekly_hours: number; total_hours: number;
    steps: Array<{ title: string; scheduledDate: string; durationHours: number }>;
  }>(
    `SELECT p.id,p.target_role,p.target_grade,p.horizon_days,p.start_date::text,
      p.weekly_hours::float8,p.total_hours::float8,
      COALESCE((SELECT jsonb_agg(step ORDER BY step.position) FROM (
        SELECT s.position,e.title,s.scheduled_date::text AS "scheduledDate",s.duration_hours::float8 AS "durationHours"
        FROM development_plan_steps s JOIN events e ON e.event_id=s.event_id
        WHERE s.plan_id=p.id ORDER BY s.position LIMIT 4
      ) step),'[]'::jsonb) AS steps
     FROM development_plans p WHERE p.employee_id=$1 AND p.status='active'
     ORDER BY p.created_at DESC,p.id LIMIT 2`,
    [employeeId],
  );
  for (const plan of plans.rows) {
    const steps = plan.steps.map((step) => `${step.title.slice(0, 100)} (${step.scheduledDate}, ${step.durationHours} ${lang.duration})`).join("; ");
    facts.push({
      id: `plan:${plan.id}`,
      text: `${lang.plan}: ${plan.target_role}, ${plan.target_grade}; ${plan.horizon_days} ${lang.days}; ${lang.start}: ${plan.start_date}; ${plan.weekly_hours} ${lang.weekly}; ${plan.total_hours} ${lang.duration}. ${lang.planned}. ${lang.steps}: ${steps}.`,
      href: "/growth?section=plans",
    });
  }
  // Bound provider context independently of arbitrary imported titles/metadata.
  return facts.slice(0, 10).map((fact) => ({ ...fact, text: fact.text.slice(0, 400) }));
}
