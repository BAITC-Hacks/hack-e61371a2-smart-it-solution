import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const browser = await chromium.launch(process.env.CQ_BROWSER_CHANNEL ? {channel:process.env.CQ_BROWSER_CHANNEL} : {});
try {
  const source = await readFile(new URL('../public/app-icon.svg',import.meta.url),'utf8');
  for(const size of [192,512]){
    const page = await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
    await page.setContent(`<html><body style="margin:0;background:#175a47">${source.replace('width="512" height="512"',`width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({path:fileURLToPath(new URL(`../public/app-icon-${size}.png`,import.meta.url))});
    await page.close();
  }
} finally {await browser.close();}
