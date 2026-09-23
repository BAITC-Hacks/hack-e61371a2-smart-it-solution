import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createPool,migrate} from '../src/db.js';
import {readBundle,importBundle} from '../src/imports.js';
import {seedDemoAccounts,userColumns,type User} from '../src/auth.js';
import {cosine,recallAt3,readSemanticConfig,handleSemantic,embedTexts,type SemanticConfig} from '../src/semantic.js';
import {HttpError,type RouteContext} from '../src/http.js';
import type {FetchLike} from '../src/ai.js';

test('semantic settings require explicit model and positive price; default is disabled',()=>{
 assert.equal(readSemanticConfig({}).enabled,false);
 assert.equal(readSemanticConfig({AI_ENABLED:'true',OPENAI_API_KEY:'fake',AI_EMBEDDING_MODEL:'test-embedding'}).enabled,false);
 assert.equal(readSemanticConfig({AI_ENABLED:'true',OPENAI_API_KEY:'fake',AI_EMBEDDING_MODEL:'test-embedding',AI_EMBEDDING_USD_PER_MILLION:'0.2'}).enabled,true);
});
test('cosine and recall@3 use real vector geometry and expected relevant IDs',()=>{
 assert.equal(cosine([1,0],[1,0]),1);assert.equal(cosine([1,0],[0,1]),0);assert.equal(cosine([1,0],[-1,0]),-1);
 assert.throws(()=>cosine([0,0],[1,0]));assert.throws(()=>cosine([1],[1,0]));assert.throws(()=>cosine([Infinity],[1]));
 assert.equal(recallAt3(['a','a','b','c'],['a','b','c']),2/3);
});

