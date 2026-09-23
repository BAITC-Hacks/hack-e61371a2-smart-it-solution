import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Employee, Session, Workspace } from '../src/api';

// Opt in only against a disposable, migrated and seeded backend database.
// These tests use real HTTP, sessions, CSRF, PostgreSQL permissions and import transactions.
test.skip(process.env.CQ_E2E_REAL_API !== '1', 'Set CQ_E2E_REAL_API=1 with a seeded, disposable real backend.');
test.beforeEach(async ({ page }) => {
  // Preserve a deliberate UI language while checking accounts with different profile preferences.
  await page.addInitScript(() => localStorage.setItem('cq.locale', 'ru'));
});

async function signIn(page: Page, role: 'employee' | 'manager' | 'hr' | 'admin') {
  await page.goto('/login');
  await page.getByTestId(`demo-login-${role}`).click();
  await expect(page.getByTestId('logout')).toBeVisible();
  const response = await page.request.get('/api/v1/auth/me');
  expect(response.status()).toBe(200);
  return (await response.json() as { data: Session }).data;
}

test('real API: password account signs in, restores session and signs out', async ({ page }) => {
  test.skip(!process.env.CQ_TEST_ACCOUNT_LOGIN || !process.env.CQ_TEST_ACCOUNT_PASSWORD, 'Provide credentials for a test account in the disposable backend.');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Мой аккаунт', exact: true }).click();
  await page.getByTestId('login-username').fill(process.env.CQ_TEST_ACCOUNT_LOGIN!);
  await page.getByTestId('login-password').fill(process.env.CQ_TEST_ACCOUNT_PASSWORD!);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('logout')).toBeVisible();
  const response = await page.request.get('/api/v1/auth/me');
  expect((await response.json()).data.user.demo).toBe(false);
  await page.reload();
  await expect(page.getByTestId('logout')).toBeVisible();
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('demo-login-employee')).toBeVisible();
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
});

for (const role of ['employee', 'manager', 'hr', 'admin'] as const) {
  test(`real API: ${role} session, data scope, profile access and logout`, async ({ page }) => {
    const session = await signIn(page, role);
    expect(session.user.role).toBe(role);
    const workspace = (await (await page.request.get('/api/v1/workspace')).json() as { data: Workspace }).data;
    expect(workspace.scope).toBe(role === 'employee' ? 'self' : role === 'manager' ? 'team' : 'organization');
    expect(workspace.counts.employees).toBeGreaterThan(0);
    if (role === 'employee') expect(workspace.counts.employees).toBe(1);
    const employees = (await (await page.request.get('/api/v1/employees?limit=12')).json() as { data: Employee[] }).data;
    await page.goto('/people');
    await expect(page.getByTestId('people-list')).toContainText(employees[0]!.name);
    await page.getByTestId('people-search').fill(employees[0]!.name);
    await expect(page.getByTestId('people-list')).toContainText(employees[0]!.name);
    await page.goto(`/people/${employees[0]!.id}`);
    await expect(page.getByTestId('profile-detail')).toContainText(employees[0]!.name);
    if (role === 'employee' || role === 'manager') {
      const directory = process.env.CQ_DATASET_PATH ?? resolve(process.cwd(), '../Back/data');
      const source = JSON.parse(await readFile(resolve(directory, 'employees.json'), 'utf8')) as { employees: { employee_id: string; manager_id: string | null }[] };
      const foreign = source.employees.find(profile => profile.employee_id !== session.user.employeeId && (role !== 'manager' || profile.manager_id !== session.user.employeeId));
      expect(foreign).toBeTruthy();
      const response = await page.request.get(`/api/v1/employees/${foreign!.employee_id}`);
      expect(response.status()).toBe(404);
      await page.goto(`/people/${foreign!.employee_id}`);
      await expect(page.getByText('Профиль недоступен', { exact: true })).toBeVisible();
      expect((await page.request.get('/api/v1/imports')).status()).toBe(403);
    }
    if (role !== 'admin') {
      await page.goto('/admin/imports');
      await expect(page.getByTestId('import-file-employees')).toHaveCount(0);
    }
    await page.reload();
    await expect(page.getByTestId('logout')).toBeVisible();
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('demo-login-employee')).toBeVisible();
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  });
}

test('real API: admin validates, commits and detects a duplicate; changed and invalid files cannot commit', async ({ page }) => {
  await signIn(page, 'admin');
  const directory = process.env.CQ_DATASET_PATH ?? resolve(process.cwd(), '../Back/data');
  const source = JSON.parse(await readFile(resolve(directory, 'employees.json'), 'utf8')) as { meta: Record<string, string>; employees: Record<string, unknown>[] };
  const employee = { ...source.employees[0], employee_id: `E_UI_${Date.now()}`, full_name: 'UI integration verification' };
  const payload = { meta: source.meta, employees: [employee] };
  const file = { name: 'employees-ui-test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) };
  await page.goto('/admin/imports');
  await page.getByTestId('import-file-employees').setInputFiles(file);
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-commit')).toBeEnabled();
  await page.getByTestId('import-file-employees').setInputFiles({ ...file, name: 'employees-replaced.json' });
  await expect(page.getByTestId('import-result')).toHaveCount(0);
  await expect(page.getByTestId('import-commit')).toHaveCount(0);
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-commit')).toBeEnabled();
  const committedResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/imports/commit'));
  await page.getByTestId('import-commit').click();
  await page.getByTestId('import-confirm').click();
  expect((await committedResponse).status()).toBe(200);
  await expect(page.getByTestId('import-result')).toContainText('Данные успешно импортированы');
  await expect(page.getByTestId('import-history')).toContainText(source.meta.version!);
  const profileResponse = await page.request.get(`/api/v1/employees/${employee.employee_id}`);
  expect(profileResponse.status()).toBe(200);
  expect((await profileResponse.json()).data.name).toBe('UI integration verification');
  await page.getByTestId('import-file-employees').setInputFiles(file);
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-result')).toContainText('Этот набор уже загружен');
  await expect(page.getByTestId('import-commit')).toHaveCount(0);
  const invalid = { ...payload, employees: [{ ...employee, manager_id: 'UNKNOWN-MANAGER' }] };
  await page.getByTestId('import-file-employees').setInputFiles({ ...file, name: 'invalid.json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-errors')).toBeVisible();
  await expect(page.getByTestId('import-commit')).toHaveCount(0);
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('demo-login-admin')).toBeVisible();
});
