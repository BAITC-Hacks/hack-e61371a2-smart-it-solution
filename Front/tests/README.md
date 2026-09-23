# Frontend browser checks

`npm run test:e2e` runs 21 explicit UI contract scenarios across `frontend.contract.spec.ts`, `guide.semantic.spec.ts`, `navigation.contract.spec.ts`, `assistant.integration.contract.spec.ts` and `career.integration.contract.spec.ts`.
Install the test browser once with `npx playwright install chromium`. To use an installed
Chrome or Edge, set `CQ_BROWSER_CHANNEL=chrome` or `CQ_BROWSER_CHANNEL=msedge`.

The mock fixture only intercepts `/api/v1/**`. It covers loading a saved session, demo
login/logout, login errors, expired sessions, role restrictions, employee search and
pagination, profile errors, mobile navigation, language switching, import validation,
immutable preview/commit payloads, duplicate packages, and stale preview responses.
These checks do **not** establish that real API authorization or transactions work.

## Real API and PostgreSQL

`frontend.api.spec.ts` is opt-in and requires the real Back server with a migrated,
seeded **disposable test database**. The admin case adds a synthetic employee and
an import batch. Do not run it against production or a shared development database.

Start the existing backend using its documented setup, with `DEMO_MODE=true`,
`APP_ORIGIN=http://localhost:5173`, and API port 3001. Then set:

```powershell
$env:CQ_E2E_REAL_API = '1'
# Optional if Back/data is not adjacent to Front:
$env:CQ_DATASET_PATH = 'C:\path\to\Back\data'
npm run test:e2e
```

To include password login, create a disposable non-demo account using Back's `account`
command and pass its login/password through `CQ_TEST_ACCOUNT_LOGIN` and
`CQ_TEST_ACCOUNT_PASSWORD`. The credentials are never saved by these tests.

The real suite checks all four roles, visible profiles and server scope, existing
out-of-scope profiles, import authorization, session restore and logout, valid import
preview/commit, duplicate detection, and reference validation errors. It uses the
actual HttpOnly session cookie and CSRF tokens through the Vite proxy.

Vite starts automatically unless a server is already listening on localhost:5173.
Set `CQ_BASE_URL` to use a different already-running frontend; its origin must match
the backend's `APP_ORIGIN`. Reports and failure traces are generated under
`playwright-report/` and `test-results/`.
## Full platform acceptance

`CQ_E2E_FULL_API=1` enables the full application scenarios. Use a newly created,
seeded disposable database and the current full backend. `AI_ENABLED=false` is
and `AI_EMBEDDING_ENABLED=false` are required for the guide test; no external integrations or worker should be enabled.
These tests intentionally change synthetic goals, events, participation, plans,
mentor/reward data, accounts, guide content, HR financial examples and notification
preferences. They must never target a production or shared database.

```powershell
$env:CQ_E2E_FULL_API = '1'
$env:CQ_BASE_URL = 'http://localhost:5173'
$env:CQ_BROWSER_CHANNEL = 'msedge' # Or install Chromium and omit this.
npx playwright test tests/career.full.api.spec.ts tests/growth.full.api.spec.ts tests/guide.full.api.spec.ts tests/platform.full.api.spec.ts
```

Run these suites with one worker. They create uniquely named synthetic records;
career and growth tests share the demo employee, so do not run those two suites
concurrently. The current-session revocation scenario needs the same dedicated
password-account environment variables as the original real API suite, and expects
that account to have no other active session.

- Career: goal persistence, actual recommendations, HR preview/create/translation,
  enrollment/start/completion, one skill increment, history and mobile layout.
- Growth: 30/90/180 plans, version conflicts, preferences, comparison/simulation,
  tasks, mentor opt-in/approval, reward policy/catalog, ID mapping and immutable
  LMS retry after an error.
- Guide: draft/publication/version/archive, contacts/routing/feedback, account
  management/audit, assistant fallback/thread persistence/deletion, semantic SQL
  fallback with paid inference disabled.
- Platform: actual HR filters/tabs/simulation/approved financial inputs, manager
  scope, notifications/preferences/calendar, session revocation and role boundaries.

`guide.semantic.spec.ts` and `navigation.contract.spec.ts` use explicit mocked API
responses to check semantic workflow idempotency, stale responses, activation,
query preservation and safe notification links. They never call an AI provider.

## Production PWA

Build and run a preview separately:

```powershell
npm run build
npm run preview -- --port 5174
# In another terminal:
$env:CQ_E2E_PWA = '1'
$env:CQ_BASE_URL = 'http://localhost:5174'
npx playwright test tests/pwa.spec.ts
```

Two scenarios check the manifest, cache allowlist, absence of API/profile content in the
cache, offline fallback and recovery, and translated offline content with the same strict
script policy as Nginx. Each uses a fresh browser context. The CSP scenario applies
the response header in Playwright; it does not start or validate an Nginx container.

Output directories `test-results*/` and `playwright-report/` are ignored by Git and
by Vite's watcher, so traces cannot cause development-server reload loops.
