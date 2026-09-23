import {expect,test} from '@playwright/test';
import {contractApi} from './contract-fixture';
test('contract: sign-in preserves deep-link query parameters',async({page})=>{
 const state=await contractApi(page);
 await page.goto('/history?employeeId=E0001');await page.getByTestId('demo-login-employee').click();
 await expect(page).toHaveURL(/\/history\?employeeId=E0001$/);
 await expect(page.getByTestId('logout')).toBeVisible();
 state.user=null;await page.reload();await expect(page.getByTestId('demo-login-employee')).toBeVisible();
 await page.getByTestId('demo-login-employee').click();await expect(page).toHaveURL(/\/history\?employeeId=E0001$/);
});
test('contract: notification links cannot escape the application origin',async({page})=>{
 await contractApi(page,'employee');
 const links=['/\t/example.invalid','//example.invalid','/\\example.invalid','https://example.invalid','/\n/example.invalid','/events/EV_001?source=notification#details'];
 await page.route('**/api/v1/notifications?**',route=>route.fulfill({json:{data:links.map((link,i)=>({id:String(i),title:`Notice ${i}`,body:'Contract fixture',kind:'test',link,readAt:'2026-09-23',createdAt:'2026-09-23'})),meta:{page:1,total:links.length,limit:20}}}));
 await page.route('**/api/v1/notification-preferences',route=>route.fulfill({json:{data:{inApp:true,messenger:false,reminders:true}}}));
 await page.goto('/notifications');const notices=page.locator('.platform-notification');await expect(notices).toHaveCount(6);
 for(let i=0;i<5;i++)await expect(notices.nth(i).getByRole('link')).toHaveAttribute('href','/');
 await expect(notices.nth(5).getByRole('link')).toHaveAttribute('href',links[5]);
});
