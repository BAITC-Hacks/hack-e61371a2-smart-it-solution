import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool,PoolClient } from 'pg';
import { createPool,migrate } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { createApp } from '../src/server.js';

test('HTTP login limits and credential reset concurrency',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 const admin=createPool(process.env.TEST_DATABASE_URL!);const schema=`login_test_${randomUUID().replaceAll('-','')}`;
 let pool:Pool|undefined,server:Server|undefined,blocker:PoolClient|undefined;
 const password='Test password only 12345';
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);url.searchParams.set('application_name',schema);
  pool=createPool(url.toString());await migrate(pool);
  const originalHash=await hashPassword(password);
  for(const login of ['alice','bob','reset-race'])await pool.query(`INSERT INTO user_accounts(login,display_name,app_role,password_hash) VALUES($1,$1,'hr',$2)`,[login,originalHash]);
  const origin='http://localhost:5173';server=createApp(pool,{databaseUrl:url.toString(),port:0,origin,demo:false,secure:false,datasetPath:'./data'});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const login=async(name:string,value=password)=>{
   const response=await fetch(`${base}/auth/login`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({login:name,password:value})});
   return {status:response.status,json:await response.json() as any,cookie:response.headers.get('set-cookie'),retryAfter:response.headers.get('retry-after')};
  };
  await t.test('more than twenty successful logins behind one proxy IP remain available',async()=>{
   for(let i=0;i<25;i++){const response=await login('alice');assert.equal(response.status,200,`Successful login ${i+1}: ${JSON.stringify(response.json)}`);}
  });
  await t.test('twenty bad credentials throttle only that login and successful credentials clear earlier failures',async()=>{
   assert.equal((await login('bob','wrong credential')).status,401);
   assert.equal((await login('bob')).status,200);
   for(let i=0;i<19;i++)assert.equal((await login('bob','wrong credential')).status,401);
   assert.equal((await login('bob')).status,200,'Success must have cleared the failure preceding the nineteen new failures');
   for(let i=0;i<20;i++)assert.equal((await login('alice','wrong credential')).status,401);
   const blocked=await login('alice');assert.equal(blocked.status,429);assert.equal(blocked.json.error.code,'RATE_LIMITED');assert.ok(Number(blocked.retryAfter)>0);
   assert.equal((await login('bob')).status,200);
  });
  await t.test('a verified stale password cannot issue a session after a concurrent reset commits',async()=>{
   const account=(await pool!.query(`SELECT id FROM user_accounts WHERE login='reset-race'`)).rows[0];
   blocker=await pool!.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM user_accounts WHERE id=$1 FOR UPDATE',[account.id]);
   const pending=login('reset-race');
   // Observe the actual login transaction waiting on our row lock; no fixed timing assumption about scrypt.
   let waiting=false;const deadline=Date.now()+10000;
   while(Date.now()<deadline){
    const rows=(await admin.query(`SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND state='active' AND query ILIKE '%user_accounts%' AND query ILIKE '%FOR UPDATE%'`,[schema])).rows;
    if(rows.length){waiting=true;break;}
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   if(!waiting){await blocker.query('ROLLBACK');blocker.release();blocker=undefined;await pending;assert.fail('Login never waited on the account row; credentials must be rechecked under FOR UPDATE before issuing a session');}
   await blocker.query('UPDATE user_accounts SET password_hash=$2 WHERE id=$1',[account.id,await hashPassword('Changed test password 98765')]);
   await blocker.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1',[account.id]);
   await blocker.query('COMMIT');blocker.release();blocker=undefined;
   const response=await pending;assert.equal(response.status,401);assert.equal(response.cookie,null);
   assert.equal((await pool!.query('SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',[account.id])).rows[0].n,0);
   assert.equal((await login('reset-race','Changed test password 98765')).status,200);
  });
 }finally{
  if(blocker){await blocker.query('ROLLBACK');blocker.release();}
  if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
 }
});
