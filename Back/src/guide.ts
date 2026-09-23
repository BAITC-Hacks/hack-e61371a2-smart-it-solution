import { z } from "zod";
import type { Pool } from "pg";
import type { User } from "./auth.js";
import {
  HttpError,
  type RouteContext,
  type Queryable,
  transaction,
  requireRole,
  audit,
} from "./http.js";

const uuid = z.uuid();
const localeSchema = z.enum(["ru", "kk", "en"]);
export type Locale = z.infer<typeof localeSchema>;
const roles = z
  .array(z.enum(["employee", "manager", "hr", "admin"]))
  .min(1)
  .max(4);
const strings = z.array(z.string().trim().min(1).max(200)).max(30);
const safeUrl = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", "Требуется HTTPS");
const articleShape = z
  .object({
    topicId: uuid,
    locale: localeSchema,
    title: z.string().trim().min(3).max(200),
    summary: z.string().trim().min(3).max(1200),
    body: z.string().trim().min(3).max(16000),
    appliesWhen: z.string().trim().min(3).max(1200),
    steps: z.array(z.string().trim().min(1).max(1500)).max(20).default([]),
    resources: z
      .array(
        z
          .object({ label: z.string().trim().min(1).max(200), url: safeUrl })
          .strict(),
      )
      .max(20)
      .default([]),
    tags: strings.default([]),
    visibility: roles.default(["employee", "manager", "hr", "admin"]),
    departments: strings.default([]),
    aiAllowed: z.boolean().default(false),
    synthetic: z.boolean().default(false),
  })
  .strict();
const topicShape = z
  .object({
    slug: z.string().regex(/^[a-z0-9-]{3,80}$/),
    category: z.string().trim().min(2).max(100),
    sensitivity: z.enum(["normal", "sensitive"]).default("normal"),
    priority: z.number().int().min(0).max(100).default(0),
    active: z.boolean().default(true),
    aliases: z
      .object({
        ru: strings.default([]),
        kk: strings.default([]),
        en: strings.default([]),
      })
      .default({ ru: [], kk: [], en: [] }),
    contexts: z
      .array(
        z.enum([
          "onboarding",
          "review",
          "role_change",
          "learning_start",
          "learning_complete",
        ]),
      )
      .max(5)
      .default([]),
  })
  .strict();
