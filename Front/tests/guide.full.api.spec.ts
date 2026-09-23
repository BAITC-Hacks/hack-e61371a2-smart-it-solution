import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Session } from '../src/api';
import type { Article, Answer, GuideContact, ManagedContact, Routing, Thread, Topic } from '../src/features/guide/types';
import type { Account } from '../src/features/administration/AccountsPanel';

// Opt-in only against the migrated, seeded disposable full-platform database.
// No route mocks, external tickets, OIDC login or paid inference are used.
test.skip(process.env.CQ_E2E_FULL_API !== '1', 'Set CQ_E2E_FULL_API=1 against the disposable full-platform backend.');
test.use({ actionTimeout: 20_000, navigationTimeout: 25_000 });

async function data<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1${path}`);
  expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  return (await response.json() as { data: T }).data;
}
async function login(page: Page, role: 'admin' | 'employee') {
  await page.goto('/login');
  await page.getByTestId(`demo-login-${role}`).click();
  await expect(page.getByTestId('logout')).toBeVisible();
  return data<Session>(page, '/auth/me');
}
function responseFor(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);
}
async function submitOnce(button: Locator) {
  // Exercise the synchronous mutation lock before React has disabled the button.
  await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
}

test('full real API: reviewed guide, administration and private deterministic assistant', async ({ page }, testInfo) => {
  test.setTimeout(220_000);
  await page.addInitScript(() => localStorage.setItem('cq.locale', 'ru'));
  const admin = await login(page, 'admin');
  const usageBefore = await data<{ enabled: boolean; embeddingsEnabled?: boolean; requests: number; chargedUsd: number }>(page, '/admin/ai/usage');
  // Refuse to send an assistant question if this test server could call a paid provider.
  test.skip(usageBefore.enabled || usageBefore.embeddingsEnabled !== false, 'The guide suite requires generation and embeddings explicitly disabled and never calls a provider.');
  const marker = `UI_GUIDE_${Date.now()}`;
  const topicSlug = `ui-guide-${Date.now()}`;
  const articleTitle = `Синтетическая проверка ${marker}`;
  const contactLabel = `Демо-канал ${marker}`;
  const backendErrors: string[] = [];
  page.on('pageerror', error => backendErrors.push(error.message));

  await test.step('Create a topic and a reviewed synthetic article through the editor', async () => {
    await page.goto('/guide/manage');
    await page.getByRole('button', { name: 'Темы', exact: true }).click();
    await page.getByRole('button', { name: 'Новая тема', exact: true }).click();
    const form = page.locator('.guide-editor');
    await form.getByLabel('Идентификатор темы', { exact: true }).fill(topicSlug);
    await form.getByLabel('Категория', { exact: true }).fill('UI verification');
    await form.getByLabel('Синонимы · RU', { exact: true }).fill(marker);
    await form.getByLabel('Первые дни работы', { exact: true }).check();
    const creating = responseFor(page, '/guide/topics');
    await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const created = await creating;
    expect(created.status()).toBe(201);
    const topic = (await created.json() as { data: Topic }).data;
    await expect(page.locator('.guide-admin-list')).toContainText(topicSlug);
    testInfo.annotations.push({ type: 'guide-topic', description: topic.id });

    await page.getByRole('button', { name: 'Статьи', exact: true }).click();
    await page.getByRole('button', { name: 'Новая статья', exact: true }).click();
    await form.getByLabel('Тема', { exact: true }).selectOption(topic.id);
    await form.getByLabel('Название', { exact: true }).fill(articleTitle);
    await form.getByLabel('Краткое описание', { exact: true }).fill('Синтетический материал для проверки интерфейса, не правило организации.');
    await form.getByLabel('Когда применять', { exact: true }).fill('Только во время автоматической проверки интерфейса.');
    await form.getByLabel('Полный текст', { exact: true }).fill(`Тестовый текст ${marker}. Реальные инструкции и контакты организации здесь не настроены.`);
    await form.getByLabel('Порядок действий', { exact: true }).fill('Проверить отображение синтетического материала.');
    await form.getByLabel('Источники и материалы', { exact: true }).fill('Тестовый источник | https://example.org/ui-verification');
    await form.getByLabel('Синтетический демонстрационный материал', { exact: true }).check();
    await form.getByLabel('Разрешено использовать в ИИ-помощнике', { exact: true }).check();
    const draftResponse = responseFor(page, '/guide/articles');
    await submitOnce(form.getByRole('button', { name: 'Сохранить', exact: true }));
    const draftHttp = await draftResponse;
    expect(draftHttp.status()).toBe(201);
    let article = (await draftHttp.json() as { data: Article }).data;
    expect(article.status).toBe('draft');
    expect(article.synthetic).toBe(true);

    async function publish(id: string) {
      await form.getByRole('button', { name: 'Опубликовать', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Опубликовать', exact: true })).toBeDisabled();
      await dialog.getByLabel('Я проверил(а) содержание и подтверждаю публикацию', { exact: true }).check();
      const publishing = responseFor(page, `/guide/articles/${id}/publish`);
      await dialog.getByRole('button', { name: 'Опубликовать', exact: true }).click();
      expect((await publishing).status()).toBe(200);
      await expect(dialog).toHaveCount(0);
    }
    await publish(article.id);
    const oldId = article.id;
    const copiedResponse = responseFor(page, `/guide/articles/${article.id}/versions`);
    await form.getByRole('button', { name: 'Создать новую версию', exact: true }).click();
    const copiedHttp = await copiedResponse;
    expect(copiedHttp.status()).toBe(201);
    article = (await copiedHttp.json() as { data: Article }).data;
    expect(article.version).toBe(2);
    await form.getByLabel('Название', { exact: true }).fill(`${articleTitle} v2`);
    await expect(form.getByRole('button', { name: 'Опубликовать', exact: true })).toBeDisabled();
    const saving = responseFor(page, `/guide/articles/${article.id}`, 'PATCH');
    await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
    expect((await saving).status()).toBe(200);
    await publish(article.id);
    expect((await page.request.get(`/api/v1/guide/articles/${oldId}`)).status()).toBe(404);
    const published = await data<Article>(page, `/guide/articles/${article.id}`);
    expect(published.status).toBe('published');
    expect(published.title).toBe(`${articleTitle} v2`);
    await expect(form.getByLabel('Полный текст', { exact: true })).toBeDisabled();
    testInfo.annotations.push({ type: 'guide-article', description: article.id });

    // Archiving an unused new draft must not hide the separately published version.
    const thirdResponse = responseFor(page, `/guide/articles/${article.id}/versions`);
    await form.getByRole('button', { name: 'Создать новую версию', exact: true }).click();
    const third = (await (await thirdResponse).json() as { data: Article }).data;
    await form.getByRole('button', { name: 'Архивировать', exact: true }).click();
    const archiving = responseFor(page, `/guide/articles/${third.id}/archive`);
    await page.getByRole('dialog').getByRole('button', { name: 'Архивировать', exact: true }).click();
    expect((await archiving).status()).toBe(200);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await data<Article>(page, `/guide/articles/${third.id}?manage=true`)).status).toBe('archived');
    expect((await data<Article>(page, `/guide/articles/${article.id}`)).status).toBe('published');
  });
  const topicId = testInfo.annotations.find(item => item.type === 'guide-topic')!.description!;
  const articleId = testInfo.annotations.find(item => item.type === 'guide-article')!.description!;

  await test.step('Create a verified demo contact and route; feedback can be resolved', async () => {
    await page.getByRole('button', { name: 'Контакты', exact: true }).click();
    await page.getByRole('button', { name: 'Новый контакт', exact: true }).click();
    const form = page.locator('.guide-editor');
    await form.getByLabel('Название контакта', { exact: true }).fill(contactLabel);
    await form.getByLabel('Канал', { exact: true }).selectOption('demo');
    await form.getByLabel('Адрес или номер', { exact: true }).fill('Реальный контакт не настроен — синтетическая проверка.');
    await form.getByLabel('Синтетический демонстрационный материал', { exact: true }).check();
    await form.getByLabel('Конфиденциально', { exact: true }).check();
    await form.getByLabel('Контакт проверен мной', { exact: true }).check();
    const saving = responseFor(page, '/guide/contacts');
    await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const contactHttp = await saving;
    expect(contactHttp.status()).toBe(201);
    const contact = (await contactHttp.json() as { data: ManagedContact }).data;
    expect(contact.verified_at).toBeTruthy();
    expect(contact.synthetic).toBe(true);
    await expect(form.getByLabel('Контакт проверен мной', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: 'Маршруты обращений', exact: true }).click();
    await page.getByRole('button', { name: 'Новый маршрут', exact: true }).click();
    await form.getByLabel('Тема', { exact: true }).selectOption(topicId);
    await form.getByLabel('Основной контакт', { exact: true }).selectOption(contact.id);
    const routing = responseFor(page, '/guide/routing');
    await form.getByRole('button', { name: 'Сохранить', exact: true }).click();
    expect((await routing).status()).toBe(201);
    const available = await data<GuideContact[]>(page, `/guide/contacts?topicId=${topicId}`);
    expect(available).toContainEqual(expect.objectContaining({ id: contact.id, synthetic: true, priority: 'primary' }));

    await page.goto(`/guide/articles/${articleId}`);
    await expect(page.locator('.guide-contact')).toContainText(contactLabel);
    await expect(page.locator('.guide-contact a')).toHaveCount(0);
    await page.getByLabel('Комментарий', { exact: true }).fill(`Feedback ${marker}`);
    const posting = responseFor(page, `/guide/articles/${articleId}/feedback`);
    await page.getByRole('button', { name: 'Отправить отзыв', exact: true }).click();
    const feedback = (await (await posting).json()).data as { id: string };
    await expect(page.getByText('Спасибо, отзыв передан редактору.', { exact: true })).toBeVisible();
    await page.goto('/guide/manage');
    await page.getByRole('button', { name: 'Обратная связь', exact: true }).click();
    const card = page.locator('.guide-feedback-list article').filter({ hasText: `Feedback ${marker}` });
    const resolved = responseFor(page, `/guide/feedback/${feedback.id}/resolve`);
    await card.getByRole('button', { name: 'Отметить обработанным', exact: true }).click();
    expect((await resolved).status()).toBe(200);
    await expect(card).toHaveCount(0);
  });

  await test.step('Manage only a newly created test account and read its audit trail', async () => {
    await page.goto('/admin/settings');
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const loginName = `ui.guide.${Date.now()}`;
    await dialog.getByLabel('Логин', { exact: true }).fill(loginName);
    await dialog.getByLabel('Отображаемое имя', { exact: true }).fill(`UI account ${marker}`);
    await dialog.getByRole('combobox', { name: 'Роль доступа', exact: true }).selectOption('hr');
    await dialog.getByLabel(/^Пароль/).fill(`Test-only-${crypto.randomUUID()}`);
    await dialog.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    const creating = responseFor(page, '/admin/accounts');
    await submitOnce(dialog.getByRole('button', { name: 'Подтвердить', exact: true }));
    expect((await creating).status()).toBe(201);
    await expect(dialog).toHaveCount(0);
    const row = page.locator('.settings-table tr').filter({ hasText: loginName });
    await expect(row).toContainText('HR-специалист');
    const account = (await data<Account[]>(page, '/admin/accounts')).find(item => item.login === loginName)!;
    expect(account).toBeTruthy();
    await row.getByRole('button', { name: 'Изменить', exact: true }).click();
    await dialog.getByLabel('Активен', { exact: true }).uncheck();
    await dialog.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    await expect(dialog).toContainText('Любое изменение отзовёт все сессии');
    const updating = responseFor(page, `/admin/accounts/${account.id}`, 'PATCH');
    await dialog.getByRole('button', { name: 'Подтвердить', exact: true }).click();
    const updated = await updating;
    expect(updated.status()).toBe(200);
    expect((await updated.json()).data.sessionsRevoked).toBe(true);
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('Отключён');

    await page.getByRole('button', { name: 'Журнал действий', exact: true }).click();
    await page.getByRole('combobox', { name: 'Код действия (точное совпадение)', exact: true }).fill('account.update');
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    await expect(page.locator('.settings-audit-list')).toContainText(account.id);
    await page.getByRole('button', { name: 'Использование ИИ', exact: true }).click();
    await expect(page.getByText('Выключен', { exact: true })).toBeVisible();
    const usageAfter = await data<{ enabled: boolean; requests: number; chargedUsd: number }>(page, '/admin/ai/usage');
    expect(usageAfter.requests).toBe(usageBefore.requests);
    expect(usageAfter.chargedUsd).toBe(usageBefore.chargedUsd);
    await page.getByRole('button', { name: 'Поиск по смыслу', exact: true }).click();
    await expect(page.getByTestId('semantic-panel')).toContainText('Сервер не подтвердил доступность модели поиска.');
    await expect(page.getByTestId('semantic-index')).toBeDisabled();
    await expect(page.getByTestId('semantic-evaluate')).toBeDisabled();
    await expect(page.getByTestId('semantic-enable')).toBeDisabled();
    // Confirmations remain usable without making an activation or paid request.
    await page.getByRole('button', { name: 'Выключить поиск по смыслу', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true })).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  });

  // Create an empty admin-owned thread locally, without asking a provider anything.
  const adminThreadResponse = await page.request.post('/api/v1/assistant/threads', {
    headers: { Origin: new URL(testInfo.project.use.baseURL as string).origin, 'X-CSRF-Token': admin.csrfToken },
    data: { title: `Private ${marker}`, locale: 'ru' },
  });
  expect(adminThreadResponse.status()).toBe(201);
  const adminThread = (await adminThreadResponse.json() as { data: Thread }).data;
  await page.getByTestId('logout').click();
  const employee = await login(page, 'employee'); // The second and final login.
  expect(employee.user.employeeId).toBeTruthy();
  expect((await page.request.get('/api/v1/admin/accounts')).status()).toBe(403);
  expect((await page.request.get(`/api/v1/assistant/threads/${adminThread.id}`)).status()).toBe(404);

  await test.step('Search reviewed content, show hints and preserve role access on mobile', async () => {
    await page.goto('/guide');
    await page.getByLabel('Опишите рабочую ситуацию', { exact: true }).fill(marker);
    await expect(page.locator('.guide-article-grid').first()).toContainText(`${articleTitle} v2`);
    await page.getByLabel('Тема', { exact: true }).selectOption(topicId);
    await page.getByLabel('По ситуации', { exact: true }).selectOption('onboarding');
    await expect(page.locator('.guide-hints')).toContainText(`${articleTitle} v2`);
    await page.locator('.guide-semantic > summary').click();
    await page.getByLabel('Ваш вопрос', { exact: true }).fill(marker);
    const searching = responseFor(page, '/guide/semantic-search');
    await page.getByTestId('semantic-search').click();
    const semanticHttp = await searching;
    expect(semanticHttp.status()).toBe(200);
    const semantic = (await semanticHttp.json()).data;
    expect(semantic.source).toBe('sql');
    expect(semantic.fallbackReason).toBe('DISABLED');
    await expect(page.locator('.guide-semantic')).toContainText(`${articleTitle} v2`);
    await expect(page.locator('.guide-semantic')).toContainText('Показаны обычные результаты.');
    await page.goto(`/guide/articles/${articleId}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${articleTitle} v2`);
    await expect(page.locator('.guide-contact')).toContainText(contactLabel);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('guide-article-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 900 });
  });

  await test.step('A private chat returns real deterministic facts and deletes its own history', async () => {
    await page.goto('/assistant');
    await page.getByRole('button', { name: 'Новый диалог', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название диалога', { exact: true }).fill(`Chat ${marker}`);
    const creating = responseFor(page, '/assistant/threads');
    await dialog.getByRole('button', { name: 'Создать', exact: true }).click();
    const thread = (await (await creating).json() as { data: Thread }).data;
    await expect(dialog).toHaveCount(0);
    await page.getByLabel('Ваш вопрос', { exact: true }).fill('Какие навыки мне развивать для следующего грейда?');
    const answerResponse = responseFor(page, `/assistant/threads/${thread.id}/messages`);
    await submitOnce(page.getByRole('button', { name: 'Отправить', exact: true }));
    const answered = await answerResponse;
    expect(answered.status()).toBe(201);
    expect(answered.request().headers()['idempotency-key']?.length).toBeGreaterThanOrEqual(8);
    const answer = (await answered.json() as { data: Answer }).data;
    expect(answer.source).toBe('fallback');
    expect(answer.fallbackReason).toBe('AI_DISABLED');
    expect(answer.scope).toBe('own');
    expect(answer.facts.length).toBeGreaterThan(0);
    await expect(page.locator('.assistant-message-assistant')).toContainText(answer.content);
    await expect(page.getByText('ИИ отключён; используются проверенные данные платформы.', { exact: true })).toBeVisible();
    await expect(page.locator('.assistant-message-user')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('assistant-fallback-desktop.png'), fullPage: true });
    const reloaded = await data<Thread>(page, `/assistant/threads/${thread.id}`);
    expect(reloaded.messages?.filter(message => message.role === 'user')).toHaveLength(1);
    expect(reloaded.messages?.filter(message => message.role === 'assistant')).toHaveLength(1);
    await page.reload();
    await page.locator('.assistant-threads').getByRole('button', { name: new RegExp(`Chat ${marker}`) }).click();
    await expect(page.locator('.assistant-message-assistant')).toContainText(answer.content);
    await page.getByRole('button', { name: 'Удалить диалог', exact: true }).click();
    const deleting = responseFor(page, `/assistant/threads/${thread.id}`, 'DELETE');
    await dialog.getByRole('button', { name: 'Удалить диалог', exact: true }).click();
    expect((await deleting).status()).toBe(200);
    expect((await page.request.get(`/api/v1/assistant/threads/${thread.id}`)).status()).toBe(404);
  });
  expect(backendErrors).toEqual([]);
});
