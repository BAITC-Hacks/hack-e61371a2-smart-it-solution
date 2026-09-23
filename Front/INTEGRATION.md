# Frontend integration notes

## Verified baseline

Frontend is integrated with the unmodified backend from `main` commit `c7db899` (2026-09-23), including migrations through `008_semantic.sql`. Earlier frontend PR #9 and backend PRs #10–12 were merged before this delivery. This change set contains only `Front/**`.

All product screens use `/api/v1` with cookie sessions and CSRF. Backend authorization is authoritative. No product screen uses test fixtures. Read requests are cancelled when their scope changes; mutation controls block concurrent submissions. Operations with an idempotency contract retain their key and payload for uncertain retries.

## External configuration

| Capability | Frontend behavior | Server/organization prerequisite |
| --- | --- | --- |
| AI explanations and assistant | Explicit request; verified algorithm/script fallback is labelled | AI configuration, provider access and budget |
| Semantic guide search | Explicit search; SQL fallback; admin index/evaluate/enable workflow | Embedding model, approved AI articles, price/budget, 10–30 human-authored evaluation questions, passing evaluation |
| OIDC | Login button appears only when `/auth/sso/config` reports enabled; admin identity linking | Issuer/client/redirect and approved account mapping |
| Messenger/webhooks | Subscription and delivery status, personal consent | Server targets/secrets and enabled delivery worker |
| LMS/HRIS | Normalized JSON import, provider/message key, mappings and retry | External identifiers and source integration configuration |
| Tickets | Provider key, actual request ID/status or configuration error | Configured IT/HR service |
| Calendar | Real `.ics` export | Existing registered/in-progress activities; source dates have no start time |
| Rewards | Disabled state or configured wallet/catalog/redemptions | Approved policy and real reward catalog |
| ROI | Human-confirmed cost and measured benefit | Documented measurement/source; no invented financial return |

Secrets are never entered into frontend configuration or committed. CI execution may require the repository owner's billing issue to be resolved; local acceptance does not claim GitHub Actions passed.

## API limits exposed honestly

1. **Team activities for staff without an employee link.** Current `GET /team-challenges` requires `employeeId`; there is no organization-wide administrative listing and list entries do not expose `createdBy`/`canArchive`. HR/admin creation is available, but the UI explains the listing restriction. A full staff management view needs a scoped administrative listing and explicit action permissions from backend.
2. **Ticket provider discovery.** Provider keys are exposed by admin-only `/integrations`; ordinary employees cannot discover them through an existing endpoint. The employee form therefore asks for the code supplied by the organization. A future safe provider-list endpoint would allow a select field.
3. **Semantic status/history.** There is no GET endpoint for current semantic enablement, index state or previous evaluations. Administration shows confirmed results from the current workflow, identifies the absence of loaded global status, and does not infer that configuration is enabled. Persistent status/history requires an API extension.
4. **Language of source material.** UI controls and errors are translated to RU/KK/EN. Event/article translations come from approved API records, with original text when unavailable. Recommendation facts use the employee profile language; the UI labels that source language. Notification text is created by the server in the recipient's profile language.
5. **Assessment trends and forecasts.** Assessment history uses imported assessments only. Learning models do not record completions or promise promotion; participation signals are not attrition probabilities. The dataset cannot support an attrition prediction without additional evaluated data.
6. **Recovery and AI benchmarks.** Dataset reset/restore and provider benchmarking are backend operations documented in `Back/OPERATIONS.md` and backend documentation; no unsupported administrative endpoint is invented in the UI.

## Acceptance environment

A new local database `frontend_acceptance_20260923` was created exclusively for these tests and seeded from `Back/data`. No production or shared database was used. AI was disabled, no integration worker ran, and no external service credentials were needed. Test suites used real HTTP, sessions, CSRF, authorization and PostgreSQL transactions.

33 passing browser scenarios comprise 16 explicit contract fixtures, 16 real API scenarios and 1 production PWA check. The detailed tests are reproducible using `tests/README.md`. Paid inference quality, external delivery and live corporate SSO are configuration-dependent and were not claimed as verified.
