import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { createPool,migrate } from '../src/db.js';
import { seedDemoAccounts,type User } from '../src/auth.js';
import { readBundle,importBundle } from '../src/imports.js';
import { seedGuideDemo } from '../src/guide.js';
import { readAiConfig } from '../src/ai-config.js';
import { requestStructured,reserveAiBudget,settleAiBudget,rerankRecommendations,redactQuestion,answerAssistant,handleAssistant,cleanupAssistantRetention } from '../src/ai.js';
import { type RouteContext,HttpError } from '../src/http.js';

test('AI defaults disabled and requires explicit model pricing to enable',()=>{
 assert.equal(readAiConfig({}).enabled,false);
 assert.throws(()=>readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'dummy-test-key',AI_MODEL_FAST:'fake-model'}),/verified maximum/);
 assert.equal(redactQuestion('sk-example123456789 test@example.invalid 123456789012'),'[secret removed] [email removed] [identifier removed]');
});

test('AI provider, budget concurrency and owner-only assistant',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const admin=createPool(process.env.TEST_DATABASE_URL!);const schema=`ai_test_${randomUUID().replaceAll('-','')}`;let pool:Pool|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);pool=createPool(url.toString());
  await migrate(pool);await importBundle(pool,await readBundle('./data'),{commit:true});await seedDemoAccounts(pool);await seedGuideDemo(pool);
  const users=(await pool.query(`SELECT id,login,display_name AS "displayName",app_role AS role,employee_id AS "employeeId",demo_only AS demo FROM user_accounts`)).rows as User[];
  const employee=users.find(u=>u.role==='employee')!,hr=users.find(u=>u.role==='hr')!,root=users.find(u=>u.role==='admin')!;
  const enabled=readAiConfig({AI_ENABLED:'true',OPENAI_API_KEY:'fake-key-no-network',AI_MODEL_FAST:'fake-model',AI_INPUT_USD_PER_MILLION:'1',AI_OUTPUT_USD_PER_MILLION:'2',AI_USER_REQUESTS_PER_HOUR:'100',AI_PROJECT_REQUESTS_PER_DAY:'1000'});
  const disabled=readAiConfig({});const output=(value:unknown)=>new Response(JSON.stringify({status:'completed',usage:{input_tokens:10,output_tokens:5},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}),{status:200});
  const minimal={pool,userId:employee.id,config:enabled,purpose:'test',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},input:{test:true},instructions:'Select supplied facts only'};
  await t.test('concurrent reservations cannot exceed cap; uncertain reservation is not reclaimed',async()=>{
   const cfg={...enabled,projectBudget:250,userBudget:250};const results=await Promise.allSettled(Array.from({length:3},()=>reserveAiBudget({pool:pool!,userId:employee.id,config:cfg,purpose:'concurrency',model:'fake',reservedMicrousd:100})));
   assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal(results.filter(r=>r.status==='rejected').length,1);
   const sum=(await pool!.query(`SELECT sum(reserved_microusd)::int AS n FROM ai_usage WHERE status='reserved'`)).rows[0].n;assert.equal(sum,200);
   for(const r of results)if(r.status==='fulfilled')await settleAiBudget(pool!,r.value,{costMicrousd:0,outcome:'test_no_call'});
  });
  await t.test('Responses API sends strict schema, store:false and settles actual token usage',async()=>{
   const result=await requestStructured({...minimal,fetchFn:async(input,init)=>{assert.equal(input,'https://api.openai.com/v1/responses');const body=JSON.parse(init.body as string);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.equal(body.model,'fake-model');assert.equal(body.max_output_tokens,800);assert.equal('tools' in body,false);return output({ok:true});}});
   assert.ok('value' in result);if('value' in result)assert.deepEqual(result.value,{ok:true});
   const usage=(await pool!.query('SELECT * FROM ai_usage WHERE id=$1',[result.usageId])).rows[0];assert.equal(Number(usage.cost_microusd),20);assert.equal(usage.status,'settled');
  });
  await t.test('malformed JSON, refusal and invented candidate IDs produce fallback',async()=>{
   const candidates=[{eventId:'EV001',facts:[{id:'gap',text:'Verified skill gap'}]}];
   const invented=await rerankRecommendations({pool:pool!,userId:employee.id,config:enabled,candidates,context:{grade:'Junior'},fetchFn:async()=>output({items:[{eventId:'EV_FAKE',factIds:['gap']}]})});assert.equal(invented.source,'fallback');assert.deepEqual(invented.eventIds,['EV001']);
   const wrongFact=await rerankRecommendations({pool:pool!,userId:employee.id,config:enabled,candidates,context:{},fetchFn:async()=>output({items:[{eventId:'EV001',factIds:['invented']} ]})});assert.equal(wrongFact.source,'fallback');
   const valid=await rerankRecommendations({pool:pool!,userId:employee.id,config:enabled,candidates,context:{},fetchFn:async()=>output({items:[{eventId:'EV001',factIds:['gap']} ]})});assert.equal(valid.source,'ai');
   const malformed=await requestStructured({...minimal,fetchFn:async()=>new Response('not json')});assert.equal('error' in malformed&&malformed.error,'INVALID_AI_RESPONSE');
   const refusal=await requestStructured({...minimal,fetchFn:async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}))});assert.equal('error' in refusal&&refusal.error,'AI_REFUSAL');
  });
  await t.test('retry only explicit 429; network failures keep conservative cost and are not retried',async()=>{
   let attempts=0;const retry=await requestStructured({...minimal,fetchFn:async()=>++attempts===1?new Response('',{status:429}):output({ok:true})});assert.equal(attempts,2);assert.ok('value' in retry);
   attempts=0;const failure=await requestStructured({...minimal,fetchFn:async()=>{attempts++;throw new Error('network');}});assert.equal(attempts,1);assert.equal('error' in failure&&failure.error,'AI_UNAVAILABLE');
   const usage=(await pool!.query('SELECT * FROM ai_usage WHERE id=$1',[failure.usageId])).rows[0];assert.equal(usage.cost_microusd,usage.reserved_microusd);
  });
  await t.test('timeout aborts fake provider and request quotas prevent provider calls',async()=>{
   const timeout=await requestStructured({...minimal,config:{...enabled,timeoutMs:50},fetchFn:(_url,init)=>new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})});assert.equal('error' in timeout&&timeout.error,'AI_TIMEOUT');
   let called=false;const limited=await requestStructured({...minimal,config:{...enabled,userHourly:1},fetchFn:async()=>{called=true;return output({ok:true});}});assert.equal(called,false);assert.equal('error' in limited&&limited.error,'AI_RATE_LIMIT');
  });
  await t.test('assistant uses approved excerpts, refuses fabricated citations, no AI on sensitive scripts',async()=>{
   const answer=await answerAssistant({pool:pool!,user:employee,question:'сломался ноутбук',locale:'ru',config:disabled});assert.equal(answer.source,'fallback');assert.equal(answer.citations.length,1);assert.equal(answer.citations[0]!.synthetic,true);assert.equal(answer.contacts.length,0);
   const fabricated=await answerAssistant({pool:pool!,user:employee,question:'ноутбук',locale:'ru',config:enabled,fetchFn:async()=>output({sourceIds:[randomUUID()],factIds:[],needsClarification:false})});assert.equal(fabricated.source,'fallback');assert.equal(fabricated.fallbackReason,'INVALID_AI_SELECTION');
   let called=false;const sensitive=await answerAssistant({pool:pool!,user:employee,question:'конфликт',locale:'ru',config:enabled,fetchFn:async()=>{called=true;return output({});}});assert.equal(called,false);assert.equal(sensitive.source,'verified_script');
   const career=await answerAssistant({pool:pool!,user:employee,question:'Мои навыки и карьера',locale:'ru',config:disabled});assert.ok(career.facts.some(f=>f.id==='profile'));assert.ok(career.facts.every(f=>f.href.includes(employee.employeeId!)));
  });
  await t.test('provider receives no employee names/IDs or frontend links and source access is rechecked after inference',async()=>{
   const fullName=(await pool!.query('SELECT full_name FROM employees WHERE employee_id=$1',[employee.employeeId])).rows[0].full_name;
   let checked=false;
   await answerAssistant({pool:pool!,user:employee,question:`Мои навыки ${fullName} ${employee.employeeId}`,locale:'ru',config:enabled,fetchFn:async(_url,init)=>{
    const encoded=String(init.body);assert.equal(encoded.includes(fullName),false);assert.equal(encoded.includes(employee.employeeId!),false);assert.equal(encoded.includes('/employees/'),false);checked=true;
    return output({sourceIds:[],factIds:['profile'],needsClarification:false});
   }});assert.equal(checked,true);
   const changed=await answerAssistant({pool:pool!,user:employee,question:'ноутбук',locale:'ru',config:enabled,fetchFn:async(_url,init)=>{
    const payload=JSON.parse(JSON.parse(String(init.body)).input);const articleId=payload.sources[0].id;
    await pool!.query(`UPDATE guide_articles SET status='archived' WHERE id=$1`,[articleId]);
    return output({sourceIds:[articleId],factIds:[],needsClarification:false});
   }});
   assert.equal(changed.citations.length,0);assert.match(changed.content,/нет подтверждённого ответа/);
  });
  const invoke=async(user:User,path:string,method='GET',payload:unknown={},key=randomUUID())=>{
   let result:any;let status=200;const parsed=new URL(`http://test${path}`);
   const ctx:RouteContext={pool:pool!,config:{databaseUrl:url.toString(),port:0,origin:'http://test',demo:true,secure:false,datasetPath:'./data'},user,path:parsed.pathname,method,url:parsed,req:{headers:{'idempotency-key':key}} as unknown as IncomingMessage,requestId:randomUUID(),body:async()=>payload,send:(data,code=200)=>{result=data;status=code;}};
   assert.equal(await handleAssistant(ctx,disabled),true);return {data:result,status};
  };
  let threadId:string;
  await t.test('thread/messages owner-only even for HR/admin, replay protected and deletion cascades',async()=>{
   threadId=(await invoke(employee,'/assistant/threads','POST',{title:'Мои вопросы',locale:'ru'})).data.id;
   for(const other of [hr,root]){
    await assert.rejects(invoke(other,`/assistant/threads/${threadId}`),(e:unknown)=>e instanceof HttpError&&e.status===404);
    await assert.rejects(invoke(other,`/assistant/threads/${threadId}/messages`,'POST',{content:'Мои навыки'}),HttpError);
   }
   const key=randomUUID();const first=await invoke(employee,`/assistant/threads/${threadId}/messages`,'POST',{content:'сломался ноутбук'},key);
   const second=await invoke(employee,`/assistant/threads/${threadId}/messages`,'POST',{content:'сломался ноутбук'},key);assert.equal(first.data.id,second.data.id);
   await assert.rejects(invoke(employee,`/assistant/threads/${threadId}/messages`,'POST',{content:'другой вопрос'},key),(e:unknown)=>e instanceof HttpError&&e.code==='IDEMPOTENCY_CONFLICT');
   const messages=(await invoke(employee,`/assistant/threads/${threadId}`)).data.messages;assert.equal(messages.length,2);
   await invoke(employee,`/assistant/threads/${threadId}`,'DELETE');assert.equal((await pool!.query('SELECT count(*)::int AS n FROM assistant_messages WHERE thread_id=$1',[threadId])).rows[0].n,0);
  });
  await t.test('retention hides and deletes expired chats without erasing spend ledger',async()=>{
   threadId=(await invoke(employee,'/assistant/threads','POST',{title:'Истекший диалог'})).data.id;await pool!.query(`UPDATE assistant_threads SET expires_at=now()-interval '1 day' WHERE id=$1`,[threadId]);
   await assert.rejects(invoke(employee,`/assistant/threads/${threadId}`),HttpError);assert.equal(await cleanupAssistantRetention(pool!),1);
   assert.ok((await invoke(root,'/admin/ai/usage')).data.requests>0);await assert.rejects(invoke(employee,'/admin/ai/usage'),HttpError);
  });
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
