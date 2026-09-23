import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Session } from '../src/api';
import type { CareerEvent, CareerProfile, EmployeeSkill, EventTranslation, Goal, Participation, ProgressResponse, RecommendationRun, RoleProfile } from '../src/features/career/types';

// Run only against the disposable, migrated full-platform database. No request mocks.
test.skip(process.env.CQ_E2E_FULL_API !== '1', 'Set CQ_E2E_FULL_API=1 with the disposable full-platform backend.');
test.use({ actionTimeout: 15_000 });

async function getData<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  return (await response.json() as { data: T }).data;
}
async function login(page: Page, role: 'employee' | 'admin') {
  await page.goto('/login');
  await page.getByTestId(`demo-login-${role}`).click();
  await expect(page.getByTestId('logout')).toBeVisible();
  const session = await getData<Session>(page, '/auth/me');
  expect(session.user.demo, 'Career acceptance mutations must use synthetic demo accounts.').toBe(true);
  return session;
}
async function doubleSubmit(button: Locator) {
  // Two DOM clicks in one browser task exercise the immediate submission guard,
  // before React can render the disabled button. This does not mock network/API.
  await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
}
function card(page: Page, heading: string) { return page.locator('section.career-card').filter({ has: page.getByRole('heading', { name: heading, exact: true }) }); }