const contactShape = z
  .object({
    label: z.string().trim().min(2).max(200),
    channel: z.enum(["email", "phone", "url", "demo"]),
    value: z.string().trim().min(1).max(500),
    description: z.string().trim().max(1200).default(""),
    visibility: roles.default(["employee", "manager", "hr", "admin"]),
    departments: strings.default([]),
    confidential: z.boolean().default(false),
    active: z.boolean().default(true),
    synthetic: z.boolean().default(false),
    verified: z.boolean().default(false),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.channel === "email" && !z.email().safeParse(v.value).success)
      ctx.addIssue({ code: "custom", message: "Некорректный email" });
    if (v.channel === "url" && !safeUrl.safeParse(v.value).success)
      ctx.addIssue({ code: "custom", message: "Некорректный HTTPS URL" });
    if (v.channel === "phone" && !/^\+?[\d ()-]{5,30}$/.test(v.value))
      ctx.addIssue({ code: "custom", message: "Некорректный телефон" });
    if (v.channel === "demo" && !v.synthetic)
      ctx.addIssue({
        code: "custom",
        message: "Демо-канал требует synthetic=true",
      });
    if (new Date(v.expiresAt).getTime() <= Date.now())
      ctx.addIssue({ code: "custom", message: "Контакт уже устарел" });
  });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return result.data;
}
export async function userDepartment(
  db: Queryable,
  user: User,
): Promise<string | null> {
  if (!user.employeeId) return null;
  return (
    (
      await db.query("SELECT department FROM employees WHERE employee_id=$1", [
        user.employeeId,
      ])
    ).rows[0]?.department ?? null
  );
}
const allowed = `$1=ANY(a.visibility) AND (cardinality(a.departments)=0 OR $2=ANY(a.departments))`;
export type GuideArticle = {
  id: string;
  topic_id: string;
  locale: Locale;
  title: string;
  summary: string;
  body: string;
  applies_when: string;
  steps: string[];
  resources: { label: string; url: string }[];
  tags: string[];
  visibility: string[];
  departments: string[];
  ai_allowed: boolean;
  synthetic: boolean;
  version: number;
  status: string;
  reviewed_at: Date;
  expires_at: Date;
  owner_user_id: string;
  updated_at: Date;
  sensitivity: "normal" | "sensitive";
  slug: string;
  category: string;
};
export async function searchGuide(
  db: Queryable,
  user: User,
  options: {
    locale: Locale;
    q?: string;
    topicId?: string;
    context?: string;
    aiOnly?: boolean;
    limit?: number;
  },
): Promise<GuideArticle[]> {
  const department = await userDepartment(db, user);
  const query = (options.q ?? "").trim().slice(0, 300);
  const result = await db.query(
    `SELECT a.*,t.slug,t.category,t.sensitivity,
  ts_rank_cd(a.search_vector,websearch_to_tsquery('simple',$4)) AS rank
  FROM guide_articles a JOIN guide_topics t ON t.id=a.topic_id
  WHERE ${allowed} AND a.locale=$3 AND a.status='published' AND a.expires_at>now() AND t.active
  AND ($5::uuid IS NULL OR t.id=$5) AND ($6::text IS NULL OR $6=ANY(t.contexts)) AND (NOT $7 OR a.ai_allowed)
  AND ($4='' OR a.search_vector@@websearch_to_tsquery('simple',$4)
    OR (a.locale='ru' AND to_tsvector('russian',a.title||' '||a.summary||' '||a.body)@@websearch_to_tsquery('russian',$4))
    OR a.title ILIKE '%'||$4||'%'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.aliases->a.locale,'[]')) v WHERE lower($4) LIKE '%'||lower(v)||'%' OR lower(v) LIKE '%'||lower($4)||'%')
    OR EXISTS(SELECT 1 FROM unnest(a.tags) tag WHERE lower($4) LIKE '%'||lower(tag)||'%'))
  ORDER BY rank DESC,t.priority DESC,a.updated_at DESC LIMIT $8`,
    [
      user.role,
      department,
      options.locale,
      query,
      options.topicId ?? null,
      options.context ?? null,
      options.aiOnly ?? false,
      Math.min(options.limit ?? 30, 50),
    ],
  );
  return result.rows;
}
export async function getGuideArticle(
  db: Queryable,
  user: User,
  id: string,
  management = false,
): Promise<GuideArticle> {
  const department = await userDepartment(db, user);
  const result = await db.query(
    `SELECT a.*,t.slug,t.category,t.sensitivity FROM guide_articles a JOIN guide_topics t ON t.id=a.topic_id
 WHERE a.id=$3 AND ($4 OR (${allowed} AND a.status='published' AND a.expires_at>now() AND t.active))`,
    [user.role, department, id, management],
  );
  if (!result.rows[0])
    throw new HttpError(
      404,
      "GUIDE_NOT_FOUND",
      "Инструкция не найдена или недоступна",
    );
  return result.rows[0];
}
export async function guideContacts(
  db: Queryable,
  user: User,
  topicId?: string,
) {
  const department = await userDepartment(db, user);
  const rows = (
    await db.query(
      `SELECT r.id AS rule_id,r.topic_id,r.urgency,r.primary_contact_id,r.fallback_contact_id,c.*
 FROM guide_routing_rules r JOIN guide_topics t ON t.id=r.topic_id JOIN contact_channels c ON c.id IN (r.primary_contact_id,r.fallback_contact_id)
 WHERE r.active AND t.active AND ($3::uuid IS NULL OR r.topic_id=$3) AND (r.department IS NULL OR r.department=$2)
 AND c.active AND c.verified_by IS NOT NULL AND c.verified_at IS NOT NULL AND c.expires_at>now()
 AND $1=ANY(c.visibility) AND (cardinality(c.departments)=0 OR $2=ANY(c.departments))
 ORDER BY r.department NULLS LAST,c.confidential DESC,c.label`,
      [user.role, department, topicId ?? null],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    topicId: r.topic_id,
    label: r.label,
    channel: r.channel,
    value: r.value,
    description: r.description,
    confidential: r.confidential,
    synthetic: r.synthetic,
    urgency: r.urgency,
    priority: r.id === r.primary_contact_id ? "primary" : "fallback",
    verifiedAt: r.verified_at,
    expiresAt: r.expires_at,
  }));
}
export async function createDraft(
  db: Queryable,
  user: User,
  value: z.infer<typeof articleShape>,
) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${value.topicId}:${value.locale}`,
  ]);
  const topic = (
    await db.query("SELECT id FROM guide_topics WHERE id=$1", [value.topicId])
  ).rows[0];
  if (!topic) throw new HttpError(404, "TOPIC_NOT_FOUND", "Тема не найдена");
  const next = (
    await db.query(
      "SELECT COALESCE(max(version),0)+1 AS version FROM guide_articles WHERE topic_id=$1 AND locale=$2",
      [value.topicId, value.locale],
    )
  ).rows[0].version;
  return (
    await db.query(
      `INSERT INTO guide_articles(topic_id,locale,version,title,summary,body,applies_when,steps,resources,tags,visibility,departments,ai_allowed,synthetic,owner_user_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        value.topicId,
        value.locale,
        next,
        value.title,
        value.summary,
        value.body,
        value.appliesWhen,
        JSON.stringify(value.steps),
        JSON.stringify(value.resources),
        value.tags,
        value.visibility,
        value.departments,
        value.aiAllowed,
        value.synthetic,
        user.id,
      ],
    )
  ).rows[0];
}
function articleToDraft(a: GuideArticle) {
  return {
    topicId: a.topic_id,
    locale: a.locale,
    title: a.title,
    summary: a.summary,
    body: a.body,
    appliesWhen: a.applies_when,
    steps: a.steps,
    resources: a.resources,
    tags: a.tags,
    visibility: a.visibility,
    departments: a.departments,
    aiAllowed: a.ai_allowed,
    synthetic: a.synthetic,
  };
}

