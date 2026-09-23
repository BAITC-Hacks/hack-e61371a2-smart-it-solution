# Frontend browser checks

`npm run test:e2e` runs the explicit UI contract fixtures in `frontend.contract.spec.ts`.
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
