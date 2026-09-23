export type SkillEffect = { skillId: string; gain: number; maxLevel: number };
export type Requirement = {
  skillId: string;
  requiredLevel: number;
  isCritical: boolean;
};
export type Completion = {
  id: string;
  eventId: string;
  date: string;
  status: string;
  effects: SkillEffect[];
};
export type SkillChange = {
  participationId: string;
  eventId: string;
  date: string;
  skillId: string;
  from: number;
  to: number;
};
export const GRADES = ["Junior", "Middle", "Senior", "Lead"] as const;
export const ALGORITHM_VERSION = "career-v1.0";
export function applyEffects(
  levels: Record<string, number>,
  effects: SkillEffect[],
): Record<string, number> {
  const result = { ...levels };
  for (const e of effects) {
    const previous = result[e.skillId] ?? 0;
    result[e.skillId] = Math.min(
      5,
      previous + Math.max(0, Math.min(e.gain, e.maxLevel - previous)),
    );
  }
  return result;
}
export function deriveLevels(
  baseline: Record<string, number>,
  lastReviewDate: string,
  asOfDate: string,
  history: Completion[],
) {
  let levels = { ...baseline };
  const changes: SkillChange[] = [];
  // Input ordering within a date is persisted by the database (created_at, id).
  for (const p of [...history].sort((a, b) => a.date.localeCompare(b.date))) {
    if (
      p.status !== "completed" ||
      p.date <= lastReviewDate ||
      p.date > asOfDate
    )
      continue;
    const after = applyEffects(levels, p.effects);
    for (const effect of p.effects) {
      const from = levels[effect.skillId] ?? 0,
        to = after[effect.skillId] ?? 0;
      if (to !== from)
        changes.push({
          participationId: p.id,
          eventId: p.eventId,
          date: p.date,
          skillId: effect.skillId,
          from,
          to,
        });
    }
    levels = after;
  }
  return { levels, changes };
}
export function progressFor(
  levels: Record<string, number>,
  requirements: Requirement[],
) {
  const required = requirements.reduce((n, r) => n + r.requiredLevel, 0),
    achieved = requirements.reduce(
      (n, r) => n + Math.min(r.requiredLevel, levels[r.skillId] ?? 0),
      0,
    );
  return {
    requiredPoints: required,
    achievedPoints: achieved,
    gapPoints: required - achieved,
    percent: required ? Math.round((achieved / required) * 100) : null,
    criticalGaps: requirements.filter(
      (r) => r.isCritical && (levels[r.skillId] ?? 0) < r.requiredLevel,
    ).length,
  };
}