const demoInstructions: Record<string, Record<Locale, string[]>> = {
  "demo-it-access": {
    ru: ["Уточните, какая система недоступна, когда возникла ошибка и что изменилось перед ней. Запишите текст ошибки без паролей и персональных данных.", "Проверьте адрес сайта и подключение к сети. Для Career Quest попробуйте выйти и войти снова. Дополнительные права согласуйте с ответственным за систему.", "Откройте контакты статьи в /guide. Демонстрационный канал показывает, кому адресовать вопрос, но не принимает реальные заявки. Реальный канал ИТ-поддержки уточните у руководителя.", "В обращении укажите систему, время ошибки и влияние на работу. Не передавайте пароли, коды подтверждения или токены. После восстановления повторно проверьте действие."],
    kk: ["Қай жүйе ашылмайтынын, қате уақытын және оған дейін не өзгергенін анықтаңыз. Қате мәтінін құпиясөздер мен жеке деректерсіз жазыңыз.", "Сайт мекенжайы мен желіні тексеріңіз. Career Quest жүйесінен шығып, қайта кіріп көріңіз. Қосымша рұқсатты жүйеге жауапты адаммен келісіңіз.", "/guide мақаласындағы байланыстарды қараңыз. Демо-арна сұрақтың адресатын көрсетеді, бірақ нақты өтініш қабылдамайды. Нақты IT қолдау арнасын басшыдан нақтылаңыз.", "Өтініште жүйені, қате уақытын және жұмысқа әсерін көрсетіңіз. Құпиясөз, растау коды мен токен жібермеңіз. Қалпына келген соң әрекетті қайта тексеріңіз."],
    en: ["Identify the affected system, error time and any preceding changes. Record the error without passwords or personal data.", "Check the website address and network. For Career Quest, try signing out and back in. Agree additional permissions with the system owner.", "Check the article contacts in /guide. Demo channels illustrate who handles the question but cannot receive real requests. Ask your manager for the actual IT support channel.", "Include the system, error time and impact on work. Never share passwords, verification codes or tokens. Retest after access is restored."],
  },
  "demo-leave": {
    ru: ["Сформулируйте вопрос и предполагаемые даты отсутствия. Не вводите медицинские сведения или документы в чат.", "Обсудите с руководителем передачу задач и влияние отсутствия на работу. Это обсуждение не заменяет официальное оформление.", "Найдите инструкцию и HR-контакт в /guide. Демо-контакт не принимает заявки. Реальные правила, остаток дней, документы и порядок согласования уточните у уполномоченного сотрудника.", "После официального согласования уточните, какие задачи и обучение нужно перенести. Проверьте записи на мероприятия в /events. Career Quest не рассчитывает остаток отпуска и не оформляет больничный."],
    kk: ["Сұрақты және жұмыста болмайтын болжамды күндерді анықтаңыз. Чатқа медициналық ақпарат пен құжаттарды енгізбеңіз.", "Тапсырмаларды тапсыру мен жұмысқа әсерін басшымен талқылаңыз. Бұл әңгіме ресми рәсімдеуді алмастырмайды.", "/guide бөлімінен HR байланысы мен нұсқаулықты табыңыз. Демо-байланыс өтініш қабылдамайды. Нақты ережелерді, күндер қалдығын, құжаттар мен келісу тәртібін уәкілетті қызметкерден нақтылаңыз.", "Ресми келісімнен кейін тапсырмалар мен оқуды ауыстыруды нақтылаңыз. /events ішіндегі жазбаларды тексеріңіз. Career Quest демалыс қалдығын есептемейді және еңбекке жарамсыздықты рәсімдемейді."],
    en: ["State your question and proposed absence dates. Do not enter medical details or documents into chat.", "Discuss task handover and workload with your manager. This discussion does not replace formal approval.", "Find the guide and HR contact in /guide. Demo contacts cannot receive requests. Confirm actual rules, leave balance, documents and approval with an authorized person.", "After formal approval, check which tasks and learning activities need rescheduling in /events. Career Quest does not calculate leave balances or process sick leave."],
  },
  "demo-learning": {
    ru: ["В /development проверьте роль, грейд и навыки. Выберите карьерную цель и изучите дефициты навыков.", "Откройте рекомендации и прочитайте объяснение: какие навыки развивает мероприятие и почему оно подходит цели.", "В /events проверьте формат, даты и места, затем запишитесь на подходящее мероприятие. В /growth проверьте план, сроки и нагрузку.", "После фактического прохождения проверьте статус участия и историю обучения. Сопоставьте обновлённые навыки с целью; расчётный прогресс не является гарантией повышения.", "Спросите /assistant: «Почему мне подходит это обучение?» или «Какой следующий шаг к моей цели?». При ошибке в данных уточните сведения у куратора обучения; демо-контакт показывает только пример маршрута обращения."],
    kk: ["/development бөлімінде рөлді, грейдті және дағдыларды тексеріңіз. Мансаптық мақсатты таңдап, дағды тапшылығын қараңыз.", "Ұсыныстардың түсіндірмесін оқыңыз: іс-шара қандай дағдыларды дамытады және мақсатқа неге сәйкес келеді.", "/events ішінде форматты, күндерді және орындарды тексеріп, оқуға жазылыңыз. /growth бөлімінде жоспарды, мерзім мен жүктемені қараңыз.", "Оқуды нақты аяқтаған соң қатысу мәртебесі мен оқу тарихын тексеріңіз. Жаңарған дағдыларды мақсатпен салыстырыңыз; есептік ілгерілеу қызметте өсу кепілдігі емес.", "/assistant көмекшісінен «Бұл оқу маған неге сәйкес келеді?» немесе «Мақсатыма жетудің келесі қадамы қандай?» деп сұраңыз. Дерек қатесі болса, оқу кураторынан нақтылаңыз; демо-байланыс тек өтініш бағытының мысалы."],
    en: ["Review your role, grade and skills in /development. Select a career goal and inspect skill gaps.", "Read recommendation explanations: which skills an activity develops and why it fits your goal.", "Check format, dates and places in /events, then enroll in suitable learning. Review your plan, timeline and workload in /growth.", "After actually completing learning, check participation status and learning history. Compare updated skills with your goal; calculated progress is not a promotion guarantee.", "Ask /assistant: ‘Why does this learning suit me?’ or ‘What is my next step toward my goal?’ Ask the learning coordinator about incorrect data; demo contacts only illustrate a routing example."],
  },
  "demo-onboarding": {
    ru: ["Проверьте имя, подразделение, роль и руководителя в профиле. Уточните несоответствия через привычный рабочий канал.", "Вместе с руководителем перечислите необходимые системы и доступы. При проблеме используйте тему про рабочий доступ в /guide.", "Уточните первые задачи, ожидаемый результат, способ обратной связи и того, кто помогает с рабочими вопросами. Демо-подсказка не является официальным назначением наставника.", "В /development ознакомьтесь с навыками и целями, в /events выберите согласованное обучение, в /growth проверьте план. Через /assistant подготовьте вопросы для встречи с руководителем."],
    kk: ["Профильдегі аты-жөніңізді, бөлімді, рөлді және басшыны тексеріңіз. Сәйкессіздікті әдеттегі жұмыс арнасы арқылы нақтылаңыз.", "Басшымен бірге қажетті жүйелер мен рұқсаттарды тізіңіз. Ақау болса, /guide ішіндегі жұмыс жүйесіне кіру тақырыбын қараңыз.", "Алғашқы тапсырмаларды, нәтижені, кері байланыс жолын және кім көмектесетінін нақтылаңыз. Демо-нұсқау тәлімгерді ресми тағайындамайды.", "/development ішінде дағдылар мен мақсаттарды, /events ішінде келісілген оқуды, /growth ішінде жоспарды қараңыз. /assistant арқылы басшымен кездесуге сұрақтар дайындаңыз."],
    en: ["Check your name, department, role and manager in your profile. Confirm corrections through your usual work channel.", "List required systems and permissions with your manager. For access issues, use the work-access topic in /guide.", "Clarify initial tasks, expected outcomes, feedback channels and who can help. Demo guidance is not an official mentor assignment.", "Explore skills and goals in /development, agreed learning in /events and your plan in /growth. Use /assistant to prepare questions for a meeting with your manager."],
  },
  "demo-conflict": {
    ru: ["Не публикуйте в чате имена других сотрудников, медицинские сведения, документы, секреты или данные клиентов. Для первого вопроса достаточно обезличенного описания.", "Для собственного обращения запишите факты: что произошло, когда и какой рабочий вопрос нужно решить. Отделяйте события от предположений; не загружайте эти записи в демо-систему.", "В /guide найдите действующий реальный контакт с пометкой конфиденциальности. Демонстрационные контакты не принимают обращения и не обеспечивают конфиденциальный канал.", "До отправки уточните, кто увидит обращение и как с вами свяжутся. При необходимости немедленной помощи используйте реальные доступные вам экстренные или внутренние каналы: чат не является каналом расследования или экстренной помощи."],
    kk: ["Чатқа басқа қызметкерлердің атын, медициналық деректерді, құжаттарды, құпияларды немесе клиент деректерін жазбаңыз. Алғашқы сұрақты жеке деректерсіз сипаттаңыз.", "Өзіңіз үшін фактілерді жазыңыз: не болды, қашан және қандай жұмыс мәселесін шешу керек. Оқиға мен болжамды ажыратыңыз; жазбаларды демо-жүйеге жүктемеңіз.", "/guide ішінде құпия деп белгіленген нақты қолданыстағы байланысты табыңыз. Демо-байланыстар өтініш қабылдамайды және құпия арна ұсынбайды.", "Жібермес бұрын өтінішті кім көретінін және сізбен қалай байланысатынын нақтылаңыз. Дереу көмек қажет болса, қолжетімді нақты шұғыл немесе ішкі арналарды пайдаланыңыз: чат тергеу немесе шұғыл көмек арнасы емес."],
    en: ["Do not post other employees’ names, medical details, documents, secrets or customer data in chat. Use an anonymized description for an initial question.", "For your own report, note what happened, when and the work issue to resolve. Separate observations from assumptions; do not upload these notes to the demo.", "Find a current real contact marked confidential in /guide. Demo contacts cannot receive reports or provide a confidential channel.", "Before submitting, confirm who will see the report and how they will contact you. For immediate help, use real emergency or internal channels available to you: chat is not an investigation or emergency service."],
  },
};

