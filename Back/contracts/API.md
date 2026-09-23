# Контракт этапов 1–2

Машиночитаемая версия: [openapi.yaml](openapi.yaml) (OpenAPI 3.1, JSON-синтаксис совместим с YAML).

Префикс `/api/v1`. Клиент Vite вызывает относительный URL; proxy направляет запрос на `http://127.0.0.1:3001`. Для локальной разработки backend `APP_ORIGIN=http://localhost:5173`; открывать frontend именно по этому адресу.

Успех: `{ "data": ..., "meta": ... }`. Ошибка: `{ "error": { "code": "...", "message": "...", "details": [], "requestId": "..." } }`. `meta` и `details` необязательны. Коды: 400 невалидный запрос, 401 нет сессии, 403 запрещено, 404 не найден/недоступен профиль, 413 слишком большой запрос, 422 ошибка набора, 429 ограничение входа, 503 БД не готова.

## Вход и сессия

`GET /auth/demo-accounts` → `{ enabled: boolean, accounts: User[] }`. При выключенном DEMO_MODE список пуст.

`POST /auth/login` принимает `{ login: "demo.employee", demo: true }` для демо или `{ login, password }` для обычного аккаунта. Возвращает `{ user: User, csrfToken: string }` и HttpOnly cookie `cq_session`. Клиент не читает cookie через JavaScript.

`GET /auth/me` → `{ user, csrfToken }`; 401 означает гостя. Все изменяющие запросы требуют браузерный Origin = APP_ORIGIN. Все авторизованные POST дополнительно требуют `X-CSRF-Token` из ответа me/login.

`POST /auth/logout` → `{ loggedOut: true }`, отзывает текущую сессию. После 401 убрать данные предыдущего пользователя.

```ts
type User = {
 id: string; login: string; displayName: string;
 role: 'employee' | 'manager' | 'hr' | 'admin';
 employeeId: string | null; demo: boolean;
};
```

## Рабочее пространство и профили

`GET /workspace` → `{ counts: { employees, skills, events, participations }, dataset: { version, asOfDate, importedAt } | null, scope: 'self'|'team'|'organization' }`.

Число сотрудников и участий ограничено правами, каталог навыков/активностей общий. Сотрудник видит себя, руководитель — себя и прямых подчинённых, HR/admin — всех. Профессия в датасете не является ролью доступа.

`GET /employees?q=&page=1&limit=12` → `Employee[]` и `meta: { total, page, limit }`. Максимальный limit 50. Поиск по имени, профессии, отделу.

```ts
type Employee = {
 id: string; name: string; role: string; grade: string;
 department: string; language: 'ru'|'kk'|'en';
};
```

`GET /employees/:id` → Employee плюс `{ managerId: string|null, hireDate: string, tenureMonths: number, workFormat: 'office'|'hybrid'|'remote', lastReviewDate: string, targetRole: string|null, targetGrade: string|null }`. Даты — `YYYY-MM-DD`. Пока это исходный профиль без расчёта прогресса этапов 3–6.

## Импорт — только admin

`POST /imports/preview` и `POST /imports/commit` принимают один и тот же JSON-объект:

```json
{
  "skills": {"meta": {}, "skills": [], "role_profiles": []},
  "employees": {"meta": {}, "employees": []},
  "events": {"meta": {}, "events": []},
  "historyCsv": "record_id,employee_id,event_id,date,due_date,status,completion_pct,score,feedback_rating,assigned_by\n..."
}
```

Вставить полное содержимое соответствующих исходных файлов; пустые meta в примере обозначают место для объекта из файла, а не допустимый импорт. Файлы необязательны по отдельности. Можно загрузить только employees и/или historyCsv; ссылки проверяются по существующей БД и входящим данным. Альтернатива historyCsv — `history` с нормализованным массивом записей (числа number, пустые значения null); вместе оба поля не передавать.

Ответ: `{ hash, counts: {skills, roleProfiles, employees, events, history}, duplicate: boolean, committed: boolean, batchId?: string }`. Counts — размер входящего пакета, не число новых строк. Одинаковый пакет возвращает duplicate=true без повторной записи. Preview ничего не записывает. Commit повторно валидирует тот же пакет. Лимит запроса 10 MiB.

Ошибки 422 содержат `details: [{file,field,message}]`, максимум 100. Импорт атомарен. Существующая история с тем же record_id и другим содержимым отклоняется. Дата среза должна совпадать с текущим набором. Профили обновляются по employee_id; отсутствующие в пакете сотрудники не удаляются.

`GET /imports` → последние 30 пакетов: `[{id,version,asOfDate,counts,importedAt}]`.

## Health

`GET /health/live` → `{status:'ok'}`; `GET /health/ready` → `{status:'ready'}` при доступности мигрированной БД. Эти два метода не требуют входа.

## Моки и реальные запросы

Типы клиента уже находятся в Front/src/api.ts. Для UI-моков можно использовать данные из Back/data, не копируя реальные ключи. Все финальные сценарии проверить с backend: моки не подтверждают авторизацию, CSRF или импорт.
