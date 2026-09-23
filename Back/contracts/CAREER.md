# Career API

Все пути ниже имеют префикс `/api/v1`. Запросы требуют сеанса, изменяющие запросы — `X-CSRF-Token` и `Idempotency-Key` длиной 8–160 символов. Ключ повторного запроса возвращает сохранённый ответ; другой payload с тем же ключом даёт `409 IDEMPOTENCY_CONFLICT`. Ответы используют общий конверт `{data, meta?}`. В документации показано содержимое `data`.

## Профиль и цель

| Запрос | Результат |
| --- | --- |
| `GET /skills` | Справочник навыков: `id,name,type,category,description`. |
| `GET /role-profiles?role=…&grade=…` | Роли/грейды с `requirements:[{skillId,requiredLevel,isCritical}]`. |
| `GET /employees/:id` | Прежние поля профиля + `goal,progress,asOfDate`. |
| `GET /employees/:id/skills` | Все навыки: `skillId,name,type,baselineLevel,effectiveLevel,requiredLevel,gap,isCritical`. `meta`: дата оценки, дата среза, шкала 0–5, цель. |
| `GET /employees/:id/history` | История, `page,limit` (макс. 100), `status`, `mandatory=true\|false`. Новые регистрации не подменяют исторические строки. |
| `GET /employees/:id/progress` | `goal,progress,changes,asOfDate,promotionDecision:false`; изменения связывают навык с конкретным завершением. |
| `GET /employees/:id/goals` | `{active,history}`; inferred-цель не записывается как принятое сотрудником решение. |
| `PUT /employees/:id/goal` | `{targetRole,targetGrade}`. Старую цель архивирует, проверяет профиль роли, пишет аудит и `goal.changed` в outbox. |
| `DELETE /employees/:id/goal` | Архивирует выбранную цель; может снова показать предварительную цель следующего грейда. |

Цель: `{id?,targetRole,targetGrade,inferred}` либо `null`. Без выбранной цели для Junior/Middle/Senior показывается предварительный следующий грейд текущей роли. Для Lead следующего грейда нет; API возвращает явное пустое состояние. Переход между ролями разрешён, если целевой профиль существует.

`progress`: `requiredPoints,achievedPoints,gapPoints,percent,criticalGaps`. Процент = сумма достигнутых целевых уровней / сумма требуемых уровней; он не означает автоматическое повышение.

Сотрудник видит себя; руководитель — себя и непосредственных подчинённых; HR/администратор — все профили. Руководитель не меняет чужую цель или участие. HR/администратор могут выполнять эти действия с аудитом.

## Каталог и администрирование мероприятий

`GET /events` поддерживает `q,role,grade,skillId,type,format,maxHours,available,mandatory,page,limit`. HR/администратор могут включить `includeInactive=true`. Для проверки доступности передайте `employeeId`; для сотрудника по умолчанию берётся его профиль. Переданный профиль также проверяется по правам. Без профиля фильтр `available` даёт `400 EMPLOYEE_REQUIRED`.

`GET /events/:eventId` возвращает карточку. `GET /events/:eventId/sessions` возвращает сессии с `future`, `occupied`, `available`. Карточка содержит:

```json
{
  "eventId": "DEMO_SQL", "title": "SQL", "description": "Описание",
  "type": "course", "format": "self_paced", "durationHours": 4,
  "mandatory": false, "isActive": true,
  "targetRoles": ["Backend Engineer"], "targetGrades": ["Junior"],
  "effects": [{"skillId": "SK_SQL", "gain": 1, "maxLevel": 4}],
  "prerequisites": [{"skillId": "SK_SQL", "minLevel": 1}],
  "sessions": [],
  "eligibility": {"eligible": true, "reasons": [], "sessionId": null},
  "waitlistEligibility": {"eligible": true, "reasons": [], "sessionId": null}
}
```

Для HR/администратора:

- `POST /events`: создание; поля из примера, кроме вычисленных `eligibility` и `waitlistEligibility`.
- `PATCH /events/:eventId`: частичное редактирование. Массива эффекта/аудитории/сессий заменяются целиком.
- `PUT /events/:eventId`: тот же механизм обновления с проверкой полной объединённой карточки.
- `POST /events/preview?employeeId=…`: полная предлагаемая карточка, возвращает доступность и ожидаемые уровни без сохранения.
- Для архивирования используйте `PATCH {"isActive":false}`. Физическое удаление мероприятий с историей не предусмотрено.