function demoResources(paths: string[]) {
  try {
    const origin = new URL(process.env.APP_ORIGIN ?? "");
    if (origin.protocol !== "https:") return [];
    return paths.map((path) => ({ label: `Career Quest · ${path}`, url: new URL(path, origin.origin).href }));
  } catch { return []; }
}

export async function seedDemoGuide(pool: Pool, user: User, refresh = false) {
  return transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(2401904)");
    let created = 0;
    let updated = 0;
    const topics = [
      {
        slug: "demo-it-access",
        category: "it",
        sensitivity: "normal",
        contexts: ["onboarding"],
        aliases: {
          ru: ["vpn", "ноутбук", "доступ", "почта"],
          kk: ["қолжетімділік", "ноутбук"],
          en: ["vpn", "laptop", "access"],
        },
        titles: [
          "Не работает рабочий доступ",
          "Жұмыс жүйесіне кіру мәселесі",
          "Work access is unavailable",
        ],
      },
      {
        slug: "demo-leave",
        category: "hr",
        sensitivity: "normal",
        contexts: [],
        aliases: {
          ru: ["отпуск", "больничный"],
          kk: ["демалыс"],
          en: ["leave", "vacation"],
        },
        titles: [
          "Вопрос об отпуске",
          "Демалыс туралы сұрақ",
          "A question about leave",
        ],
      },
      {
        slug: "demo-learning",
        category: "development",
        sensitivity: "normal",
        contexts: [
          "learning_start",
          "learning_complete",
          "review",
          "role_change",
        ],
        aliases: {
          ru: ["обучение", "навык", "повышение"],
          kk: ["оқу", "дағды"],
          en: ["learning", "skill", "promotion"],
        },
        titles: [
          "Планирование развития",
          "Дамуды жоспарлау",
          "Planning your development",
        ],
      },
      {
        slug: "demo-onboarding",
        category: "onboarding",
        sensitivity: "normal",
        contexts: ["onboarding"],
        aliases: {
          ru: ["первый день", "адаптация"],
          kk: ["бірінші күн", "бейімделу"],
          en: ["first day", "onboarding"],
        },
        titles: [
          "Первые дни работы",
          "Алғашқы жұмыс күндері",
          "Your first days at work",
        ],
      },
      {
        slug: "demo-conflict",
        category: "wellbeing",
        sensitivity: "sensitive",
        contexts: [],
        aliases: {
          ru: ["конфликт", "дискриминация", "безопасность", "утечка"],
          kk: ["жанжал", "қауіпсіздік"],
          en: ["conflict", "discrimination", "security", "leak"],
        },
        titles: [
          "Конфиденциальное обращение",
          "Құпия өтініш",
          "A confidential concern",
        ],
      },
    ];
    const locales = ["ru", "kk", "en"] as const;
    const labels = [
      "Демонстрационный материал. Реальные правила и контакты организации не настроены.",
      "Демонстрациялық материал. Ұйымның нақты ережелері мен байланыстары енгізілмеген.",
      "Demonstration content. Actual company policies and contacts have not been configured.",
    ];
    const steps = [
      "Найдите утверждённую инструкцию и проверенный контакт вашей организации. Не вводите пароли или персональные документы в чат.",
      "Ұйымның бекітілген нұсқаулығын және тексерілген байланысын табыңыз. Чатқа құпиясөздер мен жеке құжаттарды енгізбеңіз.",
      "Find an approved policy and verified contact at your organization. Do not enter passwords or personal documents in chat.",
    ];
    for (const entry of topics) {
      let topic = (
        await db.query(
          `INSERT INTO guide_topics(slug,category,sensitivity,aliases,contexts) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(slug) DO NOTHING RETURNING id`,
          [
            entry.slug,
            entry.category,
            entry.sensitivity,
            entry.aliases,
            entry.contexts,
          ],
        )
      ).rows[0];
      const existingTopic = !topic;
      if (!topic && refresh) topic = (await db.query("SELECT id FROM guide_topics WHERE slug=$1", [entry.slug])).rows[0];
      if (!topic) continue;
      for (let i = 0; i < locales.length; i++) {
        const content = demoInstructions[entry.slug]![locales[i]!]!;
        const paths = [...new Set(content.join(" ").match(/\/(?:development|events|growth|guide|assistant)\b/g) ?? [])];
        // Published versions are immutable. Replace only exact original templates,
        // retaining their access, AI, approval and expiry settings in a new version.
        const original = existingTopic ? (await db.query(
          `SELECT a.* FROM guide_articles a WHERE topic_id=$1 AND locale=$2 AND synthetic AND version=1
           AND status='published' AND title=$3 AND summary=$4 AND body=$5 AND applies_when=$3
           AND steps=$6::jsonb AND resources='[]'::jsonb AND cardinality(tags)=0
           AND NOT EXISTS (SELECT 1 FROM guide_articles newer WHERE newer.topic_id=a.topic_id AND newer.locale=a.locale AND newer.version>1)`,
          [topic.id, locales[i], entry.titles[i], labels[i], `${labels[i]} ${steps[i]}`, JSON.stringify([steps[i]])],
        )).rows[0] as GuideArticle | undefined : undefined;
        if (existingTopic && !original) continue;
        const draft = await createDraft(
          db,
          user,
          parse(articleShape, {
            topicId: topic.id,
            locale: locales[i],
            title: entry.titles[i],
            summary: labels[i],
            body: `${labels[i]}\n\n${content.join("\n\n")}`,
            appliesWhen: entry.titles[i],
            steps: content,
            resources: demoResources(paths),
            visibility: original?.visibility,
            departments: original?.departments,
            aiAllowed: original?.ai_allowed ?? true,
            synthetic: true,
          }),
        );
        if (original) {
          await db.query("UPDATE guide_articles SET status='archived',updated_at=now() WHERE id=$1", [original.id]);
          await db.query(
            `UPDATE guide_articles SET status='published',owner_user_id=$2,approved_by=old.approved_by,reviewed_at=old.reviewed_at,expires_at=old.expires_at
             FROM guide_articles old WHERE guide_articles.id=$1 AND old.id=$3`,
            [draft.id, original.owner_user_id, original.id],
          );
          updated++;
        } else await db.query(
          `UPDATE guide_articles SET status='published',approved_by=$2,reviewed_at=now(),expires_at=now()+interval '90 days' WHERE id=$1`,
          [draft.id, user.id],
        );
        if (!original) created++;
      }
    }
    const demoContacts = [
      { label: "ИТ-поддержка / IT support (демо)", value: "support@career-quest.example", topics: ["demo-it-access"] },
      { label: "HR / Отдел кадров (демо)", value: "hr@career-quest.example", topics: ["demo-leave", "demo-onboarding"] },
      { label: "Куратор обучения / Learning coordinator (демо)", value: "learning@career-quest.example", topics: ["demo-learning"] },
    ];
    for (const contact of demoContacts) {
      const existing = (await db.query("SELECT id FROM contact_channels WHERE synthetic AND channel='demo' AND label=$1 AND value=$2 LIMIT 1", [contact.label, contact.value])).rows[0];
      const row = existing ?? (await db.query(
        `INSERT INTO contact_channels(label,channel,value,description,synthetic,verified_by,verified_at,expires_at)
         VALUES($1,'demo',$2,$3,true,$4,now(),now()+interval '90 days') RETURNING id`,
        [contact.label, contact.value, "Демо / Demo / Демонстрация: адрес .example не принимает почту; реальный контакт организации не настроен. No real delivery. Нақты өтініш жіберілмейді.", user.id],
      )).rows[0];
      for (const slug of contact.topics) await db.query(
        `INSERT INTO guide_routing_rules(topic_id,primary_contact_id)
         SELECT id,$2 FROM guide_topics t WHERE slug=$1 AND NOT EXISTS
         (SELECT 1 FROM guide_routing_rules r WHERE r.topic_id=t.id AND r.active)`,
        [slug, row.id],
      );
    }
    return { created, updated, synthetic: true, realContactsConfigured: false };
  });
}

