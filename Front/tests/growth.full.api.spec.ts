import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import type { Session } from '../src/api';
import type { Forecast, Plan, Policy, RoleProfile } from '../src/features/growth/types';

// Real HTTP + real PostgreSQL only. Opt in against a disposable, fully migrated/seeded DB.
// Two demo logins are reused for the complete suite; external delivery is never enabled.
test.skip(process.env.CQ_E2E_FULL_API !== '1', 'Requires an isolated, seeded full-platform backend.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);
let employeeContext: BrowserContext;
let adminContext: BrowserContext;
let employee: Page;
let admin: Page;
let employeeSession: Session;
const unique = randomUUID().slice(0, 8);

function panel(page: Page, title: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}
async function mutation(page: Page, path: string, method: string, action: () => Promise<unknown>, expected = [200, 201]): Promise<Response> {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);
  await action();
  const response = await pending;
  expect(expected, `${method} ${path}: ${await response.text()}`).toContain(response.status());
  return response;
}
async function login(page: Page, role: 'employee' | 'admin') {
  await page.goto('/login');
  await page.getByTestId(`demo-login-${role}`).click();
  await expect(page.getByTestId('logout')).toBeVisible();
  const response = await page.request.get('/api/v1/auth/me');
  expect(response.status()).toBe(200);
  return (await response.json() as { data: Session }).data;
}
async function integrations(page: Page, section: string) {
  await page.goto('/admin/settings');
  await page.getByRole('button', { name: 'Интеграции', exact: true }).click();
  await page.getByRole('button', { name: section, exact: true }).click();
}

test.beforeAll(async ({ browser, baseURL }) => {
  employeeContext = await browser.newContext({ baseURL });
  adminContext = await browser.newContext({ baseURL });
  for (const context of [employeeContext, adminContext]) {
    context.setDefaultTimeout(15_000); await context.addInitScript(() => { if (location.protocol.startsWith('http')) localStorage.setItem('cq.locale', 'ru'); });
  }
  employee = await employeeContext.newPage();
  admin = await adminContext.newPage();
  employeeSession = await login(employee, 'employee');
  await login(admin, 'admin');
});
test.afterAll(async () => {
  await employeeContext?.close();
  await adminContext?.close();
});

