import {expect,test,type Page,type Route} from '@playwright/test';
import {contractApi} from './contract-fixture';

// These UI integration seams use a complete API interception layer. They never
// contact the local backend, OpenAI, Brev or any configured provider.
const threadId='51111111-1111-4111-8111-111111111111';
const articleId='52222222-2222-4222-8222-222222222222';
const topicId='53333333-3333-4333-8333-333333333333';
const thread={id:threadId,title:'Проверка интеграции',locale:'ru',created_at:'2026-09-23T00:00:00Z',expires_at:'2099-01-01T00:00:00Z'};
const answer={content:'Ответ из подтверждённых источников.',source:'ai',locale:'ru',scope:'own',citations:[],facts:[],contacts:[]};
const article={id:articleId,topic_id:topicId,title:'Синтетическая проверенная статья',summary:'Тестовая статья.',locale:'ru',status:'published',ai_allowed:true,synthetic:true,reviewed_at:'2026-09-23T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',version:1};

async function clocked(page:Page){
 await page.clock.install({time:new Date('2026-09-23T01:00:00Z')});
 await page.addInitScript(()=>{
  localStorage.setItem('cq.locale','ru');
  // Browser-native AbortSignal.timeout runs on active time outside Playwright's
  // clock. Express the same timeout contract with the controlled browser clock.
  const recorded:number[]=[];
  (window as unknown as {requestedTimeouts:number[]}).requestedTimeouts=recorded;
  AbortSignal.timeout=(ms:number)=>{recorded.push(ms);const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),ms);return controller.signal;};
 });
}
async function assistant(page:Page,post:(route:Route)=>Promise<void>,messages:unknown[]=[]){
 await contractApi(page,'employee');
 await page.route('**/api/v1/assistant/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/messages'))return post(route);
  return route.fulfill({json:{data:path.endsWith('/threads')?[thread]:{...thread,messages}}});
 });
 await page.goto('/assistant');
 await page.getByRole('button',{name:/Проверка интеграции/}).click();
 await expect(page.getByRole('textbox',{name:'Ваш вопрос',exact:true})).toBeEnabled();
 return messages;
}

test('assistant integration: an answer after 25 seconds remains pending and uses the 90-second transport timeout',async({page})=>{
 await clocked(page);
 let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let requested=false;
 const messages:unknown[]=[];
 await assistant(page,async route=>{requested=true;await gate;messages.push({id:'message',role:'assistant',content:answer.content,response:answer,source:'ai',created_at:'2026-09-23T01:01:00Z'});await route.fulfill({status:201,json:{data:answer}});},messages);
 await page.getByRole('textbox',{name:'Ваш вопрос',exact:true}).fill('Как развить рабочие навыки?');
 await page.getByRole('button',{name:'Отправить',exact:true}).click();
 await expect.poll(()=>requested).toBe(true);
 expect(await page.evaluate(()=>(window as unknown as {requestedTimeouts:number[]}).requestedTimeouts.at(-1))).toBe(90_000);
 await page.clock.runFor(31_000);
 await expect(page.locator('.assistant-thinking')).toBeVisible();
 await expect(page.locator('.assistant-send-error')).toHaveCount(0);
 release();
 await expect(page.locator('.assistant-message-assistant')).toContainText(answer.content);
 await expect(page.locator('.assistant-thinking')).toHaveCount(0);
});

test('assistant integration: uncertain retries keep the key and new attempts wait a fresh 120 seconds',async({page})=>{
 await clocked(page);
 const keys:string[]=[];
 await assistant(page,async route=>{
  keys.push(route.request().headers()['idempotency-key']);
  if(keys.length===1)return route.abort('failed');
  return route.fulfill({status:409,json:{error:{code:keys.length===2?'MESSAGE_PROCESSING':'THREAD_BUSY'}}});
 });
 await page.getByRole('textbox',{name:'Ваш вопрос',exact:true}).fill('Как развить рабочие навыки?');
 await page.getByRole('button',{name:'Отправить',exact:true}).evaluate(element=>{(element as HTMLButtonElement).click();(element as HTMLButtonElement).click();});
 await expect(page.locator('.assistant-send-error')).toBeVisible();
 expect(keys).toHaveLength(1);
 await page.getByRole('button',{name:'Повторить тот же запрос',exact:true}).click();
 const restart=page.getByRole('button',{name:'Отправить заново после 2 минут',exact:true});
 await expect(restart).toBeDisabled();
 expect(keys[1]).toBe(keys[0]);
 await page.clock.runFor(119_000);
 await expect(restart).toBeDisabled();
 await page.clock.runFor(2_000);
 await expect(restart).toBeEnabled();
 await restart.click();
 await expect.poll(()=>keys.length).toBe(3);
 expect(keys[2]).not.toBe(keys[1]);
 await expect(restart).toBeDisabled();
 await page.clock.runFor(30_000);
 await expect(restart).toBeDisabled();
});