/** Upgrade untouched demo templates only; edited and real organization content is preserved. */
export async function refreshDemoGuideContent(pool: Pool, user: User) {
  return seedDemoGuide(pool, user, true);
}

/** Only call after seedDemoAccounts and when DEMO_MODE is enabled. */
export async function seedGuideDemo(pool: Pool) {
  const row = (
    await pool.query(`SELECT id,login,display_name AS "displayName",app_role AS role,employee_id AS "employeeId",demo_only AS demo
  FROM user_accounts WHERE demo_only AND app_role='admin' AND active ORDER BY login LIMIT 1`)
  ).rows[0] as User | undefined;
  if (!row) throw new Error("Seed demo accounts before guide demo content");
  return seedDemoGuide(pool, row);
}

export async function handleGuide(ctx: RouteContext): Promise<boolean> {
  const path = ctx.path.replace(/^\/api\/v1(?=\/)/, "");
  if (!path.startsWith("/guide")) return false;
  const { pool, user, method, url } = ctx;
  const management = ["hr", "admin"].includes(user.role);
  if (path === "/guide/demo-seed" && method === "POST") {
    requireRole(user, "admin");
    if (!ctx.config.demo)
      throw new HttpError(
        403,
        "DEMO_DISABLED",
        "Демонстрационный режим выключен",
      );
    const result = await seedDemoGuide(pool, user);
    await audit(
      pool,
      user,
      "guide.demo_seed",
      "guide",
      "demo",
      result,
      ctx.requestId,
    );
    ctx.send(result, 201);
    return true;
  }
  if (path === "/guide/topics") {
    if (method === "GET") {
      const topics = (
        await pool.query(
          `SELECT * FROM guide_topics WHERE active OR $1 ORDER BY priority DESC,category,slug`,
          [management && url.searchParams.get("manage") === "true"],
        )
      ).rows;
      ctx.send(topics);
      return true;
    }
    if (method === "POST") {
      requireRole(user, "hr", "admin");
      const v = parse(topicShape, await ctx.body());
      const row = (
        await pool.query(
          `INSERT INTO guide_topics(slug,category,sensitivity,priority,active,aliases,contexts) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            v.slug,
            v.category,
            v.sensitivity,
            v.priority,
            v.active,
            v.aliases,
            v.contexts,
          ],
        )
      ).rows[0];
      await audit(
        pool,
        user,
        "guide.topic_create",
        "guide_topic",
        row.id,
        {},
        ctx.requestId,
      );
      ctx.send(row, 201);
      return true;
    }
  }
  const topicMatch = path.match(/^\/guide\/topics\/([^/]+)$/);
  if (topicMatch && method === "PATCH") {
    requireRole(user, "hr", "admin");
    const id = parse(uuid, topicMatch[1]);
    const v = parse(topicShape, await ctx.body());
    const row = (
      await pool.query(
        `UPDATE guide_topics SET slug=$2,category=$3,sensitivity=$4,priority=$5,active=$6,aliases=$7,contexts=$8 WHERE id=$1 RETURNING *`,
        [
          id,
          v.slug,
          v.category,
          v.sensitivity,
          v.priority,
          v.active,
          v.aliases,
          v.contexts,
        ],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "TOPIC_NOT_FOUND", "Тема не найдена");
    await audit(
      pool,
      user,
      "guide.topic_update",
      "guide_topic",
      id,
      {},
      ctx.requestId,
    );
    ctx.send(row);
    return true;
  }
  if (path === "/guide/hints" && method === "GET") {
    const context = parse(
      z.enum([
        "onboarding",
        "review",
        "role_change",
        "learning_start",
        "learning_complete",
      ]),
      url.searchParams.get("context"),
    );
    ctx.send(
      await searchGuide(pool, user, {
        locale: parse(localeSchema, url.searchParams.get("locale") ?? "ru"),
        context,
        limit: 5,
      }),
    );
    return true;
  }
  if (path === "/guide/articles") {
    if (method === "GET") {
      const locale = parse(
        localeSchema,
        url.searchParams.get("locale") ?? "ru",
      );
      if (url.searchParams.get("manage") === "true") {
        requireRole(user, "hr", "admin");
        ctx.send(
          (
            await pool.query(
              "SELECT a.*,t.slug,t.category,t.sensitivity FROM guide_articles a JOIN guide_topics t ON t.id=a.topic_id WHERE a.locale=$1 ORDER BY a.updated_at DESC LIMIT 100",
              [locale],
            )
          ).rows,
        );
        return true;
      }
      const topicId = url.searchParams.get("topicId");
      if (topicId) parse(uuid, topicId);
      ctx.send(
        await searchGuide(pool, user, {
          locale,
          q: url.searchParams.get("q") ?? "",
          topicId: topicId ?? undefined,
        }),
      );
      return true;
    }
    if (method === "POST") {
      requireRole(user, "hr", "admin");
      const v = parse(articleShape, await ctx.body());
      const draft = await transaction(pool, async (db) => {
        const row = await createDraft(db, user, v);
        await audit(
          db,
          user,
          "guide.draft_create",
          "guide_article",
          row.id,
          {},
          ctx.requestId,
        );
        return row;
      });
      ctx.send(draft, 201);
      return true;
    }
  }
  const articleMatch = path.match(
    /^\/guide\/articles\/([^/]+)(?:\/(versions|publish|archive|feedback))?$/,
  );
  if (articleMatch) {
    const id = parse(uuid, articleMatch[1]);
    const action = articleMatch[2];
    if (method === "GET" && !action) {
      const article = await getGuideArticle(
        pool,
        user,
        id,
        management && url.searchParams.get("manage") === "true",
      );
      ctx.send({
        ...article,
        contacts: await guideContacts(pool, user, article.topic_id),
      });
      return true;
    }
    if (action === "feedback" && method === "POST") {
      await getGuideArticle(pool, user, id);
      const v = parse(
        z
          .object({
            kind: z.enum([
              "helpful",
              "unhelpful",
              "outdated",
              "wrong_contact",
              "incorrect",
            ]),
            comment: z.string().trim().max(2000).default(""),
          })
          .strict(),
        await ctx.body(),
      );
      const row = (
        await pool.query(
          "INSERT INTO guide_feedback(article_id,user_id,kind,comment) VALUES($1,$2,$3,$4) RETURNING *",
          [id, user.id, v.kind, v.comment],
        )
      ).rows[0];
      ctx.send(row, 201);
      return true;
    }
    if (action === "versions" && method === "GET") {
      requireRole(user, "hr", "admin");
      const a = await getGuideArticle(pool, user, id, true);
      ctx.send(
        (
          await pool.query(
            "SELECT * FROM guide_articles WHERE topic_id=$1 AND locale=$2 ORDER BY version DESC",
            [a.topic_id, a.locale],
          )
        ).rows,
      );
      return true;
    }
    if (action === "versions" && method === "POST") {
      requireRole(user, "hr", "admin");
      const result = await transaction(pool, async (db) => {
        const a = await getGuideArticle(db, user, id, true);
        const row = await createDraft(
          db,
          user,
          parse(articleShape, articleToDraft(a)),
        );
        await audit(
          db,
          user,
          "guide.version_create",
          "guide_article",
          row.id,
          { previous: id },
          ctx.requestId,
        );
        return row;
      });
      ctx.send(result, 201);
      return true;
    }
    if (!action && method === "PATCH") {
      requireRole(user, "hr", "admin");
      const raw = parse(
        articleShape.omit({ topicId: true, locale: true }).partial(),
        await ctx.body(),
      );
      const result = await transaction(pool, async (db) => {
        await db.query("SELECT id FROM guide_articles WHERE id=$1 FOR UPDATE", [
          id,
        ]);
        const a = await getGuideArticle(db, user, id, true);
        if (a.status !== "draft")
          throw new HttpError(
            409,
            "IMMUTABLE_VERSION",
            "Создайте новую версию опубликованной статьи",
          );
        const v = parse(articleShape, { ...articleToDraft(a), ...raw });
        const row = (
          await db.query(
            `UPDATE guide_articles SET title=$2,summary=$3,body=$4,applies_when=$5,steps=$6,resources=$7,tags=$8,visibility=$9,departments=$10,ai_allowed=$11,synthetic=$12,updated_at=now() WHERE id=$1 RETURNING *`,
            [
              id,
              v.title,
              v.summary,
              v.body,
              v.appliesWhen,
              JSON.stringify(v.steps),
              JSON.stringify(v.resources),
              v.tags,
              v.visibility,
              v.departments,
              v.aiAllowed,
              v.synthetic,
            ],
          )
        ).rows[0];
        await audit(
          db,
          user,
          "guide.draft_update",
          "guide_article",
          id,
          {},
          ctx.requestId,
        );
        return row;
      });
      ctx.send(result);
      return true;
    }
    if (action === "publish" && method === "POST") {
      requireRole(user, "hr", "admin");
      const v = parse(
        z
          .object({
            humanReviewed: z.literal(true),
            expiresAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
        await ctx.body(),
      );
      const expiration = new Date(v.expiresAt).getTime();
      if (expiration <= Date.now() || expiration > Date.now() + 366 * 86400000)
        throw new HttpError(
          400,
          "INVALID_EXPIRY",
          "Срок проверки должен быть в течение года",
        );
      const result = await transaction(pool, async (db) => {
        const a = await getGuideArticle(db, user, id, true);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${a.topic_id}:${a.locale}`,
        ]);
        const locked = (
          await db.query(
            "SELECT status FROM guide_articles WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (locked.status !== "draft")
          throw new HttpError(
            409,
            "IMMUTABLE_VERSION",
            "Публиковать можно только черновик",
          );
        if (a.sensitivity === "sensitive" && !a.synthetic) {
          const contacts = await guideContacts(db, user, a.topic_id);
          if (!contacts.some((c) => c.confidential && !c.synthetic))
            throw new HttpError(
              409,
              "VERIFIED_CONTACT_REQUIRED",
              "Для чувствительной темы нужен проверенный конфиденциальный канал",
            );
        }
        await db.query(
          `UPDATE guide_articles SET status='archived',updated_at=now() WHERE topic_id=$1 AND locale=$2 AND status='published'`,
          [a.topic_id, a.locale],
        );
        const row = (
          await db.query(
            `UPDATE guide_articles SET status='published',approved_by=$2,reviewed_at=now(),expires_at=$3,updated_at=now() WHERE id=$1 RETURNING *`,
            [id, user.id, v.expiresAt],
          )
        ).rows[0];
        await audit(
          db,
          user,
          "guide.publish",
          "guide_article",
          id,
          { version: a.version, synthetic: a.synthetic },
          ctx.requestId,
        );
        return row;
      });
      ctx.send(result);
      return true;
    }
    if (action === "archive" && method === "POST") {
      requireRole(user, "hr", "admin");
      await getGuideArticle(pool, user, id, true);
      const row = (
        await pool.query(
          `UPDATE guide_articles SET status='archived',updated_at=now() WHERE id=$1 RETURNING *`,
          [id],
        )
      ).rows[0];
      await audit(
        pool,
        user,
        "guide.archive",
        "guide_article",
        id,
        {},
        ctx.requestId,
      );
      ctx.send(row);
      return true;
    }
  }
  if (path === "/guide/contacts" && method === "GET") {
    if (url.searchParams.get("manage") === "true") {
      requireRole(user, "hr", "admin");
      ctx.send(
        (
          await pool.query(
            "SELECT * FROM contact_channels ORDER BY updated_at DESC LIMIT 100",
          )
        ).rows,
      );
      return true;
    }
    const topicId = url.searchParams.get("topicId");
    if (topicId) parse(uuid, topicId);
    ctx.send(await guideContacts(pool, user, topicId ?? undefined));
    return true;
  }
  const contactMatch = path.match(/^\/guide\/contacts(?:\/([^/]+))?$/);
  if (
    contactMatch &&
    ((!contactMatch[1] && method === "POST") ||
      (contactMatch[1] && method === "PUT"))
  ) {
    requireRole(user, "hr", "admin");
    const v = parse(contactShape, await ctx.body());
    const id = contactMatch[1] ? parse(uuid, contactMatch[1]) : null;
    const values = [
      v.label,
      v.channel,
      v.value,
      v.description,
      v.visibility,
      v.departments,
      v.confidential,
      v.active,
      v.synthetic,
      v.verified ? user.id : null,
      v.expiresAt,
    ];
    const sql = id
      ? `UPDATE contact_channels SET label=$1,channel=$2,value=$3,description=$4,visibility=$5,departments=$6,confidential=$7,active=$8,synthetic=$9,verified_by=$10,verified_at=CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END,expires_at=$11,updated_at=now() WHERE id=$12 RETURNING *`
      : `INSERT INTO contact_channels(label,channel,value,description,visibility,departments,confidential,active,synthetic,verified_by,expires_at,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END) RETURNING *`;
    const row = (await pool.query(sql, id ? [...values, id] : values)).rows[0];
    if (!row)
      throw new HttpError(404, "CONTACT_NOT_FOUND", "Контакт не найден");
    await audit(
      pool,
      user,
      id ? "guide.contact_update" : "guide.contact_create",
      "contact",
      row.id,
      { verified: v.verified },
      ctx.requestId,
    );
    ctx.send(row, id ? 200 : 201);
    return true;
  }
  if (path === "/guide/routing" && method === "GET") {
    requireRole(user, "hr", "admin");
    ctx.send(
      (
        await pool.query(
          "SELECT * FROM guide_routing_rules ORDER BY topic_id LIMIT 200",
        )
      ).rows,
    );
    return true;
  }
  const routingMatch = path.match(/^\/guide\/routing(?:\/([^/]+))?$/);
  if (
    routingMatch &&
    ((!routingMatch[1] && method === "POST") ||
      (routingMatch[1] && method === "PUT"))
  ) {
    requireRole(user, "hr", "admin");
    const v = parse(
      z
        .object({
          topicId: uuid,
          department: z.string().min(1).max(200).nullable().default(null),
          primaryContactId: uuid.nullable().default(null),
          fallbackContactId: uuid.nullable().default(null),
          urgency: z.enum(["normal", "urgent"]).default("normal"),
          active: z.boolean().default(true),
        })
        .strict()
        .refine(
          (v) => v.primaryContactId || v.fallbackContactId,
          "Нужен хотя бы один контакт",
        ),
      await ctx.body(),
    );
    const id = routingMatch[1] ? parse(uuid, routingMatch[1]) : null;
    const values = [
      v.topicId,
      v.department,
      v.primaryContactId,
      v.fallbackContactId,
      v.urgency,
      v.active,
    ];
    const row = (
      await pool.query(
        id
          ? "UPDATE guide_routing_rules SET topic_id=$1,department=$2,primary_contact_id=$3,fallback_contact_id=$4,urgency=$5,active=$6 WHERE id=$7 RETURNING *"
          : "INSERT INTO guide_routing_rules(topic_id,department,primary_contact_id,fallback_contact_id,urgency,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        id ? [...values, id] : values,
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "ROUTE_NOT_FOUND", "Маршрут не найден");
    await audit(
      pool,
      user,
      "guide.routing_save",
      "guide_route",
      row.id,
      {},
      ctx.requestId,
    );
    ctx.send(row, id ? 200 : 201);
    return true;
  }
  if (path === "/guide/feedback" && method === "GET") {
    requireRole(user, "hr", "admin");
    ctx.send(
      (
        await pool.query(
          "SELECT * FROM guide_feedback ORDER BY created_at DESC LIMIT 100",
        )
      ).rows,
    );
    return true;
  }
  const feedbackMatch = path.match(/^\/guide\/feedback\/([^/]+)\/resolve$/);
  if (feedbackMatch && method === "POST") {
    requireRole(user, "hr", "admin");
    const row = (
      await pool.query(
        "UPDATE guide_feedback SET resolved_at=now(),resolved_by=$2 WHERE id=$1 RETURNING *",
        [parse(uuid, feedbackMatch[1]), user.id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "FEEDBACK_NOT_FOUND", "Отзыв не найден");
    ctx.send(row);
    return true;
  }
  return false;
}