test('real full API: learning preferences, 30/90/180 day plans, optimistic regeneration, comparison and simulation', async () => {
  const profiles = (await (await employee.request.get('/api/v1/role-profiles')).json()).data as RoleProfile[];
  expect(profiles.length).toBeGreaterThan(1);
  await employee.goto('/growth?section=plans');
  const create = panel(employee, 'Составить план');
  await expect(create).toBeVisible({ timeout: 30_000 });
  await create.getByRole('combobox', { name: 'Карьерная цель', exact: true }).selectOption(JSON.stringify({ targetRole: profiles[0]!.role, targetGrade: profiles[0]!.grade }));
  let plan: Plan | undefined;
  for (const horizonDays of [30, 90, 180]) {
    await create.getByLabel('Горизонт').selectOption(String(horizonDays));
    const response = await mutation(employee, '/me/plans', 'POST', () => create.getByRole('button', { name: 'Создать', exact: true }).click());
    plan = (await response.json()).data as Plan;
    expect(plan.horizonDays).toBe(horizonDays);
    await expect(panel(employee, 'Шаги').getByRole('heading', { name: `${plan.targetRole} · ${plan.targetGrade}`, exact: true })).toBeVisible();
  }
  const originalPreferences = (await (await employee.request.get('/api/v1/me/preferences')).json()).data as { weeklyHours: number; formats: string[] };
  const pace = panel(employee, 'Мой ритм обучения');
  await pace.getByLabel('Часов в неделю').fill(originalPreferences.weeklyHours === 5 ? '6' : '5');
  await mutation(employee, '/me/preferences', 'PUT', () => pace.getByRole('button', { name: 'Сохранить', exact: true }).click());
  const detail = panel(employee, 'Шаги');
  await expect(detail.getByText('Данные изменились. Пересчитайте план перед следующим шагом.', { exact: true })).toBeVisible();
  const regeneratedResponse = await mutation(employee, `/me/plans/${plan!.id}/regenerate`, 'POST', () => detail.getByRole('button', { name: 'Пересчитать', exact: true }).click());
  const regenerated = (await regeneratedResponse.json()).data as Plan;
  expect(regenerated.version).toBeGreaterThan(plan!.version);
  expect(regeneratedResponse.request().postDataJSON()).toEqual({ expectedVersion: plan!.version });
  await expect(detail.getByRole('button', { name: 'В архив', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'В архив', exact: true }).click();
  await mutation(employee, `/me/plans/${plan!.id}/archive`, 'POST', () => detail.getByRole('button', { name: 'Подтвердить', exact: true }).click());
  await expect(detail.getByRole('button', { name: 'Пересчитать', exact: true })).toHaveCount(0);

  await employee.goto('/growth?section=forecast');
  const comparison = panel(employee, 'Сравнить карьерные цели');
  for (let index = 0; index < 2; index++) {
    const profile = profiles[index]!;
    await comparison.getByRole('combobox', { name: 'Карьерная цель', exact: true }).nth(index).selectOption(JSON.stringify({ targetRole: profile.role, targetGrade: profile.grade }));
  }
  const comparedResponse = await mutation(employee, '/me/growth/compare', 'POST', () => comparison.getByRole('button', { name: 'Сравнить', exact: true }).click());
  const compared = (await comparedResponse.json()).data as Forecast[];
  expect(compared).toHaveLength(2);
  await expect(comparison.getByRole('heading', { name: 'Оставшиеся требования', exact: true })).toHaveCount(2);
  const firstStep = compared.flatMap(item => item.steps)[0];
  // A seeded catalog may have no eligible steps for those two targets. Keep that honest.
  if (firstStep) {
    const activity = (await (await employee.request.get(`/api/v1/events/${encodeURIComponent(firstStep.eventId)}`)).json()).data as { title: string };
    const simulation = panel(employee, 'Что изменится после обучения');
    await simulation.getByLabel('Найти обучение').fill(activity.title);
    const choice = simulation.locator('.growth-event-options label').filter({ hasText: activity.title });
    await choice.getByRole('checkbox').check();
    const simulatedResponse = await mutation(employee, '/me/growth/simulate', 'POST', () => simulation.getByRole('button', { name: 'Рассчитать прогноз', exact: true }).click());
    expect((await simulatedResponse.json()).data.persisted).toBe(false);
    await expect(simulation.getByText('Это прогноз: навыки, цель и история не изменены.', { exact: true })).toBeVisible();
  }
});

test('real full API: personal task completes without points and mentor opt-in is approved by admin', async () => {
  await employee.goto('/growth?section=tasks');
  const form = panel(employee, 'Личное задание');
  const title = `Local growth task ${unique}`;
  await form.getByLabel('Название').fill(title);
  const created = await mutation(employee, '/me/tasks', 'POST', () => form.getByRole('button', { name: 'Создать', exact: true }).click());
  const id = (await created.json()).data.id as string;
  const task = panel(employee, 'Задания и достижения').locator('article').filter({ hasText: title });
  await mutation(employee, `/me/tasks/${id}`, 'PATCH', () => task.getByRole('button', { name: 'Завершить', exact: true }).click());
  await expect(task.getByText('Завершено', { exact: true })).toBeVisible();
  expect((await (await employee.request.get('/api/v1/me/achievements')).json()).data.pointsAwarded).toBe(0);
  await expect(panel(employee, 'Личные достижения').getByRole('progressbar')).toHaveCount(3);

  await employee.goto('/growth?section=mentors');
  const mentor = panel(employee, 'Стать наставником');
  const headline = `Local mentor profile ${unique}`;
  await mentor.getByLabel('Чем могу помочь').fill(headline);
  await mentor.locator('.growth-skill-options').getByRole('checkbox').first().check();
  await mentor.getByLabel('Согласен публиковать мой профиль наставника').check();
  await mutation(employee, '/mentors/me', 'PUT', () => mentor.getByRole('button', { name: 'Сохранить', exact: true }).click());
  await expect(mentor.getByText('Ожидает согласования', { exact: true })).toBeVisible();
  await admin.goto('/admin/growth?section=mentors');
  const review = admin.locator('article').filter({ hasText: headline });
  await mutation(admin, `/admin/mentors/${employeeSession.user.employeeId}`, 'PATCH', () => review.getByRole('button', { name: 'Принять', exact: true }).click());
  await expect(review.getByText('Одобрено', { exact: true })).toBeVisible();
  await employee.reload();
  await expect(panel(employee, 'Найти наставника').getByText(headline, { exact: true })).toBeVisible();
  await expect(panel(employee, 'Стать наставником').getByText('Одобрено', { exact: true })).toBeVisible();
});

test('real full API: rewards policy and catalog are admin-managed while unaffordable redemption is unavailable', async () => {
  const original = (await (await admin.request.get('/api/v1/admin/rewards/policy')).json()).data as Policy;
  await admin.goto('/admin/growth?section=rewards');
  const policy = panel(admin, 'Политика наград');
  await policy.getByLabel('Программа включена').check();
  await policy.getByLabel('Правила').fill(`Disposable test policy ${unique}`);
  await mutation(admin, '/admin/rewards/policy', 'PUT', () => policy.getByRole('button', { name: 'Сохранить', exact: true }).click());
  const newReward = panel(admin, 'Новая награда');
  const title = `Disposable local reward ${unique}`;
  await newReward.getByLabel('Название').fill(title);
  await newReward.getByLabel('Описание').fill('Local integration verification only.');
  await newReward.getByLabel('Стоимость в баллах').fill('100000');
  const created = await mutation(admin, '/admin/rewards/catalog', 'POST', () => newReward.getByRole('button', { name: 'Сохранить', exact: true }).click());
  const rewardId = (await created.json()).data.id as string;
  await employee.goto('/growth?section=rewards');
  const reward = panel(employee, 'Каталог наград').locator('article').filter({ hasText: title });
  await expect(reward.getByRole('button', { name: 'Обменять', exact: true })).toBeDisabled();
  await expect(panel(employee, 'Награды').getByText(`Disposable test policy ${unique}`, { exact: true })).toBeVisible();
  await mutation(employee, '/me/rewards/sync', 'POST', () => panel(employee, 'Награды').getByRole('button', { name: 'Сверить баллы', exact: true }).click());
  expect((await employee.request.get('/api/v1/admin/rewards/policy')).status()).toBe(403);
  await panel(admin, 'Каталог наград').locator('article').filter({ hasText: title }).getByRole('button', { name: 'Изменить', exact: true }).click();
  const edit = panel(admin, 'Изменить');
  await edit.getByLabel('Доступна в каталоге').uncheck();
  await mutation(admin, `/admin/rewards/catalog/${rewardId}`, 'PATCH', () => edit.getByRole('button', { name: 'Сохранить', exact: true }).click());
  await policy.getByLabel('Программа включена').setChecked(original.enabled);
  // The initial disabled seed has no rules; the write contract requires a nonempty rule.
  await policy.getByLabel('Правила').fill(original.rulesText || 'Local verification completed; no reward rules approved.');
  await mutation(admin, '/admin/rewards/policy', 'PUT', () => policy.getByRole('button', { name: 'Сохранить', exact: true }).click());
});

test('real full API: configured integrations, ID mapping, failed import and exact unchanged retry', async () => {
  const config = (await (await admin.request.get('/api/v1/integrations')).json()).data as { configuredTargets: string[]; webhooksEnabled: boolean };
  expect(config.webhooksEnabled).toBe(false); // This suite must not contact an external system.
  await integrations(admin, 'Подключения');
  if (!config.configuredTargets.length) await expect(admin.getByText('Подключения на сервере пока не настроены.', { exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Подписки и доставки', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'История доставок', exact: true })).toBeVisible();
  expect((await employee.request.get('/api/v1/integrations')).status()).toBe(403);

  const profiles = (await (await admin.request.get('/api/v1/employees?limit=12')).json()).data as { id: string; name: string }[];
  const events = (await (await admin.request.get('/api/v1/events?limit=12')).json()).data as { eventId: string; title: string }[];
  const selectedEmployee = profiles[0]!;
  const selectedEvent = events[0]!;
  const provider = `local-test-${unique}`;
  const messageId = randomUUID();
  const file = { history: [{ record_id: `local-test:${unique}`, employee_id: `external-employee-${unique}`, event_id: `external-event-${unique}`, date: '2026-09-30', due_date: null, status: 'completed', completion_pct: 100, score: 85, feedback_rating: 5, assigned_by: 'self' }] };
  await admin.getByRole('button', { name: 'Импорт LMS / HRIS', exact: true }).click();
  await admin.getByLabel('JSON-файл').setInputFiles({ name: 'local-history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await admin.getByLabel('Ключ внешней системы').fill(provider);
  await admin.getByLabel('ID сообщения источника').fill(messageId);
  await admin.getByRole('button', { name: 'Подтвердить импорт', exact: true }).click();
  const failed = await mutation(admin, '/integrations/import', 'POST', () => admin.getByRole('dialog').getByRole('button', { name: 'Подтвердить импорт', exact: true }).click(), [422]);
  expect((await failed.json()).error.code).toBe('MAPPING_REQUIRED');
  await expect(admin.getByRole('button', { name: 'Повторить неизменённый запрос', exact: true })).toBeVisible();
  const originalPayload = failed.request().postDataJSON();

  // Repair mappings in another tab without losing the original in-memory retry snapshot.
  const mappings = await adminContext.newPage();
  await integrations(mappings, 'Соответствия ID');
  async function saveMapping(entity: 'employee' | 'event', external: string, local: string) {
    await mappings.getByLabel('Ключ внешней системы').fill(provider);
    await mappings.getByLabel('Тип записи').selectOption(entity);
    await mappings.getByLabel('Внешний ID').fill(external);
    await mappings.getByLabel('Запись в Career Quest').selectOption(local);
    await mutation(mappings, '/integrations/identities', 'PUT', () => mappings.getByRole('button', { name: 'Сохранить соответствие', exact: true }).click());
    await expect(mappings.getByRole('cell', { name: external, exact: true })).toBeVisible();
  }
  await saveMapping('employee', file.history[0]!.employee_id, selectedEmployee.id);
  await saveMapping('event', file.history[0]!.event_id, selectedEvent.eventId);
  // Changed visible inputs must never silently alter the explicitly labelled retry.
  await admin.getByLabel('ID сообщения источника').fill(`changed-${randomUUID()}`);
  const imported = await mutation(admin, '/integrations/import', 'POST', () => admin.getByRole('button', { name: 'Повторить неизменённый запрос', exact: true }).click());
  expect(imported.request().postDataJSON()).toEqual(originalPayload);
  const result = (await imported.json()).data;
  expect(result.committed).toBe(true);
  expect(result.counts.history).toBe(1);
  await expect(admin.getByRole('heading', { name: 'Данные импортированы', exact: true })).toBeVisible();
  await admin.getByLabel('ID сообщения источника').fill(messageId);
  await admin.getByRole('button', { name: 'Подтвердить импорт', exact: true }).click();
  const replayed = await mutation(admin, '/integrations/import', 'POST', () => admin.getByRole('dialog').getByRole('button', { name: 'Подтвердить импорт', exact: true }).click());
  expect((await replayed.json()).data).toEqual(result);
  const row = mappings.getByRole('row').filter({ has: mappings.getByRole('cell', { name: file.history[0]!.event_id, exact: true }) });
  await row.getByRole('button', { name: 'Удалить', exact: true }).click();
  await mutation(mappings, '/integrations/identities', 'DELETE', () => mappings.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click());
  await expect(mappings.getByRole('cell', { name: file.history[0]!.event_id, exact: true })).toHaveCount(0);
  await mappings.close();
});
