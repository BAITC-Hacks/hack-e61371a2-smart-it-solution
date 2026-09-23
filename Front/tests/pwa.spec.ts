import {expect,test} from '@playwright/test';
test.skip(process.env.CQ_E2E_PWA!=='1','Requires a production build at CQ_BASE_URL.');
test.use({locale:'en-US'});
test('production PWA caches public assets only and shows an offline screen',async({page,context})=>{
 await page.goto('/');
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
 await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
 const manifest=await (await page.request.get('/manifest.webmanifest')).json();
 expect(manifest.display).toBe('standalone');
 expect(manifest.icons.filter((icon:{type:string})=>icon.type==='image/png').map((icon:{sizes:string})=>icon.sizes)).toEqual(['192x192','512x512']);
 const cdp=await context.newCDPSession(page);
 const appManifest=await cdp.send('Page.getAppManifest');expect(appManifest.errors).toEqual([]);
 await page.goto('/profile');
 await page.evaluate(async()=>{await fetch('/api/v1/auth/demo-accounts');});
 const cached=await page.evaluate(async()=>{const result:string[]=[];for(const key of await caches.keys()){for(const request of await(await caches.open(key)).keys())result.push(new URL(request.url).pathname);}return result.sort();});
 expect(cached).toEqual(['/app-icon-192.png','/app-icon-512.png','/app-icon.svg','/manifest.webmanifest','/offline.html','/offline.js'].sort());
 await context.setOffline(true);await page.goto('/development');
 await expect(page.getByRole('heading',{name:'You are offline',exact:true})).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('lang','en');
 await expect(page.getByRole('link',{name:'Try again',exact:true})).toBeVisible();
 await expect(page.locator('#root')).toHaveCount(0);
 await context.setOffline(false);await page.reload();await expect(page.getByTestId('demo-login-employee')).toBeVisible();
});

test.describe('offline translation under production CSP',()=>{
 test.use({serviceWorkers:'block'});
 test('external translation script works with script-src self',async({page})=>{
  // Vite preview does not add nginx security headers. Preserve the actual built
  // HTML and set only its response CSP; all script/icon requests remain real.
  const csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
  await page.route('**/offline.html',async route=>{
   const response=await route.fetch();
   expect(response.ok()).toBe(true);
   await route.fulfill({response,headers:{...response.headers(),'content-security-policy':csp}});
  });
  const response=await page.goto('/offline.html');
  expect(response?.headers()['content-security-policy']).toBe(csp);
  await expect(page.getByRole('heading',{name:'You are offline',exact:true})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.getByText('Connect to the internet to open your workspace. Personal data is not stored for offline viewing.',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Try again',exact:true})).toBeVisible();
  await expect(page.locator('script:not([src])')).toHaveCount(0);
  await expect(page.locator('script[src="/offline.js"]')).toHaveAttribute('defer','');
 });
});