test('assistant integration: busy and timeout fallbacks retain verified sources with clear explanations',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('cq.locale','ru'));
 const messages=['AI_CONCURRENCY_LIMIT','AI_TIMEOUT'].map((fallbackReason,index)=>({id:`fallback-${index}`,role:'assistant',content:answer.content,response:{...answer,source:'fallback',fallbackReason,citations:[{id:articleId,title:'Проверенный источник',href:`/guide/articles/${articleId}`,synthetic:true}]},source:'fallback',created_at:'2026-09-23T01:01:00Z'}));
 await assistant(page,route=>route.abort('blockedbyclient'),messages);
 await expect(page.locator('.assistant-fallback').nth(0)).toContainText('Помощник занят');
 await expect(page.locator('.assistant-fallback').nth(1)).toContainText('Помощник не успел ответить');
 await expect(page.getByRole('link',{name:'Проверенный источник',exact:true})).toHaveCount(2);
});

test('admin integration: embedding availability is independent and OpenAI amounts exclude GPU costs',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('cq.locale','ru'));
 await contractApi(page,'admin');
 let usage:Record<string,unknown>={enabled:false,provider:'self_hosted',costBasis:'openai_api_tokens',gpuCostExcluded:true,model:'Local test model',recommendModel:'Local test model',providerConfigured:true,embeddingsEnabled:true,embeddingsConfigured:true,embeddingModel:'Explicit search model',budgetUsd:40,chargedUsd:0,remainingUsd:40,requests:4,unresolvedReservations:0,warningThresholds:[]};
 await page.route('**/api/v1/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(path==='/api/v1/admin/ai/usage')return route.fulfill({json:{data:usage}});
  if(path==='/api/v1/guide/topics')return route.fulfill({json:{data:[{id:topicId,active:true}]}});
  if(path==='/api/v1/guide/articles')return route.fulfill({json:{data:url.searchParams.get('locale')==='ru'?[article]:[]}});
  return route.fallback();
 });
 await page.goto('/admin/settings');
 await page.getByRole('button',{name:'Использование ИИ',exact:true}).click();
 const panel=page.getByTestId('ai-usage-panel');
 await expect(panel).toContainText('Собственная GPU-модель');
 await expect(panel).toContainText('Лимит OpenAI API');
 await expect(panel).toContainText('Остаток лимита OpenAI API');
 await expect(page.getByTestId('gpu-cost-note')).toContainText('Нулевой расход OpenAI API не означает бесплатную работу GPU.');
 await page.getByRole('button',{name:'Поиск по смыслу',exact:true}).click();
 await page.getByRole('checkbox',{name:/Синтетическая проверенная статья/}).check();
 await expect(page.getByTestId('semantic-index')).toBeEnabled();
 await expect(page.getByTestId('semantic-evaluate')).toBeEnabled();
 await expect(page.getByTestId('semantic-panel')).toContainText('Explicit search model');
 usage={...usage,enabled:true,embeddingsEnabled:false};
 await page.getByRole('button',{name:'Обновить статьи и лимиты',exact:true}).click();
 await expect(page.getByTestId('semantic-index')).toBeDisabled();
 await expect(page.getByTestId('semantic-panel')).toContainText('Сервер не подтвердил доступность модели поиска.');
 delete usage.embeddingsEnabled;
 await page.getByRole('button',{name:'Обновить статьи и лимиты',exact:true}).click();
 await expect(page.getByTestId('semantic-evaluate')).toBeDisabled();
});
