import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { createPool,migrate } from '../src/db.js';
import { seedDemoAccounts,type User } from '../src/auth.js';
import { readBundle,importBundle } from '../src/imports.js';
import { handleGuide,searchGuide,seedGuideDemo,getGuideArticle,guideContacts } from '../src/guide.js';
import { type RouteContext,HttpError } from '../src/http.js';

test('guide: approval, immutable versions, access, expiry and contacts',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const admin=createPool(process.env.TEST_DATABASE_URL!);const schema=`guide_test_${randomUUID().replaceAll('-','')}`;let pool:Pool|undefined;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);pool=createPool(url.toString());
  await migrate(pool);await importBundle(pool,await readBundle('./data'),{commit:true});await seedDemoAccounts(pool);
  const users=(await pool.query(`SELECT id,login,display_name AS "displayName",app_role AS role,employee_id AS "employeeId",demo_only AS demo FROM user_accounts`)).rows as User[];
  const employee=users.find(u=>u.role==='employee')!,hr=users.find(u=>u.role==='hr')!,root=users.find(u=>u.role==='admin')!;
  const invoke=async(user:User,path:string,method='GET',payload:unknown={})=>{
   let result:any;let status=200;const parsed=new URL(`http://test${path}`);
   const ctx:RouteContext={pool:pool!,config:{databaseUrl:url.toString(),port:0,origin:'http://test',demo:true,secure:false,datasetPath:'./data'},user,path:parsed.pathname,method,url:parsed,req:{headers:{}} as IncomingMessage,requestId:randomUUID(),body:async()=>payload,send:(data,code=200)=>{result=data;status=code;}};
   assert.equal(await handleGuide(ctx),true);return {data:result,status};
  };
  await t.test('synthetic localized seed is idempotent and explicitly lacks company contacts',async()=>{
   assert.equal((await seedGuideDemo(pool!)).created,15);assert.equal((await seedGuideDemo(pool!)).created,0);
   for(const locale of ['ru','kk','en'] as const){const rows=await searchGuide(pool!,employee,{locale,q:locale==='ru'?'ноутбук':locale==='kk'?'ноутбук':'laptop'});assert.equal(rows.length,1);assert.equal(rows[0]!.synthetic,true);}
   assert.deepEqual(await guideContacts(pool!,employee),[]);
   assert.equal((await invoke(employee,'/guide/hints?context=onboarding')).data.length,2);
  });
  let topicId:string;let articleId:string;let versionId:string;
  await t.test('employee cannot author, HR draft invisible until reviewed publication',async()=>{
   await assert.rejects(invoke(employee,'/guide/topics','POST',{slug:'access-help',category:'IT'}),(e:unknown)=>e instanceof HttpError&&e.status===403);
   topicId=(await invoke(hr,'/guide/topics','POST',{slug:'access-help',category:'IT',aliases:{ru:['впн','vpn','доступ'],kk:[],en:[]}})).data.id;
   articleId=(await invoke(hr,'/guide/articles','POST',{topicId,locale:'ru',title:'Проверка доступа',summary:'Проверенная инструкция',body:'Откройте официальный справочник контактов.',appliesWhen:'При проблеме доступа',steps:['Проверьте утверждённый канал поддержки.'],aiAllowed:true})).data.id;
   await assert.rejects(getGuideArticle(pool!,employee,articleId),(e:unknown)=>e instanceof HttpError&&e.status===404);
   await assert.rejects(invoke(hr,`/guide/articles/${articleId}/publish`,'POST',{humanReviewed:false,expiresAt:new Date(Date.now()+86400000).toISOString()}),HttpError);
   await invoke(hr,`/guide/articles/${articleId}/publish`,'POST',{humanReviewed:true,expiresAt:new Date(Date.now()+86400000).toISOString()});
   assert.equal((await getGuideArticle(pool!,employee,articleId)).status,'published');
   assert.ok((await searchGuide(pool!,employee,{locale:'ru',q:'сломался впн'})).some(a=>a.id===articleId));
  });
  await t.test('published content immutable in API and SQL; new version archives previous',async()=>{
   await assert.rejects(invoke(hr,`/guide/articles/${articleId}`,'PATCH',{title:'Изменено'}),(e:unknown)=>e instanceof HttpError&&e.status===409);
   await assert.rejects(pool!.query('UPDATE guide_articles SET body=$2 WHERE id=$1',[articleId,'Недопустимое изменение']),/immutable/);
   versionId=(await invoke(hr,`/guide/articles/${articleId}/versions`,'POST')).data.id;
   await invoke(hr,`/guide/articles/${versionId}`,'PATCH',{title:'Проверка доступа v2'});
   await invoke(hr,`/guide/articles/${versionId}/publish`,'POST',{humanReviewed:true,expiresAt:new Date(Date.now()+86400000).toISOString()});
   assert.equal((await getGuideArticle(pool!,employee,versionId)).version,2);
   await assert.rejects(getGuideArticle(pool!,employee,articleId),HttpError);
   assert.equal((await invoke(hr,`/guide/articles/${versionId}/versions`)).data.length,2);
  });
  await t.test('role and department visibility filter search and article detail',async()=>{
   const restricted=(await invoke(hr,'/guide/articles','POST',{topicId,locale:'en',title:'HR private policy',summary:'For HR only',body:'Internal HR information.',appliesWhen:'HR operation',visibility:['hr','admin'],aiAllowed:true})).data.id;
   await invoke(hr,`/guide/articles/${restricted}/publish`,'POST',{humanReviewed:true,expiresAt:new Date(Date.now()+86400000).toISOString()});
   await assert.rejects(getGuideArticle(pool!,employee,restricted),HttpError);
   assert.equal((await searchGuide(pool!,employee,{locale:'en',q:'private'})).length,0);
   assert.equal((await searchGuide(pool!,hr,{locale:'en',q:'private'})).length,1);
  });
  await t.test('expired articles are unavailable to employees and assistant retrieval',async()=>{
   const expired=(await invoke(hr,'/guide/articles','POST',{topicId,locale:'kk',title:'Мерзімі өткен',summary:'Өткен материал',body:'Ескі материал',appliesWhen:'Ескі жағдай',aiAllowed:true})).data.id;
   await pool!.query(`UPDATE guide_articles SET status='published',approved_by=$2,reviewed_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1`,[expired,hr.id]);
   await assert.rejects(getGuideArticle(pool!,employee,expired),HttpError);assert.equal((await searchGuide(pool!,employee,{locale:'kk',q:'Ескі',aiOnly:true})).length,0);
  });
  await t.test('central contacts require verification; independent private fallback remains available',async()=>{
   const primary=(await invoke(hr,'/guide/contacts','POST',{label:'Демо основной',channel:'demo',value:'Организация не настроила контакт',synthetic:true,verified:false,expiresAt:new Date(Date.now()+86400000).toISOString()})).data.id;
   const fallback=(await invoke(hr,'/guide/contacts','POST',{label:'Демо приватный',channel:'demo',value:'Организация не настроила контакт',synthetic:true,confidential:true,verified:true,expiresAt:new Date(Date.now()+86400000).toISOString()})).data.id;
   await invoke(hr,'/guide/routing','POST',{topicId,primaryContactId:primary,fallbackContactId:fallback});
   const contacts=await guideContacts(pool!,employee,topicId);assert.equal(contacts.length,1);assert.equal(contacts[0]!.id,fallback);assert.equal(contacts[0]!.priority,'fallback');
   await invoke(hr,`/guide/contacts/${fallback}`,'PUT',{label:'Демо приватный новый',channel:'demo',value:'Новая инструкция для демо',synthetic:true,confidential:true,verified:true,expiresAt:new Date(Date.now()+86400000).toISOString()});
   assert.equal((await guideContacts(pool!,employee,topicId))[0]!.value,'Новая инструкция для демо');
  });
  await t.test('sensitive real article cannot publish without confidential verified real route',async()=>{
   const sensitive=(await invoke(root,'/guide/topics','POST',{slug:'actual-conflict',category:'ethics',sensitivity:'sensitive'})).data.id;
   const draft=(await invoke(hr,'/guide/articles','POST',{topicId:sensitive,locale:'ru',title:'Конфликт',summary:'Утверждённая инструкция',body:'Используйте проверенный приватный канал.',appliesWhen:'Конфликт'})).data.id;
   await assert.rejects(invoke(hr,`/guide/articles/${draft}/publish`,'POST',{humanReviewed:true,expiresAt:new Date(Date.now()+86400000).toISOString()}),(e:unknown)=>e instanceof HttpError&&e.code==='VERIFIED_CONTACT_REQUIRED');
  });
  await t.test('feedback authored by employee can be resolved only by content staff',async()=>{
   const id=(await invoke(employee,`/guide/articles/${versionId}/feedback`,'POST',{kind:'wrong_contact',comment:'Контакт нуждается в проверке'})).data.id;
   await assert.rejects(invoke(employee,`/guide/feedback/${id}/resolve`,'POST'),HttpError);
   assert.ok((await invoke(hr,`/guide/feedback/${id}/resolve`,'POST')).data.resolved_at);
  });
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