test('semantic PostgreSQL ACL, durable budget, quality gate and fallbacks',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const schema=`semantic_${randomUUID().replaceAll('-','')}`;const adminDb=createPool(process.env.TEST_DATABASE_URL!);await adminDb.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);const pool=createPool(url.toString());
 const config=readSemanticConfig({AI_ENABLED:'true',OPENAI_API_KEY:'fake-never-sent-to-network',AI_EMBEDDING_MODEL:'test-embedding',AI_EMBEDDING_USD_PER_MILLION:'0.2',AI_USER_REQUESTS_PER_HOUR:'1000',AI_PROJECT_REQUESTS_PER_DAY:'10000',AI_USER_DAILY_BUDGET_USD:'10',AI_TIMEOUT_MS:'100'});
 const sent:string[]=[];let calls=0;
 const mock:FetchLike=async(input,init)=>{
  assert.equal(input,'https://api.openai.com/v1/embeddings');calls++;const body=JSON.parse(String(init.body));sent.push(String(init.body));
  return Response.json({model:config.model,data:body.input.map((text:string,index:number)=>{const concept=Number(text.match(/(?:concept|intent)(\d)/)?.[1]??0);return {index,embedding:Array.from({length:6},(_,n)=>n===concept?1:0)};}),usage:{prompt_tokens:body.input.length*10,total_tokens:body.input.length*10}});
 };
 try{
  await migrate(pool);await importBundle(pool,await readBundle('./data'),{commit:true});await seedDemoAccounts(pool);
  const users=(await pool.query(`SELECT ${userColumns} FROM user_accounts u`)).rows as User[];const admin=users.find(u=>u.role==='admin')!,employee=users.find(u=>u.role==='employee')!;
  const employeeName=(await pool.query('SELECT full_name FROM employees WHERE employee_id=$1',[employee.employeeId])).rows[0].full_name;
  await pool.query("INSERT INTO contact_channels(label,channel,value,synthetic) VALUES('Private contact','demo','INTERNAL-CONTACT-42',true)");
  const articles:string[]=[];
  const makeArticle=async(concept:number,status='published',aiAllowed=true)=>{
   const topic=(await pool.query('INSERT INTO guide_topics(slug,category) VALUES($1,\'test\') RETURNING id',[`semantic-${randomUUID()}`])).rows[0].id;
   const row=(await pool.query(`INSERT INTO guide_articles(topic_id,locale,version,title,summary,body,applies_when,visibility,ai_allowed,status,owner_user_id,approved_by,reviewed_at,expires_at)
    VALUES($1,'ru',1,$2,$2,$3,$2,$4,$5,$6,$7,$7,now(),now()+interval '1 day') RETURNING id`,[topic,`concept${concept} approved guide`,concept===0?`concept0 ${employeeName} ${employee.employeeId} person@example.test +77123456789 INTERNAL-CONTACT-42 https://secret.example.test/path`:`concept${concept} approved instructions`,concept===5?['admin']:['employee','manager','hr','admin'],aiAllowed,status,admin.id])).rows[0];return row.id as string;
  };
  for(let i=0;i<6;i++)articles.push(await makeArticle(i));const draft=await makeArticle(0,'draft');const forbidden=await makeArticle(0,'published',false);
  const call=async(path:string,body:unknown,user=admin,key=randomUUID(),settings:SemanticConfig=config,fetchFn:FetchLike=mock,db=pool)=>{
   let result:any;const ctx={pool:db,user,path:`/api/v1${path}`,method:'POST',url:new URL(`http://localhost/api/v1${path}`),config:{},req:{headers:{'idempotency-key':key}},body:async()=>body,requestId:randomUUID(),send:(value:unknown)=>{result=value;}} as unknown as RouteContext;
   assert.equal(await handleSemantic(ctx,{config:settings,fetchFn}),true);return result;
  };
  const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,e=>e instanceof HttpError&&e.code===code);
  const queries=Array.from({length:10},(_,i)=>({q:`intent${i%5} scenario${i}`,locale:'ru',expectedArticleIds:[articles[i%5]]}));
  await t.test('disabled and ungated search falls back locally; admin access precedes paid work',async()=>{
   assert.equal((await call('/guide/semantic-search',{q:'concept0',locale:'ru'},employee,randomUUID(),{...config,enabled:false})).source,'sql');
   assert.equal((await call('/guide/semantic-search',{q:'intent0 question'},employee)).source,'sql');
   await rejects(call('/admin/semantic/index',{articleIds:[articles[0]]},employee),'FORBIDDEN');
   await rejects(call('/admin/semantic/index',{articleIds:[draft]}),'ARTICLE_NOT_INDEXABLE');await rejects(call('/admin/semantic/index',{articleIds:[forbidden]}),'ARTICLE_NOT_INDEXABLE');
   await rejects(call('/admin/semantic/evaluate',{queries}),'EVALUATION_UNINDEXED');assert.equal(calls,0);
  });
  let index:any;
  await t.test('index redacts known personal data and contacts, uses a durable shared budget and no held connection',async()=>{
   const one=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:1000});
   try{index=await call('/admin/semantic/index',{articleIds:articles},admin,randomUUID(),config,async(input,init)=>{assert.equal((await one.query('SELECT 1 AS available')).rows[0].available,1);return mock(input,init);},one);}finally{await one.end();}
   assert.equal(index.indexed.length,6);assert.equal(calls,1);assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_usage WHERE status='settled' AND purpose='semantic_index'")).rows[0].n,1);
   for(const secret of [employeeName,employee.employeeId,'person@example.test','77123456789','INTERNAL-CONTACT-42','https://secret.example.test'])assert.ok(!sent[0]!.includes(secret!));
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM guide_semantic_embeddings')).rows[0].n,6);
  });
  await t.test('failed quality evaluation cannot enable semantic search',async()=>{
   const result=await call('/admin/semantic/evaluate',{queries:Array.from({length:10},(_,i)=>({q:`intent4 bad-evaluation${i}`,locale:'ru',expectedArticleIds:articles.slice(0,3)}))});
   assert.equal(result.passed,false);assert.ok(result.semanticRecallAt3<0.7);await rejects(call('/admin/semantic/enable',{enabled:true,evaluationId:result.id}),'EVALUATION_REQUIRED');
   await assert.rejects(call('/admin/semantic/evaluate',{queries:queries.map(q=>({...q,q:'same query'}))}));
  });
  let evaluation:any;
  await t.test('successful persisted comparison enables only matching current model and index',async()=>{
   const key=randomUUID();evaluation=await call('/admin/semantic/evaluate',{queries},admin,key);assert.equal(evaluation.semanticRecallAt3,1);assert.equal(evaluation.sqlRecallAt3,0);assert.equal(evaluation.passed,true);
   const n=calls;const replay=await call('/admin/semantic/evaluate',{queries},admin,key);assert.equal(replay.id,evaluation.id);assert.equal(calls,n);
   await rejects(call('/admin/semantic/enable',{enabled:true,evaluationId:evaluation.id},employee),'FORBIDDEN');
   await rejects(call('/admin/semantic/enable',{enabled:true,evaluationId:evaluation.id},admin,randomUUID(),{...config,model:'other-test-model'}),'EVALUATION_REQUIRED');
   assert.equal((await call('/admin/semantic/enable',{enabled:true,evaluationId:evaluation.id})).enabled,true);
  });
  await t.test('enabled arbitrary queries are embedded, cached and ACL-filtered before ranking',async()=>{
   const n=calls;const result=await call('/guide/semantic-search',{q:'intent0 arbitrary phrase',locale:'ru'},employee);assert.equal(result.source,'semantic');assert.equal(result.articles[0].id,articles[0]);assert.equal(calls,n+1);
   await call('/guide/semantic-search',{q:'intent0 arbitrary phrase',locale:'ru'},employee);assert.equal(calls,n+1);
   const restricted=await call('/guide/semantic-search',{q:'intent5 private phrase',locale:'ru'},employee);assert.equal(restricted.source,'semantic');assert.ok(restricted.articles.every((a:{id:string})=>a.id!==articles[5]));
  });
  await t.test('provider failure and budget exhaustion use SQL fallback without uncontrolled retry',async()=>{
   const key=randomUUID();let failures=0;const failing:FetchLike=async()=>{failures++;return new Response('',{status:503});};
   const result=await call('/guide/semantic-search',{q:'concept0 provider failure'},employee,key,config,failing);assert.equal(result.source,'sql');assert.equal(result.fallbackReason,'EMBEDDING_UNAVAILABLE');
   await call('/guide/semantic-search',{q:'concept0 provider failure'},employee,key,config,failing);assert.equal(failures,1);
   const budget=await call('/guide/semantic-search',{q:'concept0 budget exhausted'},employee,randomUUID(),{...config,budget:{...config.budget,projectBudget:0}},async()=>{throw new Error('must not fetch');});assert.equal(budget.source,'sql');assert.equal(budget.fallbackReason,'AI_BUDGET_LIMIT');
   const charged=(await pool.query("SELECT reserved_microusd,cost_microusd FROM ai_usage WHERE outcome='embedding_http_503'")).rows[0];assert.equal(charged.cost_microusd,charged.reserved_microusd);
  });
  await t.test('account relink or deactivation during inference rejects the result',async()=>{
   await rejects(call('/guide/semantic-search',{q:'intent0 revoke account during inference'},employee,randomUUID(),config,async(input,init)=>{await pool.query('UPDATE user_accounts SET active=false WHERE id=$1',[employee.id]);return mock(input,init);}), 'AUTH_CONTEXT_CHANGED');
   await pool.query('UPDATE user_accounts SET active=true WHERE id=$1',[employee.id]);
  });
  await t.test('archived content during inference invalidates the gate and is never returned',async()=>{
   const result=await call('/guide/semantic-search',{q:'intent0 article changes during inference'},employee,randomUUID(),config,async(input,init)=>{await pool.query("UPDATE guide_articles SET status='archived' WHERE id=$1",[articles[0]]);return mock(input,init);});
   assert.equal(result.source,'sql');assert.ok(result.articles.every((a:{id:string})=>a.id!==articles[0]));
   const n=calls;assert.equal((await call('/guide/semantic-search',{q:'intent1 stale index'},employee)).source,'sql');assert.equal(calls,n);
   await rejects(call('/admin/semantic/enable',{enabled:true,evaluationId:evaluation.id}),'EVALUATION_REQUIRED');
  });
  await t.test('invalid embeddings are charged conservatively and never persisted',async()=>{
   await assert.rejects(embedTexts(pool,admin.id,['safe input'],config,'semantic_invalid',async()=>Response.json({model:config.model,data:[{index:0,embedding:[0,0]}],usage:{prompt_tokens:1,total_tokens:1}})));
   const charged=(await pool.query("SELECT status,reserved_microusd,cost_microusd FROM ai_usage WHERE purpose='semantic_invalid'")).rows[0];assert.equal(charged.status,'settled');assert.equal(charged.cost_microusd,charged.reserved_microusd);
  });
 }finally{await pool.end();await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);await adminDb.end();}
});
