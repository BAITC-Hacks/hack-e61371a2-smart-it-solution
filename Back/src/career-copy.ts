/** Increment when changing rendered facts so cached recommendation runs refresh. */
export const CAREER_COPY_VERSION = "career-copy-v1";

type Context = {
  role: string;
  grade: string;
  gains: Array<{
    skillId: string;
    from: number;
    to: number;
    required: number;
    gapClosed: number;
  }>;
  participations: number;
  completions: number;
  negativeHistory: number;
  goal: { targetRole: string; targetGrade: string; inferred: boolean };
  criticalGain: number;
  otherGain: number;
  durationHours: number;
  format: string;
};
type Locale = "ru" | "kk" | "en";
const formats: Record<Locale, Record<string, string>> = {
  ru: {
    online: "онлайн",
    offline: "очно",
    self_paced: "самостоятельное обучение",
  },
  kk: { online: "онлайн", offline: "офлайн", self_paced: "өз бетінше оқу" },
  en: {
    online: "online",
    offline: "in person",
    self_paced: "self-paced learning",
  },
};

/** Only labels are localized. Source role/grade/skill IDs and numeric facts remain unchanged. */
export function careerFactors(
  language: unknown,
  c: Context,
): Array<{ id: string; text: string }> {
  const locale: Locale =
    language === "kk" || language === "en" ? language : "ru";
  const format = formats[locale][c.format] ?? c.format;
  const copy = {
    ru: {
      grade: `Текущая роль ${c.role}, грейд ${c.grade} входят в аудиторию мероприятия.`,
      skill_gap: c.gains
        .map(
          (g) =>
            `${g.skillId}: ${g.from} → ${g.to}, требование ${g.required}, сокращение разрыва ${g.gapClosed}`,
        )
        .join("; "),
      history: `Предыдущих участий: ${c.participations}; завершений: ${c.completions}; отказов/пропусков: ${c.negativeHistory}.`,
      goal: `${c.goal.inferred ? "Предложенная" : "Выбранная"} цель: ${c.goal.targetRole} / ${c.goal.targetGrade}. Критические разрывы сокращаются на ${c.criticalGain}, прочие на ${c.otherGain}.`,
      duration: `Длительность: ${c.durationHours} ч.; формат: ${format}.`,
    },
    kk: {
      grade: `Ағымдағы рөл ${c.role} және ${c.grade} деңгейі іс-шара аудиториясына сәйкес келеді.`,
      skill_gap: c.gains
        .map(
          (g) =>
            `${g.skillId}: ${g.from} → ${g.to}, талап ${g.required}, айырманың азаюы ${g.gapClosed}`,
        )
        .join("; "),
      history: `Бұрынғы қатысулар: ${c.participations}; аяқталғаны: ${c.completions}; бас тарту/өткізіп алу: ${c.negativeHistory}.`,
      goal: `${c.goal.inferred ? "Ұсынылған" : "Таңдалған"} мақсат: ${c.goal.targetRole} / ${c.goal.targetGrade}. Маңызды дағдылардағы айырма ${c.criticalGain} ұпайға, қалғаны ${c.otherGain} ұпайға азаяды.`,
      duration: `Ұзақтығы: ${c.durationHours} сағ.; формат: ${format}.`,
    },
    en: {
      grade: `The current role ${c.role} and grade ${c.grade} match the event audience.`,
      skill_gap: c.gains
        .map(
          (g) =>
            `${g.skillId}: ${g.from} → ${g.to}, required ${g.required}, gap reduction ${g.gapClosed}`,
        )
        .join("; "),
      history: `Previous participations: ${c.participations}; completions: ${c.completions}; withdrawals/declines/missed events: ${c.negativeHistory}.`,
      goal: `${c.goal.inferred ? "Suggested" : "Selected"} goal: ${c.goal.targetRole} / ${c.goal.targetGrade}. Critical gaps decrease by ${c.criticalGain}, other gaps by ${c.otherGain}.`,
      duration: `Duration: ${c.durationHours} hours; format: ${format}.`,
    },
  };
  return Object.entries(copy[locale]).map(([id, text]) => ({ id, text }));
}
