import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Session } from '../src/api';

test.skip(process.env.CQ_E2E_FULL_API !== '1', 'Requires a disposable, migrated full backend.');
test.setTimeout(120_000);
test.use({actionTimeout:20_000});
async function signIn(page:Page,role:'employee'|'manager'|'hr'){
  await page.addInitScript(()=>localStorage.setItem('cq.locale','ru'));
  await page.goto('/login'); await page.getByTestId(`demo-login-${role}`).click();
  await expect(page.getByTestId('logout')).toBeVisible();
  return (await (await page.request.get('/api/v1/auth/me')).json()).data as Session;
}

test('real full API: HR filters, analytics tabs, model and approved financial inputs',async({page})=>{
  const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  await signIn(page,'hr'); await page.goto('/hr');
  const panel=page.getByTestId('hr-page'); await expect(panel.getByText('Где нужна поддержка',{exact:true})).toBeVisible({timeout:30_000});
  const original=(await(await page.request.get('/api/v1/hr/overview')).json()).data;
  expect(original.employees).toBeGreaterThan(0);
  const department=original.summaries[0].department;
  await page.getByRole('combobox',{name:'Отдел',exact:true}).selectOption(department);
  const filtered=page.waitForResponse(r=>r.url().includes('/hr/overview?department=')&&r.status()===200);
  await page.getByRole('button',{name:'Применить',exact:true}).click(); await filtered;
  await expect(panel.locator('.platform-stat').first()).toContainText(String(original.summaries.filter((p:{department:string})=>p.department===department).length));
  await page.getByRole('button',{name:'Сбросить',exact:true}).click();
  for(const name of ['Сотрудники','Программы','Воронка участия','История оценок','Сигналы участия']){
    await panel.getByRole('button',{name,exact:true}).click();
    await expect(panel.locator('table').first()).toBeVisible();
    await expect(page.getByRole('heading',{name:'Не удалось открыть раздел',exact:true})).toHaveCount(0);
  }
  await panel.getByRole('button',{name:'Модель обучения',exact:true}).click();
  await panel.locator('fieldset').first().getByRole('checkbox').first().check();
  await panel.locator('fieldset').nth(1).getByRole('checkbox').first().check();
  const simulation=page.waitForResponse(r=>r.url().endsWith('/hr/team-simulation')&&r.request().method()==='POST');
  await panel.getByRole('button',{name:'Рассчитать модель',exact:true}).click();
  const modeled=await simulation; expect(modeled.status()).toBe(200);
  await expect(panel.getByRole('columnheader',{name:'Разрывы после',exact:true})).toBeVisible();
  expect((await modeled.json()).data.eligibilityChecked).toBe(false);
  await panel.getByRole('button',{name:'Затраты и результат',exact:true}).click();
  await panel.getByRole('combobox',{name:'Активность',exact:true}).selectOption({index:1});
  await panel.getByLabel('Стоимость',{exact:true}).fill('1000');
  await panel.getByLabel('Измеренный результат в деньгах',{exact:false}).fill('1500');
  await panel.getByLabel('Методика и источник данных',{exact:true}).fill('UI_TEST: synthetic measured inputs for disposable test database only.');
  await panel.getByRole('checkbox',{name:'Подтверждаю источник и корректность финансовых данных'}).check();
  await panel.getByRole('button',{name:'Утвердить данные',exact:true}).click();
  const saved=page.waitForResponse(r=>r.url().includes('/hr/program-financials/')&&r.request().method()==='PUT');
  await page.getByRole('dialog').getByRole('button',{name:'Подтвердить',exact:true}).click(); expect((await saved).status()).toBe(200);
  await expect(panel.getByRole('cell',{name:'50%',exact:true}).first()).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:test.info().outputPath('hr-mobile.png'),fullPage:true});
  expect(errors).toEqual([]);
});

test('real full API: employee notification preferences, calendar, sessions and role boundaries',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await signIn(page,'employee');await page.goto('/notifications');
  const panel=page.getByTestId('notifications-page');
  const reminder=panel.getByRole('checkbox',{name:'Напоминания об обучении',exact:true});await expect(reminder).toBeVisible();const was=await reminder.isChecked();await reminder.setChecked(!was);
  await panel.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(panel.getByRole('status')).toContainText('Настройки сохранены');
  expect((await(await page.request.get('/api/v1/notification-preferences')).json()).data.reminders).toBe(!was);
  expect((await(await page.request.get('/api/v1/notification-preferences')).json()).data.messenger).toBe(false);
  const download=page.waitForEvent('download');await panel.getByRole('button',{name:'Скачать .ics',exact:true}).click();const file=await download;expect(file.suggestedFilename()).toBe('career-quest.ics');expect(await readFile((await file.path())!,'utf8')).toContain('BEGIN:VCALENDAR');
  await page.goto('/access');await expect(page.getByRole('heading',{name:'Ваши сессии',exact:true})).toBeVisible();await expect(page.locator('.platform-table tbody tr').first()).toBeVisible();
  for(const path of ['/hr','/guide/manage','/events/new','/admin/growth','/admin/settings']){
    await page.goto(path);await expect(page.locator('.denied-page')).toBeVisible();
  }
  expect((await page.request.get('/api/v1/hr/overview')).status()).toBe(403);
  await page.goto('/notifications');await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('real full API: manager sees team analytics only',async({page})=>{
  await signIn(page,'manager');await page.goto('/hr');
  await expect(page.getByRole('heading',{name:'Развитие команды',exact:true})).toBeVisible();
  const overview=(await(await page.request.get('/api/v1/manager/overview')).json()).data;
  expect(overview.scope).toBe('team');await expect(page.locator('.platform-stat').first()).toContainText(String(overview.employees));
  await expect(page.getByRole('button',{name:'Затраты и результат',exact:true})).toHaveCount(0);
  expect((await page.request.get('/api/v1/hr/roi')).status()).toBe(403);
});

test('real full API: revoking the current private test session clears protected data',async({page})=>{
  test.skip(!process.env.CQ_TEST_ACCOUNT_LOGIN || !process.env.CQ_TEST_ACCOUNT_PASSWORD,'Requires the disposable password account.');
  await page.addInitScript(()=>localStorage.setItem('cq.locale','ru'));
  await page.goto('/login');await page.getByRole('button',{name:'Мой аккаунт',exact:true}).click();
  await page.getByTestId('login-username').fill(process.env.CQ_TEST_ACCOUNT_LOGIN!);
  await page.getByTestId('login-password').fill(process.env.CQ_TEST_ACCOUNT_PASSWORD!);
  await page.getByTestId('login-submit').click();await expect(page.getByTestId('logout')).toBeVisible();
  const me=(await(await page.request.get('/api/v1/auth/me')).json()).data;
  expect(me.user.demo).toBe(false);expect(me.user.login).toBe(process.env.CQ_TEST_ACCOUNT_LOGIN);
  const sessions=(await(await page.request.get('/api/v1/auth/sessions')).json()).data.filter((s:{revokedAt:string|null;expiresAt:string})=>!s.revokedAt&&Date.parse(s.expiresAt)>Date.now());
  expect(sessions).toHaveLength(1);
  await page.goto('/access');
  await page.getByRole('row').filter({hasText:sessions[0].id.slice(0,8)}).getByRole('button',{name:'Завершить',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Завершить сессию',exact:true}).click();
  await expect(page.getByTestId('demo-login-employee')).toBeVisible();
  await expect(page.getByTestId('logout')).toHaveCount(0);
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
});