Входная сессия: `{date:"2026-10-10",capacity:20}`; `capacity:null` означает отсутствие ограничения. Выход содержит UUID сессии. Нельзя удалить сессию с участием, уменьшить вместимость ниже занятых мест или поменять формат мероприятия с историей. Изменение вместимости заполняет освободившиеся места из очереди. Публикация активной карточки создаёт `event.published` в outbox.

Причины недоступности: `INACTIVE`, `ROLE_MISMATCH`, `GRADE_MISMATCH`, `PREREQUISITE:<skillId>:<minLevel>`, `ALREADY_COMPLETED`, `ALREADY_ACTIVE`, `NO_FUTURE_SESSION`, `NO_CAPACITY`. Будущая дата должна быть **строго позже даты среза**, а не системной даты машины. Самостоятельное обучение не требует сессии.

## Участие и прогресс

Регистрация:

```http
POST /participations
Idempotency-Key: unique-request-id
```

```json
{"employeeId":"E0001","eventId":"EV_005","sessionId":"UUID для сессии по расписанию","joinWaitlist":false}
```

Для `self_paced` поле `sessionId` не передавайте. Для мероприятия по расписанию без `sessionId` выбирается ближайшая доступная сессия. Если мест нет, `joinWaitlist:true` разрешает статус `waitlisted`. Права, роль/грейд, предварительные навыки, повторы, дата и вместимость проверяются повторно внутри транзакции. Блокировки сотрудника и сессии защищают от двух записей и переполнения при одновременных запросах.

| Запрос | Правило |
| --- | --- |
| `GET /participations/:id` | Доступ согласно владельцу участия. |
| `POST /participations/:id/start {}` | `registered → in_progress`. |
| `POST /participations/:id/complete {score?,feedbackRating?,date?}` | `registered/in_progress → completed`; процент 100; повтор не начисляет эффект. |
| `POST /participations/:id/drop {}` | До начала → `declined`; после начала → `dropped`; место переходит первому подходящему участнику очереди. |
| `POST /participations/:id/reschedule {sessionId}` | Перенос до начала в будущую сессию того же мероприятия; проверяется вместимость и текущая доступность. |
| `PATCH /participations/:id` | Только HR/админ. `{status,reason,date?,completionPct?,score?,feedbackRating?}`. Причина обязательна, до/после записываются в аудит. |

Начать/завершить сессию до её даты нельзя. Дата обычного действия лежит между датой регистрации и датой среза. Исправление HR может менять историческую дату, но не на будущее. Очередь не даёт права завершить обучение до перевода в зарегистрированные участники.

Эффективные навыки каждый раз воспроизводятся из baseline на `lastReviewDate` и завершений **строго после** даты оценки, не позже даты среза. Формула:

```text
new = old + max(0, min(gain, maxLevel - old))
```

Навык не уменьшается, если baseline уже выше `maxLevel`. На момент завершения эффекты копируются в `participations.effects_snapshot`; редактирование каталога не переписывает достижения прошлого. Исправление статуса вызывает расчёт всей актуальной цепочки. Обязательные события без эффектов навыки не меняют.

Событие `participation.completed` записывается в outbox в той же транзакции. Перевод из очереди создаёт персональное уведомление. `career_activity_log` фиксирует наблюдаемые стадии `offered/registered/started/completed` для аналитики; первоначальный исторический импорт не выдумывает отсутствующие стадии.

## Рекомендации

```http
POST /employees/:id/recommendations
```

```json
{"goalId":"необязательный UUID активной цели","useAi":false}
```

Пустой `{}` использует активную/предварительную цель. `goalId` должен совпадать с активной выбранной целью. Ответ:

```text
runId, employeeId, goal, recommendations[1..3], excluded,
source: fallback|ai, model, usageId, fallbackReason,
algorithmVersion, asOfDate, emptyReason, cached, stale, createdAt
```

Каждая рекомендация содержит `eventId,title,score,rank,sessionId,durationHours,expectedGains,factors,factorIds,explanation`. Прирост: `{skillId,from,to,required,gapClosed,isCritical}`. Проверяемые факторы: аудитория/грейд, конкретные разрывы, история, цель/критичность, длительность. Возвращаются только реальные положительные приросты и допустимые события.

