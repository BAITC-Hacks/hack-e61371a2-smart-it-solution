# HR, администрирование и импорт

Базовый путь `/api/v1`. Сессия, Origin, CSRF и ошибки описаны в [README](README.md). Все методы возвращают `{data,meta?}`. Для перечисленных ниже PUT/PATCH/POST администратора требуется `Idempotency-Key`, кроме импорта (его ключ — SHA-256 содержимого).

## HR и руководитель

HR/admin: `/hr/*`. Manager/hr/admin: `/manager/overview`; для manager выборка ограничена собой и прямыми подчинёнными.

Общие фильтры GET overview/skill-gaps/participation/programs/no-next-step/funnel/trends/engagement-signals: `department`, `role`, `grade`, `from`, `to`. Даты YYYY-MM-DD; обратный период отклоняется. Текущие skill gaps не ограничиваются датами участия. Для funnel/participation период по умолчанию — последние 90 дней до среза датасета.

| Метод и путь                            | Результат                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| GET `/hr/overview`, `/manager/overview` | `asOfDate,period,scope,employees,skillGaps,noNextStep,participation,programs,summaries,methodology`           |
| GET `/hr/skill-gaps`                    | `skillId,name,employees,totalGap,criticalEmployees` для каждого дефицита                                      |
| GET `/hr/no-next-step`                  | Сотрудники без допустимых рекомендаций и объединённые причины исключения                                      |
| GET `/hr/participation`                 | По мероприятию: records, participants, registered, started, completed, incomplete, averageRating              |
| GET `/hr/programs`                      | Participation + observedSkillPoints, observedGapClosure, employeesWithObservedGain                            |
| GET `/hr/funnel`                        | `period,stages,methodology`; offered → registered → started → completed, records/employees/employeeEventPairs |
| GET `/hr/trends`                        | `snapshots,hasLongitudinalData,methodology`; baseline навыков по датам импортированных оценок                 |
| POST `/hr/team-simulation`              | Гипотетические gapBefore/gapAfter для `employeeIds: string[1..100]`, `eventIds: string[1..30]`                |
| GET `/hr/engagement-signals`            | Объяснимые сигналы по добровольным активностям; `attrition.available=false` без размеченных исходов           |
| PUT `/hr/program-financials/{eventId}`  | Утверждённые `currency` (ISO, 3 буквы), `cost`, `measuredBenefit: number                                      | null`, `methodology` (20–4000 символов) |
| GET `/hr/roi`                           | `available,programs,methodology`; ROI=(benefit−cost)/cost×100, null при отсутствии достаточных данных         |

Сравнение программ учитывает рассчитанные эффекты завершений **после последней оценки** и текущую цель сотрудника. Это расчёт по модели навыков, а не доказательство причинного финансового эффекта. Воронка фиксирует только наблюдавшиеся действия платформы: импортированный completed не означает, что были зафиксированы offered/registered/started. Счётчики стадий внутри периода не выдаются за конверсию одной когорты. История оценок не подменяется сгенерированным трендом.

Командная симуляция явно возвращает `eligibilityChecked:false`: это оценка эффектов при условии завершения всех указанных мероприятий. Проверяемый по prerequisites индивидуальный сценарий находится в [GROWTH](GROWTH.md).

## Аккаунты и аудит

| Метод и путь                 | Права / тело                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| GET `/auth/sessions`         | Свои сессии: id,expiresAt,revokedAt                                                        |
| DELETE `/auth/sessions/{id}` | Отозвать свою сессию; cookie текущей сессии становится недействительным                    |
| GET `/admin/accounts`        | Admin; список без password_hash                                                            |
| POST `/admin/accounts`       | Admin; login,displayName,role,employeeId:string                                            | null,password (12–256 символов) |
| PATCH `/admin/accounts/{id}` | Admin; непустое подмножество active,role,employeeId,password; отзывает все сессии аккаунта |
| GET `/admin/audit`           | Admin; page≥1,limit1..100 (30),action?; meta.total/page/limit                              |
| PUT `/admin/oidc-identities` | Admin; issuer HTTPS,subject,userId; только обычный аккаунт, не demo                        |

Для employee/manager employeeId обязателен. Последнего активного администратора нельзя отключить или лишить роли. Роль профессии в employees никак не повышает права приложения. Связь OIDC не создаётся по совпадению email или роли из внешнего токена.

## Переводы мероприятий

GET `/events/{eventId}/translations` — опубликованные переводы. PUT `/events/{eventId}/translations/{ru|kk|en}` — HR/admin, `{title,description}`, утверждение с автором и датой. Исходный текст каталога сохраняется. Выбор перевода интерфейсом не меняет бизнес-логику.

## Импорт

Admin: GET `/imports`, POST `/imports/preview`, POST `/imports/commit`. Тело до 10 MiB: `skills?`, `employees?`, `events?`, `history?` либо `historyCsv?`. Схема повторяет четыре файла `Back/data/`; частичный импорт дополнительных профилей/истории поддерживается.

Ответ: `hash,counts,changes,warnings,duplicate,committed,batchId?`.

```json
{
  "changes": {
    "employees": {
      "new": 1,
      "updated": 2,
      "unchanged": 197,
      "sampleIds": { "new": ["JURY_001"], "updated": ["EMP_001", "EMP_002"] }
    }
  }
}
```

Примеры ID выше иллюстрируют структуру; алгоритм не фиксирует список ID. sampleIds ограничен первыми 50, счётчики полные. Preview выполняется без изменений, commit повторно проверяет актуальные ссылки в транзакции. Отсутствующие в пакете сотрудники/мероприятия не удаляются. Мета-срез существующего набора не меняется произвольным импортом. Будущие записи истории отклоняются; будущие due_date и сессии разрешены. Сессии сохраняют ID/вместимость; удалить сессию с историей или поменять формат мероприятия с участиями нельзя.

`422 INVALID_DATASET` содержит details[{file,field,message}]. Существующий source_record_id неизменяем: исправление участия проходит через отдельный аудируемый endpoint Career. Снимки baseline сохраняются для трендов. Источники изменений фиксируются в dataset_batches, audit_log и временных полях доменных таблиц.

Восстановление локальной demo-БД и резервные копии — [OPERATIONS](../OPERATIONS.md).
