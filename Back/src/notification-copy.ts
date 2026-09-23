const translations: Record<string, { kk: string; en: string }> = {
  "Новый запрос на наставничество": {
    kk: "Тәлімгерлікке жаңа сұрау",
    en: "New mentorship request",
  },
  "Статус наставничества обновлён": {
    kk: "Тәлімгерліктің мәртебесі жаңартылды",
    en: "Mentorship status updated",
  },
  "Вам отправили благодарность": {
    kk: "Сізге алғыс жіберілді",
    en: "You received a thank-you",
  },
  "Статус награды обновлён": {
    kk: "Сыйлықтың мәртебесі жаңартылды",
    en: "Reward status updated",
  },
  "Место освободилось": {
    kk: "Бос орын пайда болды",
    en: "A place is available",
  },
  "Вы переведены из очереди в список участников": {
    kk: "Сіз күту кезегінен қатысушылар тізіміне ауыстырылдыңыз",
    en: "You have moved from the waitlist to the participant list",
  },
  "Предстоящая учебная активность": {
    kk: "Алдағы оқу іс-шарасы",
    en: "Upcoming learning activity",
  },
};

/** Preserve authored content; only approved fixed application messages are translated here. */
export function notificationText(source: string, language: unknown): string {
  if (language !== "kk" && language !== "en") return source;
  return translations[source]?.[language] ?? source;
}