Обязательные, неактивные, неподходящие аудитории, недоступные по prerequisites, повторные завершённые и не имеющие свободной будущей сессии события исключаются. Добровольный повтор разрешён только `EV_036`. Повторные циклы обязательных `EV_001–EV_003` доступны в каталоге, но не участвуют в добровольных рекомендациях. Активная запись также исключает повторное предложение.

Рейтинг учитывает критические/прочие разрывы, цель/грейд, историю отказов/пропусков и оценок, длительность. Близкие по баллам варианты разнообразятся по навыкам. Начальные веса можно настроить на сервере:

```dotenv
RECOMMENDATION_WEIGHTS={"critical":0.35,"other":0.20,"goal":0.15,"history":0.15,"availability":0.15}
```

Значения должны быть неотрицательными, сумма > 0; веса нормализуются. Изменение весов входит в хеш входных данных и инвалидирует прежние расчёты.

- `GET /employees/:id/recommendations/latest`: сохранённый результат с проверкой `stale`; чтение ничего не записывает.
- `POST /recommendations/:runId/feedback`: только сам сотрудник; `{eventId,helpful,reason?}`. ID должен присутствовать в выдаче.
- Без цели Lead: `emptyReason:GOAL_REQUIRED`. Без допустимых кандидатов: `NO_ELIGIBLE_EVENTS`.

`useAi:false` не обращается к внешнему провайдеру. `useAi:true` разрешает модели переставить до 8 заранее проверенных кандидатов. Идентификаторы и ссылки на факты валидируются; объяснения сохраняют серверные числовые факты. Платный вызов выполняется **вне** транзакции карьерных изменений: учёт расходов не откатывается, если дальнейшая запись не удалась. Перед сохранением повторно вычисляется входной хеш; изменение профиля/каталога во время вызова приводит к свежему алгоритмическому результату с `CONTEXT_CHANGED`.

Сохранённый `Idempotency-Key` проверяется до AI-вызова. Одинаковые одновременные вызовы одного пользователя объединяются внутри процесса; между несколькими процессами возможно отдельное резервирование расходов, защищённое общим лимитом в БД. Алгоритмический кеш действует до изменения входных данных. Кеш режима AI действует 15 минут и учитывает конфигурацию модели; новый расчёт хранится отдельным run. История запусков содержит алгоритм, хеш входа, список допустимых ID, модель, токены, оценочную стоимость и задержку.

## Повторное использование в Back

```ts
loadCareer(db, employeeId): Promise<CareerProfile>
loadEvents(db): Promise<CareerEvent[]>
eligibility(event, profile, { allowWaitlist?, ignoreActive? }): Eligibility
computeRecommendations(db, employeeId, limit = 3, preloadedEvents?): Promise<Calculation>
applyEffects(levels, effects): Record<string, number>
```

Для HR-агрегации загружайте каталог один раз и передавайте `preloadedEvents`; расчёт не вызывает AI и не пишет run. Доступ к профилю проверяет вызывающий API через `requireEmployeeAccess`.

## Проверки

`tests/career-domain.test.ts`: дата оценки, будущая дата, нулевой навык, ограничения прироста, цели, prerequisites, повторяемость и вместимость. `tests/career.test.ts` использует отдельную случайную схему PostgreSQL и реальные исходные данные: RBAC, идемпотентность, начало/завершение/исправление, неизменность исторических эффектов, конкуренция за последнее место, очередь и уведомления, кеш, смена цели, обратная связь, Lead без цели.

```bash
cd Back
TEST_DATABASE_URL=postgresql://… node --import tsx --test tests/career*.test.ts
```

Тесты не удаляют рабочие таблицы: схема теста удаляется в `finally`. Платные AI-запросы в этих тестах не выполняются.

## Язык объяснений

`factors` и `explanation` локализованы на ru/kk/en по `employees.preferred_language`; язык входит во входной хеш кеша. ID факторов, расчётные значения и порядок рекомендаций не зависят от языка. `event.title` и названия профессий сохраняют исходное значение; утверждённый перевод заголовка Front получает из `GET /events/:eventId/translations`, при отсутствии используется оригинал.
