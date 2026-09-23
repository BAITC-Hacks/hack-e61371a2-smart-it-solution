import { expect, test } from '@playwright/test';
import { contractApi, employeesFile } from './contract-fixture';

test('contract: demo login restores session on reload and logout removes protected access', async ({ page }) => {
  await contractApi(page);
  await page.goto('/');
  await page.getByTestId('demo-login-employee').click();
  await expect(page.getByTestId('logout')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('logout')).toBeVisible();
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('demo-login-employee')).toBeVisible();
  await page.goto('/profile');
  await expect(page.getByTestId('demo-login-employee')).toBeVisible();
});

test('contract: login error remains readable and a failed login can be retried', async ({ page }) => {
  await contractApi(page);
  await page.goto('/login');
  await page.getByRole('button', { name: 'Мой аккаунт', exact: true }).click();
  await page.getByTestId('login-username').fill('missing.account');
  await page.getByTestId('login-password').fill('invalid-password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('alert')).toContainText('Неверный логин');
  await expect(page.getByTestId('login-submit')).toBeEnabled();
  await page.getByRole('button', { name: 'Попробовать демо', exact: true }).click();
  await page.getByTestId('demo-login-manager').click();
  await expect(page.getByTestId('logout')).toBeVisible();
});

test('contract: expired API session clears the previous user', async ({ page }) => {
  const state = await contractApi(page, 'employee');
  await page.goto('/profile');
  await expect(page.getByTestId('profile-detail')).toBeVisible();
  state.unauthorizedWorkspace = true;
  await page.goto('/');
  await expect(page.getByTestId('demo-login-employee')).toBeVisible();
  await expect(page.getByTestId('logout')).toHaveCount(0);
});

test('contract: people pagination, search and profile route preserve API scope', async ({ page }) => {
  await contractApi(page, 'hr');
  await page.goto('/people');
  await expect(page.getByTestId('people-list')).toContainText('Aigul Testova');
  await page.getByTestId('people-next').click();
  await expect(page.getByTestId('people-list')).toContainText('Employee 13');
  await expect(page.getByTestId('people-list')).not.toContainText('Aigul Testova');
  await page.getByTestId('people-search').fill('Aigul');
  await expect(page.getByTestId('people-list')).toContainText('Aigul Testova');
  await page.getByTestId('people-list').locator('a[href="/people/E0001"]').first().click();
  await expect(page.getByTestId('profile-detail')).toContainText('Aigul Testova');
  await page.goto('/people/NOT-AVAILABLE');
  await expect(page.getByText('Профиль недоступен', { exact: true })).toBeVisible();
});

test('contract: people recover from server failure and empty search can be cleared', async ({ page }) => {
  const state = await contractApi(page, 'hr');
  state.peopleUnavailable = true;
  await page.goto('/people');
  await expect(page.getByRole('alert')).toBeVisible();
  state.peopleUnavailable = false;
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByTestId('people-list')).toContainText('Aigul Testova');
  await page.getByTestId('people-search').fill('no-such-person');
  await expect(page.getByText('Профили не найдены', { exact: true })).toBeVisible();
  await page.getByTestId('people-search').fill('');
  await expect(page.getByTestId('people-list')).toContainText('Aigul Testova');
});

for (const role of ['employee', 'manager', 'hr'] as const) {
  test(`contract: ${role} cannot open the administrator import form`, async ({ page }) => {
    await contractApi(page, role);
    await page.goto('/admin/imports');
    await expect(page.getByTestId('import-file-employees')).toHaveCount(0);
    await expect(page.getByText('Этот раздел недоступен', { exact: true })).toBeVisible();
  });
}

test('contract: import preview must be repeated after replacing files', async ({ page }) => {
  const state = await contractApi(page, 'admin');
  await page.goto('/admin/imports');
  await page.getByTestId('import-file-employees').setInputFiles(employeesFile());
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-result')).toBeVisible();
  await expect(page.getByTestId('import-commit')).toBeEnabled();
  await page.getByTestId('import-file-employees').setInputFiles(employeesFile('replacement.json'));
  await expect(page.getByTestId('import-result')).toHaveCount(0);
  await expect(page.getByTestId('import-commit')).toHaveCount(0);
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-commit')).toBeEnabled();
  await page.getByTestId('import-commit').click();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-result')).toContainText('Данные успешно импортированы');
  await expect(page.getByTestId('import-history')).toContainText('1.0');
  expect(state.commitBodies).toHaveLength(1);
  expect(state.commitBodies[0]).toEqual(state.previewBodies.at(-1));
});

test('contract: invalid and duplicate imports never enable commit', async ({ page }) => {
  const state = await contractApi(page, 'admin');
  state.errors = true;
  await page.goto('/admin/imports');
  await page.getByTestId('import-file-employees').setInputFiles(employeesFile());
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-errors')).toContainText('employees.0.employee_id');
  await expect(page.getByTestId('import-commit')).toHaveCount(0);
  state.errors = false;
  state.duplicate = true;
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-result')).toContainText('Этот набор уже загружен');
  await expect(page.getByTestId('import-commit')).toHaveCount(0);
  expect(state.commitBodies).toHaveLength(0);
});

test('contract: a delayed preview for a replaced file cannot restore the apply action', async ({ page }) => {
  await contractApi(page, 'admin');
  let release!: () => void;
  let completed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handled = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/api/v1/imports/preview', async route => {
    await gate;
    try {
      await route.fulfill({ json: { data: { hash: 'old-file', counts: { skills: 0, roleProfiles: 0, employees: 1, events: 0, history: 0 }, duplicate: false, committed: false } } });
    } finally { completed(); }
  });
  await page.goto('/admin/imports');
  await page.getByTestId('import-file-employees').setInputFiles(employeesFile());
  const previewStarted = page.waitForRequest('**/api/v1/imports/preview');
  await page.getByTestId('import-preview').click();
  await previewStarted;
  await page.getByTestId('import-file-employees').setInputFiles(employeesFile('new-file.json'));
  release();
  await handled;
  await expect(page.getByTestId('import-preview')).toBeEnabled();
  await expect(page.getByTestId('import-result')).toHaveCount(0);
  await expect(page.getByTestId('import-commit')).toHaveCount(0);
});

test('contract: small screen navigation and language selection remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await contractApi(page, 'manager');
  await page.goto('/');
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  await page.getByRole('link', { name: 'Моя команда', exact: true }).click();
  await expect(page.getByTestId('people-search')).toBeVisible();
  await page.getByRole('combobox', { name: 'Язык', exact: true }).selectOption('en');
  await expect(page.getByTestId('people-search')).toHaveAttribute('placeholder', 'Search by name, role or department');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