test('full real API: career goal, recommendations, event publication, translation and one-time skill gain', async ({ browser, page }, testInfo) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => localStorage.setItem('cq.locale', 'ru'));
  const session = await login(page, 'employee');
  expect(session.user.employeeId).toBeTruthy();
  const employeeId = session.user.employeeId!;
  const employee = await getData<CareerProfile>(page, `/employees/${employeeId}`);
  const roles = await getData<RoleProfile[]>(page, '/role-profiles');
  const target = roles.find(role => role.role === employee.role && role.grade === 'Lead' && role.grade !== employee.goal?.targetGrade)
    ?? roles.find(role => role.role === employee.role && role.grade !== employee.goal?.targetGrade && role.requirements.length > 0);
  expect(target, 'The seeded employee needs at least one alternative role profile.').toBeTruthy();

  const goalRequests: string[] = [];
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith(`/employees/${employeeId}/goal`)) goalRequests.push(request.headers()['idempotency-key'] ?? ''); });
  await page.goto('/development');
  await page.getByRole('button', { name: 'Выбрать цель', exact: true }).click();
  const goalForm = page.locator('.career-goal-form');
  await goalForm.getByLabel('Должность').selectOption(target!.role);
  await goalForm.getByLabel('Грейд').selectOption(target!.grade);
  await goalForm.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  const goalResponse = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/employees/${employeeId}/goal`));
  await doubleSubmit(page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }));
  expect((await goalResponse).status()).toBe(200);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(goalRequests).toHaveLength(1);
  expect(goalRequests[0]!.length).toBeGreaterThanOrEqual(8);
  await page.reload();
  await expect(page.locator('.career-goal')).toContainText(target!.role);
  await expect(page.locator('.career-goal')).toContainText(target!.grade);
  const persistedGoal = await getData<{ active: Goal }>(page, `/employees/${employeeId}/goals`);
  expect(persistedGoal.active).toMatchObject({ targetRole: target!.role, targetGrade: target!.grade, inferred: false });
  const skillsBefore = await getData<EmployeeSkill[]>(page, `/employees/${employeeId}/skills`);
  const skill = skillsBefore.find(item => item.gap > 0 && item.effectiveLevel < 5);
  expect(skill, 'The seeded employee must have a skill gap below the maximum level.').toBeTruthy();
  expect(employee.lastReviewDate < employee.asOfDate, 'A completion must fall after the last assessment to change effective skills.').toBe(true);
  await expect(card(page, 'Навыки')).toContainText(skill!.name);

  const recommendationResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/employees/${employeeId}/recommendations`));
  await card(page, 'Рекомендации для цели').getByRole('button', { name: /^(Подобрать обучение|Обновить)$/ }).click();
  const recommendationsHttp = await recommendationResponse;
  expect(recommendationsHttp.status()).toBe(200);
  expect(recommendationsHttp.request().postDataJSON()).toEqual({ useAi: false });
  const recommendations = (await recommendationsHttp.json() as { data: RecommendationRun }).data;
  expect(recommendations.recommendations.length).toBeLessThanOrEqual(3);
  expect(recommendations.source).toBe('fallback');
  for (const item of recommendations.recommendations) {
    expect(item.expectedGains.length).toBeGreaterThan(0);
    expect(item.factors.length).toBeGreaterThan(0);
    await expect(card(page, 'Рекомендации для цели')).toContainText(item.title);
  }
  await page.screenshot({ path: testInfo.outputPath('career-development-desktop.png'), fullPage: true });

  const adminContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL as string });
  await adminContext.addInitScript(() => localStorage.setItem('cq.locale', 'ru'));
  const adminPage = await adminContext.newPage();
  try {
    await login(adminPage, 'admin'); // Exactly one employee and one administrator login per run.
    const eventId = `UI_CAREER_${Date.now()}`;
    const title = `Проверка карьерного роста ${eventId}`;
    const description = 'Практическое самостоятельное занятие для проверки карьерного сценария.';
    await adminPage.goto(`/events/new?employeeId=${employeeId}`);
    await adminPage.getByLabel('Код мероприятия', { exact: true }).fill(eventId);
    await adminPage.getByLabel('Название', { exact: true }).fill(title);
    await adminPage.getByLabel('Описание').fill(description);
    await adminPage.getByLabel('Длительность, ч.', { exact: true }).fill('1');
    await card(adminPage, 'Для кого').getByLabel(employee.role, { exact: true }).check();
    await card(adminPage, 'Для кого').getByLabel(employee.grade, { exact: true }).check();
    const effects = card(adminPage, 'Что даст обучение');
    await effects.getByRole('button', { name: 'Добавить', exact: true }).click();
    await effects.getByLabel('Навык').selectOption(skill!.skillId);
    await effects.getByLabel('Прирост', { exact: true }).fill('1');
    await effects.getByLabel('До уровня', { exact: true }).fill('5');
    await adminPage.getByRole('button', { name: 'Проверить карточку', exact: true }).click();
    await expect(adminPage.getByRole('button', { name: 'Сохранить мероприятие', exact: true })).toBeEnabled();
    // Editing even a non-structural field invalidates the exact reviewed payload.
    await adminPage.getByLabel('Описание').fill(`${description} Проверено.`);
    await expect(adminPage.getByRole('button', { name: 'Сохранить мероприятие', exact: true })).toBeDisabled();
    await adminPage.getByRole('button', { name: 'Проверить карточку', exact: true }).click();
    await expect(adminPage.getByRole('button', { name: 'Сохранить мероприятие', exact: true })).toBeEnabled();
    await adminPage.getByRole('button', { name: 'Сохранить мероприятие', exact: true }).click();
    let creates = 0;
    adminPage.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/events') creates++; });
    const createResponse = adminPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/events');
    await doubleSubmit(adminPage.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }));
    expect((await createResponse).status()).toBe(201);
    await expect(adminPage.getByRole('heading', { name: title, exact: true })).toBeVisible();
    expect(creates).toBe(1);
    const event = await getData<CareerEvent>(adminPage, `/events/${eventId}?employeeId=${employeeId}`);
    expect(event.effects).toEqual([{ skillId: skill!.skillId, gain: 1, maxLevel: 5 }]);
    expect(event.eligibility?.eligible).toBe(true);

    await adminPage.goto(`/events/${eventId}/edit?employeeId=${employeeId}`);
    const translation = card(adminPage, 'Переводы мероприятия');
    await translation.getByLabel('Язык').selectOption('en');
    const translatedTitle = `Career growth verification ${eventId}`;
    await translation.getByLabel('Название', { exact: true }).fill(translatedTitle);
    await translation.getByLabel('Описание').fill('A self-paced practical activity for verifying career growth.');
    await translation.getByRole('button', { name: 'Сохранить и опубликовать перевод', exact: true }).click();
    const translationResponse = adminPage.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/events/${eventId}/translations/en`));
    await adminPage.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
    expect((await translationResponse).status()).toBe(200);
    expect((await getData<EventTranslation[]>(adminPage, `/events/${eventId}/translations`)).find(item => item.locale === 'en')?.title).toBe(translatedTitle);
    await adminPage.locator('select.language').selectOption('en');
    await adminPage.goto(`/events/${eventId}?employeeId=${employeeId}`);
    // Navigation reloads explicit stored RU in this test context; select EN after navigation.
    await adminPage.locator('select.language').selectOption('en');
    await expect(adminPage.getByRole('heading', { name: translatedTitle, exact: true })).toBeVisible();
    expect((await getData<CareerEvent>(adminPage, `/events/${eventId}`)).title).toBe(title);

    await page.goto(`/events/${eventId}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Записаться', exact: true })).toBeEnabled();
    const before = await getData<ProgressResponse>(page, `/employees/${employeeId}/progress`);
    let registrations = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/participations') registrations++; });
    await page.getByRole('button', { name: 'Записаться', exact: true }).click();
    const registerResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/participations');
    await doubleSubmit(page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }));
    const registrationHttp = await registerResponse;
    expect(registrationHttp.status()).toBe(201);
    const participation = (await registrationHttp.json() as { data: Participation }).data;
    expect(participation.status).toBe('registered');
    await expect(page.getByRole('button', { name: 'Начать', exact: true })).toBeEnabled();
    expect(registrations).toBe(1);
    await page.getByRole('button', { name: 'Начать', exact: true }).click();
    const startResponse = page.waitForResponse(response => response.url().endsWith(`/participations/${participation.id}/start`));
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
    expect((await startResponse).status()).toBe(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Завершить', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Результат 0–100 (необязательно)', { exact: true }).fill('85');
    await page.getByRole('dialog').getByLabel('Оценка 1–5 (необязательно)', { exact: true }).fill('5');
    let completions = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/participations/${participation.id}/complete`)) completions++; });
    const completionResponse = page.waitForResponse(response => response.url().endsWith(`/participations/${participation.id}/complete`));
    await doubleSubmit(page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }));
    expect((await completionResponse).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Завершить', exact: true })).toHaveCount(0);
    expect(completions).toBe(1);
    const afterSkills = await getData<EmployeeSkill[]>(page, `/employees/${employeeId}/skills`);
    expect(afterSkills.find(item => item.skillId === skill!.skillId)?.effectiveLevel).toBe(skill!.effectiveLevel + 1);
    const after = await getData<ProgressResponse>(page, `/employees/${employeeId}/progress`);
    expect(after.progress.gapPoints).toBeLessThan(before.progress.gapPoints);
    expect(after.changes.some(change => change.participationId === participation.id && change.skillId === skill!.skillId)).toBe(true);
    await page.goto('/history');
    await expect(page.locator('.career-history-record').filter({ hasText: title })).toContainText('Завершено');
    await page.reload();
    expect((await getData<Participation>(page, `/participations/${participation.id}`)).status).toBe('completed');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/development');
    await expect(page.getByRole('heading', { name: 'Моё развитие', exact: true })).toBeVisible();
    await expect(page.locator('.career-goal')).toContainText(target!.grade);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('career-development-mobile.png'), fullPage: true });
  } finally { await adminContext.close(); }
});
