import {expect,test} from '@playwright/test';
import {contractApi} from './contract-fixture';

// Every API request is intercepted by contractApi. No provider or real backend is used.
const articleId='11111111-1111-4111-8111-111111111111';
const topicId='22222222-2222-4222-8222-222222222222';
const evaluationId='33333333-3333-4333-8333-333333333333';
const article={id:articleId,topic_id:topicId,locale:'ru',title:'Проверенный тестовый материал',summary:'Синтетическая статья для интерфейсной проверки.',body:'Синтетический текст.',status:'published',ai_allowed:true,synthetic:true,reviewed_at:'2026-09-23T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',version:1};

test('semantic contract: paid operations require review, retries reuse receipt and activation uses server evaluation',async({page},testInfo)=>{
 test.setTimeout(70_000);
 await page.addInitScript(()=>localStorage.setItem('cq.locale','ru'));
 await contractApi(page,'admin');
 const calls:{path:string;body:any;key:string|undefined}[]=[];
 let failedIndex=false;
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.slice('/api/v1'.length);const ok=(data:unknown)=>route.fulfill({json:{data}});
  if(path==='/admin/ai/usage')return ok({enabled:true,remainingUsd:20});
  if(path==='/guide/topics')return ok([{id:topicId,active:true}]);
  if(path==='/guide/articles')return ok(url.searchParams.get('locale')==='ru'?[article]:[]);
  if(!path.startsWith('/admin/semantic/'))return route.fallback();
  const body=request.postDataJSON();calls.push({path,body,key:request.headers()['idempotency-key']});
  expect(request.headers()['x-csrf-token']).toBe('contract-csrf-token');
  if(path==='/admin/semantic/index'){
   if(!failedIndex){failedIndex=true;return route.abort('failed');}
   return ok({indexed:[{articleId,revisionHash:'revision',charactersIndexed:2000,truncated:true}],model:'intercepted-test-model',corpusHash:'corpus',indexHash:'index',usageId:'fixture-usage'});
  }
  if(path==='/admin/semantic/evaluate')return ok({id:evaluationId,model:'intercepted-test-model',corpusHash:'corpus',indexHash:'index',queryCount:body.queries.length,sqlRecallAt3:.5,semanticRecallAt3:.9,passed:true,usageIds:[],results:body.queries.map((q:any)=>({...q,sqlArticleIds:[],semanticArticleIds:[articleId],sqlRecallAt3:0,semanticRecallAt3:1}))});
  if(path==='/admin/semantic/enable')return ok({...body,model:'intercepted-test-model'});
  return route.fulfill({status:404,json:{error:{code:'NOT_FOUND'}}});
 });
 await page.goto('/admin/settings');
 await page.getByRole('button',{name:'Поиск по смыслу',exact:true}).click();
 const panel=page.getByTestId('semantic-panel');
 await panel.getByRole('checkbox',{name:/Проверенный тестовый материал/}).check();
 await page.getByTestId('semantic-index').click();
 const dialog=page.getByRole('dialog');
 await expect(dialog.getByRole('button',{name:'Подтвердить',exact:true})).toBeDisabled();
 expect(calls).toHaveLength(0);
 await dialog.getByRole('checkbox').check();
 await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();
 await expect(dialog).toContainText('Не удаётся связаться с сервером');
 await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 expect(calls).toHaveLength(2);
 expect(calls[0].key?.length).toBeGreaterThanOrEqual(8);
 expect(calls[0].key).toBe(calls[1].key);
 expect(calls[0].body).toEqual(calls[1].body);
 await expect(panel).toContainText('Текст сокращён');
 const rows=page.locator('.semantic-query');
 for(let i=0;i<10;i++){
  await rows.nth(i).getByRole('textbox',{name:'Вопрос',exact:true}).fill(`Рабочий вопрос номер ${i+1}`);
  await rows.nth(i).getByRole('combobox',{name:'Правильные статьи (1–3)',exact:true}).selectOption(articleId);
 }
 await page.getByTestId('semantic-evaluate').click();
 await expect(dialog.getByRole('button',{name:'Подтвердить',exact:true})).toBeDisabled();
 await dialog.getByRole('checkbox').check();
 await dialog.getByRole('button',{name:'Подтвердить',exact:true}).evaluate(element=>{(element as HTMLButtonElement).click();(element as HTMLButtonElement).click();});
 await expect(dialog).toHaveCount(0);
 expect(calls.filter(c=>c.path.endsWith('/evaluate'))).toHaveLength(1);
 await expect(panel).toContainText('Оценка пройдена');
 await expect(page.getByRole('textbox',{name:'ID сохранённой оценки',exact:true})).toHaveValue(evaluationId);
 await page.getByTestId('semantic-enable').click();
 await expect(dialog).toContainText('Новые фразы могут расходовать бюджет ИИ.');
 await dialog.getByRole('checkbox').check();
 await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 expect(calls.at(-1)?.body).toEqual({enabled:true,evaluationId});
 await expect(panel).toContainText('Сервер подтвердил включение.');
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('semantic-settings-mobile.png'),fullPage:true});
 await rows.first().getByRole('textbox',{name:'Вопрос',exact:true}).fill('Обновлённый контрольный вопрос');
 await expect(panel).not.toContainText('Оценка пройдена');
 await expect(page.getByRole('textbox',{name:'ID сохранённой оценки',exact:true})).toHaveValue('');
 await expect(page.getByTestId('semantic-enable')).toBeDisabled();
});

test('semantic contract: editing the question hides an old answer and rejects an in-flight response',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('cq.locale','ru'));
 await contractApi(page,'employee');
 let release:()=>void=()=>{};
 const responseGate=new Promise<void>(resolve=>{release=resolve;});
 let requested=false;
 await page.route('**/api/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/v1/guide/articles'||path==='/api/v1/guide/topics'||path==='/api/v1/tickets')return route.fulfill({json:{data:[]}});
  if(path!=='/api/v1/guide/semantic-search')return route.fallback();
  requested=true;await responseGate;
  await route.fulfill({json:{data:{source:'semantic',fallbackReason:null,articles:[{...article,topicId}],usageIds:[]}}}).catch(()=>{});
 });
 await page.goto('/guide');
 await page.locator('.guide-semantic > summary').click();
 const input=page.getByRole('textbox',{name:'Ваш вопрос',exact:true});
 await input.fill('Первый вопрос');
 await page.getByTestId('semantic-search').click();
 await expect.poll(()=>requested).toBe(true);
 await input.fill('Изменённый вопрос');
 release();
 await expect(page.locator('.guide-semantic')).not.toContainText(article.title);
 await expect(page.getByTestId('semantic-search')).toBeEnabled();
 await page.getByTestId('semantic-search').click();
 await expect(page.locator('.guide-semantic')).toContainText(article.title);
 await input.fill('Третий вопрос');
 await expect(page.locator('.guide-semantic')).not.toContainText(article.title);
});
