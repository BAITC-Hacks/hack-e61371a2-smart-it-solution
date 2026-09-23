import { expect, test } from '@playwright/test';
import { contractApi } from './contract-fixture';
import type { CareerProfile, RecommendationRun } from '../src/features/career/types';

// All API traffic is intercepted. The native timeout clock is scaled only after
// initial loading, so a simulated 50-second AI reply takes one second to verify.
test('career AI contract: extended wait is opt-in and fallback stays readable', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cq.locale', 'ru');
    const state = { scale: false, values: [] as number[] };
    Object.assign(window, { careerTimeoutTest: state });
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = milliseconds => {
      state.values.push(milliseconds);
      return nativeTimeout(state.scale ? milliseconds / 50 : milliseconds);
    };
  });
  await contractApi(page, 'employee');
  const profile: CareerProfile = {
    id: 'E0001', name: 'Aigul Testova', role: 'Software Engineer', grade: 'Middle',
    department: 'Engineering', language: 'ru', managerId: null,
    hireDate: '2023-01-16', tenureMonths: 42, workFormat: 'hybrid',
    lastReviewDate: '2026-07-01', targetRole: 'Software Engineer', targetGrade: 'Senior',
    goal: { targetRole: 'Software Engineer', targetGrade: 'Senior', inferred: true },
    progress: { requiredPoints: 4, achievedPoints: 2, gapPoints: 2, percent: 50, criticalGaps: 1 },
    asOfDate: '2026-09-01',
  };
  const calls: { body: unknown; key: string | undefined }[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const ok = (data: unknown, meta?: unknown) => route.fulfill({ json: { data, ...(meta ? { meta } : {}) } });
    if (path === '/employees/E0001') return ok(profile);
    if (path === '/employees/E0001/skills') return ok([
      { skillId: 'SK_TEST', name: 'Testing', type: 'hard', baselineLevel: 2, effectiveLevel: 2, requiredLevel: 4, gap: 2, isCritical: true },
    ], { lastReviewDate: profile.lastReviewDate, asOfDate: profile.asOfDate, scale: { min: 0, max: 5 }, goal: profile.goal });
    if (path === '/employees/E0001/progress') return ok({ goal: profile.goal, progress: profile.progress, changes: [], asOfDate: profile.asOfDate, promotionDecision: false });
    if (path === '/employees/E0001/goals') return ok({ active: profile.goal, history: [] });
    if (path === '/role-profiles') return ok([{ role: 'Software Engineer', grade: 'Senior', requirements: [] }]);
    if (path === '/employees/E0001/recommendations/latest') return ok({ run: null, stale: true, reason: 'NOT_CALCULATED' });
    if (path !== '/employees/E0001/recommendations') return route.fallback();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-csrf-token']).toBe('contract-csrf-token');
    calls.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
    const count = calls.length;
    if (count === 2) await new Promise(resolve => setTimeout(resolve, 1_000));
    const run: RecommendationRun = {
      runId: `contract-run-${count}`, employeeId: profile.id, goal: profile.goal,
      recommendations: [], excluded: [], source: 'fallback', model: null, usageId: null,
      fallbackReason: !request.postDataJSON().useAi ? null : count === 2 ? 'AI_CONCURRENCY_LIMIT' : 'AI_TIMEOUT',
      algorithmVersion: 'contract', asOfDate: profile.asOfDate,
      emptyReason: 'NO_ELIGIBLE_EVENTS', cached: false, stale: false, createdAt: '2026-09-23T00:00:00Z',
    };
    return ok(run);
  });
  await page.goto('/development');
  const optIn = page.getByTestId('career-use-ai');
  await expect(optIn).not.toBeChecked();
  expect(calls).toHaveLength(0);
  await page.getByRole('button', { name: 'Подобрать обучение', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toBeEnabled();
  expect(calls[0]?.body).toEqual({ useAi: false });
  expect(await page.evaluate(() => (window as unknown as { careerTimeoutTest: { values: number[] } }).careerTimeoutTest.values.at(-1))).toBe(25_000);
  await page.evaluate(() => { (window as unknown as { careerTimeoutTest: { scale: boolean } }).careerTimeoutTest.scale = true; });
  await optIn.check();
  expect(calls).toHaveLength(1);
  await page.getByRole('button', { name: 'Подобрать с ИИ', exact: true }).evaluate(element => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(optIn).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Сохраняем…', exact: true })).toBeDisabled();
  await expect(page.getByText('Сервис ИИ сейчас занят другими запросами. Показан подбор по данным профиля.', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[1]?.body).toEqual({ useAi: true });
  expect(calls[1]?.key?.length).toBeGreaterThanOrEqual(8);
  expect(calls[1]?.key).not.toBe(calls[0]?.key);
  expect(await page.evaluate(() => (window as unknown as { careerTimeoutTest: { values: number[] } }).careerTimeoutTest.values.at(-1))).toBe(90_000);
  await page.locator('select.language').selectOption('en');
  await expect(page.getByText('The AI service is busy with other requests. Recommendations are based on profile data.', { exact: true })).toBeVisible();
  await page.locator('select.language').selectOption('kk');
  await expect(page.getByText('ЖИ қызметі қазір басқа сұрауларды өңдеп жатыр. Профиль деректері бойынша ұсыныстар көрсетілді.', { exact: true })).toBeVisible();
  await page.locator('select.language').selectOption('ru');
  await page.getByRole('button', { name: 'Подобрать с ИИ', exact: true }).click();
  await expect(page.getByText('ИИ не успел ответить. Показан подбор по данным профиля; повторный запрос не запускается автоматически.', { exact: true })).toBeVisible();
  expect(calls).toHaveLength(3);
  await page.locator('select.language').selectOption('en');
  await expect(page.getByText('AI did not respond in time. Recommendations are based on profile data; the request is not retried automatically.', { exact: true })).toBeVisible();
  await page.locator('select.language').selectOption('kk');
  await expect(page.getByText('ЖИ уақытында жауап бермеді. Профиль деректері бойынша ұсыныстар көрсетілді; сұрау автоматты түрде қайталанбайды.', { exact: true })).toBeVisible();
  await optIn.uncheck();
  await page.locator('select.language').selectOption('ru');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toBeEnabled();
  expect(calls).toHaveLength(4);
  expect(calls[3]?.body).toEqual({ useAi: false });
  expect(await page.evaluate(() => (window as unknown as { careerTimeoutTest: { values: number[] } }).careerTimeoutTest.values.at(-1))).toBe(25_000);
});
