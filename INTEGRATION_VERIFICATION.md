# Совместный запуск Front и Back

Интеграция от 23.09.2026 объединяет готовый frontend из `main` (`4a74f4d`) и серверную ветку помощника `codex/nvidia-assistant` (`2f985c4`). История обоих участников сохранена обычным merge.

## Что соединено

- Все экраны обращаются к `/api/v1` через общий origin, cookie-сессию и CSRF. Vite передаёт запросы локальному backend; production использует Nginx.
- Для явных AI-запросов frontend и Nginx ждут до 90 секунд при серверном лимите модели до 60 секунд. Обычные запросы сохраняют короткий timeout. Повтор неопределённого сообщения сохраняет ключ идемпотентности и исходный текст; новая попытка доступна после защитной задержки 120 секунд.
- Админка отдельно показывает провайдера генерации и готовность embeddings. Наличие настроек не выдаётся за проверку доступности модели. Журнал стоимости OpenAI не включает оплату GPU.
- Brev launcher сохраняет основной `.env` и накладывает `.env.brev`, чтобы не терять настройки БД, origin и входа.
- Переводы публичного офлайн-экрана вынесены в отдельный скрипт для совместимости с production CSP. Личные данные не кешируются.

## Локальная разработка без GPU

Нужны Node.js 24.19.0 и PostgreSQL. Backend использует миграции до `008_semantic.sql`. Настройте существующий `Back/.env` или создайте его из `Back/.env.example`, если файла ещё нет:

```dotenv
API_PORT=3001
APP_ORIGIN=http://localhost:5173
# DATABASE_URL указывает на вашу локальную базу PostgreSQL.
DEMO_MODE=true
COOKIE_SECURE=false
DATASET_PATH=./data
AI_ENABLED=false
AI_EMBEDDING_ENABLED=false
WORKER_DELIVERY_ENABLED=false
INTEGRATION_TARGETS_JSON={}
```

Из `Back`:

```bash
npm ci
npm run migrate
npm run seed
npm run dev
```

В другом терминале из `Front`:

```bash
npm ci
npm run dev
```

Открыть **http://localhost:5173**. Доступны четыре демо-роли. Помощник сохраняет диалоги и явно обозначает резервный ответ без генерации моделью. ИИ подключается напарником отдельно по [инструкции NVIDIA Brev](Back/NVIDIA_BREV_SETUP.md); ключи остаются на сервере.

Vite по умолчанию направляет `/api` на `http://127.0.0.1:3001`. Для другого порта задайте `CQ_API_PROXY_TARGET` в окружении процесса Vite. `APP_ORIGIN` backend должен совпадать с адресом frontend. В браузере адрес API остаётся относительным.

Контейнерный вариант из корня: `docker compose up -d --build --wait`, интерфейс **http://localhost:8080**. Для Brev используйте `python3 infra/brev/compose.py up -d --build --wait`; на Windows команда Python может называться `python`.

## Проверено 23.09.2026

Для интеграционных сценариев создана отдельная одноразовая БД `integration_acceptance_20260923`, применены все 8 миграций и загружен синтетический набор из `Back/data`. PostgreSQL 18.4, Node.js 24.19.0, Edge 153. В Compose целевая версия PostgreSQL — 17.

| Проверка | Результат |
| --- | --- |
| Backend AI, semantic и capability metadata, реальная PostgreSQL, внешние провайдеры замоканы | 33 прошли |
| Браузерные проверки UI с явными моками API | 21 прошла |
| Браузер → Vite proxy → реальный backend → PostgreSQL | 16 прошли |
| Production PWA и перевод при строгой CSP | 2 прошли |
| Brev launcher, без Docker и SSH | 10 прошли |
| TypeScript и production-сборка Back и Front | Прошли |

Реальные сценарии покрывают вход по паролю, четыре роли, импорт, карьерную цель, обучение с пересчётом прогресса, планы, LMS, базу знаний, резервный ответ помощника, администрирование, HR, уведомления, календарь и отзыв собственной тестовой сессии. Generation и embeddings явно выключены, внешние доставки отключены.

Команды браузерных проверок: [Front/tests/README.md](Front/tests/README.md). Backend: `TEST_DATABASE_URL=... node --import tsx --test tests/ai-status.test.ts tests/ai.test.ts tests/semantic.test.ts` из `Back`; только одноразовая тестовая БД. Launcher: `python -B -m unittest discover -s infra/brev -p test_compose.py` из корня.

## Границы проверки

Docker отсутствовал на интеграционной машине: новая сборка контейнеров, реальный Nginx и SSH-туннель здесь не запускались. CSP проверена браузером с соответствующим заголовком ответа. Живая модель/GPU, качество генерации, OIDC и корпоративные внешние сервисы требуют отдельной настройки и не проверялись. Локальные результаты не подтверждают прохождение GitHub Actions; запуск CI зависит в том числе от состояния billing аккаунта репозитория.
