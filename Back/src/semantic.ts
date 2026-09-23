import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { User } from './auth.js';
import { reserveAiBudget, settleAiBudget, redactQuestion, type FetchLike } from './ai.js';
import { readAiConfig, type AiConfig } from './ai-config.js';
import { getGuideArticle, searchGuide, type GuideArticle, type Locale } from './guide.js';
import { audit, HttpError, idempotent, idempotencyPayloadHash, requireRole, transaction, type Queryable, type RouteContext } from './http.js';

const locale=z.enum(['ru','kk','en']);
const queryShape=z.object({q:z.string().trim().min(2).max(300),locale:locale.default('ru')}).strict();
const REDACTION_VERSION='semantic-redaction-v1';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type SemanticConfig={enabled:boolean;model:string;price:number;budget:AiConfig};
export function readSemanticConfig(env:NodeJS.ProcessEnv=process.env):SemanticConfig{
 const base=readAiConfig({...env,AI_ENABLED:'false'});
 const model=(env.AI_EMBEDDING_MODEL??'').trim();const price=Number(env.AI_EMBEDDING_USD_PER_MILLION);
 return {enabled:env.AI_ENABLED==='true'&&Boolean(base.apiKey&&model)&&Number.isFinite(price)&&price>0,model,price:Number.isFinite(price)&&price>0?price:0,budget:base};
}
function configured(config:SemanticConfig){if(!config.enabled)throw new HttpError(503,'SEMANTIC_NOT_CONFIGURED','Нужны AI_ENABLED, серверный ключ, модель embeddings и явная цена');}
async function assertCurrentActor(db:Queryable,user:User,lock=false){
 const current=(await db.query(`SELECT active,app_role,employee_id FROM user_accounts WHERE id=$1${lock?' FOR SHARE':''}`,[user.id])).rows[0];
 if(!current?.active||current.app_role!==user.role||current.employee_id!==user.employeeId)throw new HttpError(401,'AUTH_CONTEXT_CHANGED','Права учётной записи изменились; войдите заново');
}
export function cosine(a:number[],b:number[]){
 if(a.length!==b.length||!a.length)throw new HttpError(502,'EMBEDDING_DIMENSIONS','Размерности embeddings не совпадают');
 let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){const x=a[i]!,y=b[i]!;if(!Number.isFinite(x)||!Number.isFinite(y))throw new HttpError(502,'EMBEDDING_INVALID','Некорректный вектор');dot+=x*y;aa+=x*x;bb+=y*y;}
 if(!aa||!bb)throw new HttpError(502,'EMBEDDING_INVALID','Нулевой вектор');return Math.max(-1,Math.min(1,dot/Math.sqrt(aa*bb)));
}
export function recallAt3(actual:string[],expected:string[]){const wanted=new Set(expected);return wanted.size?new Set(actual.slice(0,3).filter(id=>wanted.has(id))).size/wanted.size:0;}
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
async function sanitizer(db:Queryable){
 const [employees,contacts]=await Promise.all([db.query('SELECT employee_id,full_name FROM employees'),db.query('SELECT value FROM contact_channels')]);
 const identifiers=[...employees.rows.flatMap(e=>[e.employee_id,e.full_name,...String(e.full_name).split(/\s+/).filter(p=>p.length>=3)]),...contacts.rows.map(c=>c.value)].filter(Boolean).sort((a,b)=>String(b).length-String(a).length);
 return (value:string)=>{
  let safe=value.normalize('NFKC');for(const identifier of identifiers)safe=safe.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(String(identifier))}(?![\\p{L}\\p{N}])`,'giu'),'[private removed]');
  safe=safe.replace(/https?:\/\/\S+/gi,'[url removed]').replace(/\+?\d[\d ()-]{5,}\d/g,'[phone removed]');
  return redactQuestion(safe).trim();
 };
}
function revision(a:GuideArticle){return hash({id:a.id,topicId:a.topic_id,locale:a.locale,version:a.version,title:a.title,summary:a.summary,body:a.body,when:a.applies_when,steps:a.steps,tags:a.tags,visibility:a.visibility,departments:a.departments,aiAllowed:a.ai_allowed,reviewedAt:a.reviewed_at,expiresAt:a.expires_at,updatedAt:a.updated_at,status:a.status,redaction:REDACTION_VERSION});}
type State={articles:GuideArticle[];corpusHash:string;indexHash:string;indexed:Map<string,{revision_hash:string;dimensions:number}>};
async function state(db:Queryable,model:string):Promise<State>{
 const articles=(await db.query(`SELECT a.*,t.slug,t.category,t.sensitivity,t.aliases,t.priority FROM guide_articles a JOIN guide_topics t ON t.id=a.topic_id
  WHERE a.status='published' AND a.ai_allowed AND a.approved_by IS NOT NULL AND a.reviewed_at IS NOT NULL AND a.expires_at>now() AND t.active ORDER BY a.id LIMIT 501`)).rows as Array<GuideArticle&{aliases:unknown;priority:number}>;
 if(articles.length>500)throw new HttpError(409,'SEMANTIC_CAPACITY','Для этого индекса поддерживается до 500 актуальных статей');
 const indexes=(await db.query('SELECT article_id,revision_hash,dimensions,vector_hash FROM guide_semantic_embeddings WHERE model=$1 ORDER BY article_id',[model])).rows;
 const valid=indexes.filter(e=>articles.some(a=>a.id===e.article_id&&revision(a)===e.revision_hash));
 return {articles,corpusHash:hash(articles.map(a=>({id:a.id,revision:revision(a),aliases:a.aliases,priority:a.priority,sensitivity:a.sensitivity}))),indexHash:hash({model,redaction:REDACTION_VERSION,index:valid}),indexed:new Map(valid.map(e=>[e.article_id,{revision_hash:e.revision_hash,dimensions:e.dimensions}]))};
}
async function authorizedArticles(db:Queryable,user:User,current:State,language:Locale){
 const found:GuideArticle[]=[];
 for(const candidate of current.articles.filter(a=>a.locale===language)){
  try{const a=await getGuideArticle(db,user,candidate.id);if(a.ai_allowed&&revision(a)===revision(candidate))found.push(a);}catch(e){if(!(e instanceof HttpError&&e.status===404))throw e;}
 }
 return found;
}
function dto(a:GuideArticle,score?:number){return {id:a.id,topicId:a.topic_id,locale:a.locale,title:a.title,summary:a.summary,version:a.version,synthetic:a.synthetic,...(score===undefined?{}:{score:Number(score.toFixed(6))})};}
type EmbedResult={vectors:number[][];usageId:string};
export async function embedTexts(pool:Pool,userId:string,inputs:string[],config:SemanticConfig,purpose:string,fetchFn:FetchLike=fetch):Promise<EmbedResult>{
 configured(config);if(!inputs.length||inputs.length>30||inputs.some(s=>!s||Buffer.byteLength(s,'utf8')>8000))throw new HttpError(400,'EMBEDDING_INPUT_LIMIT','Неподдерживаемый размер текста');
 const tokensUpper=inputs.reduce((n,s)=>n+Buffer.byteLength(s,'utf8')+64,0);const reserved=Math.ceil(tokensUpper*config.price);
 const usageId=await reserveAiBudget({pool,userId,config:config.budget,purpose,model:config.model,reservedMicrousd:reserved});
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.min(config.budget.timeoutMs,8000));let settled=false;
 try{
  const response=await fetchFn('https://api.openai.com/v1/embeddings',{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${config.budget.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:config.model,input:inputs,encoding_format:'float'})});
  if(!response.ok){const rejected=[400,401,403,404,422,429].includes(response.status);await response.body?.cancel().catch(()=>{});await settleAiBudget(pool,usageId,{costMicrousd:rejected?0:reserved,outcome:`embedding_http_${response.status}`});settled=true;throw new HttpError(502,'EMBEDDING_UNAVAILABLE','Сервис embeddings недоступен');}
  const reader=response.body?.getReader();if(!reader)throw new Error('empty response');let bytes=0;const chunks:Uint8Array[]=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>3*1024*1024){await reader.cancel();throw new Error('response too large');}chunks.push(value);}}finally{reader.releaseLock();}
  const parsed=z.object({model:z.literal(config.model),data:z.array(z.object({index:z.number().int().min(0),embedding:z.array(z.number().finite()).min(1).max(4096)})).length(inputs.length),usage:z.object({prompt_tokens:z.number().int().min(0).max(tokensUpper),total_tokens:z.number().int().min(0).max(tokensUpper)})}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const ordered=parsed.data.sort((a,b)=>a.index-b.index);if(ordered.some((r,i)=>r.index!==i)||new Set(ordered.map(r=>r.embedding.length)).size!==1)throw new Error('invalid embeddings');for(const row of ordered)cosine(row.embedding,row.embedding);
  await settleAiBudget(pool,usageId,{costMicrousd:Math.ceil(parsed.usage.total_tokens*config.price),inputTokens:parsed.usage.total_tokens,outputTokens:0,outcome:'embedding_completed'});settled=true;
  return {vectors:ordered.map(r=>r.embedding),usageId};
 }catch(error){if(!settled)await settleAiBudget(pool,usageId,{costMicrousd:reserved,outcome:controller.signal.aborted?'embedding_timeout_uncertain':'embedding_invalid_or_network_uncertain'});if(error instanceof HttpError)throw error;throw new HttpError(502,'EMBEDDING_UNAVAILABLE','Сервис embeddings недоступен');}
 finally{clearTimeout(timer);}
}
/** Reserve only a durable receipt, never a DB transaction around a paid request. Uncertain retries require a new key. */
async function requestOnce<T>(ctx:RouteContext,operation:string,payload:unknown,fn:()=>Promise<T>):Promise<T>{
 const key=ctx.req.headers['idempotency-key'];if(typeof key!=='string'||key.length<8||key.length>160)throw new HttpError(400,'IDEMPOTENCY_REQUIRED','Нужен Idempotency-Key длиной 8–160 символов');
 const digest=idempotencyPayloadHash(ctx.user,payload);const claim=(await ctx.pool.query('INSERT INTO guide_semantic_requests(user_id,operation,request_key,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[ctx.user.id,operation,key,digest])).rows[0];
 if(!claim){const prior=(await ctx.pool.query('SELECT *,expires_at<=now() AS expired FROM guide_semantic_requests WHERE user_id=$1 AND operation=$2 AND request_key=$3',[ctx.user.id,operation,key])).rows[0];if(prior.payload_hash!==digest)throw new HttpError(409,'IDEMPOTENCY_CONFLICT','Ключ уже использован для другого запроса');if(prior.status==='completed'){await assertCurrentActor(ctx.pool,ctx.user);if(prior.result.error)throw new HttpError(prior.result.error.status,prior.result.error.code,prior.result.error.message);return prior.result as T;}if(prior.expired){await ctx.pool.query("UPDATE guide_semantic_requests SET status='uncertain' WHERE id=$1 AND status='running'",[prior.id]);throw new HttpError(409,'SEMANTIC_REQUEST_UNCERTAIN','Результат предыдущей операции неизвестен; проверьте состояние и используйте новый ключ');}throw new HttpError(409,'SEMANTIC_REQUEST_IN_PROGRESS','Запрос уже выполняется');}
 try{const result=await fn();await assertCurrentActor(ctx.pool,ctx.user);await ctx.pool.query("UPDATE guide_semantic_requests SET status='completed',result=$2 WHERE id=$1",[claim.id,JSON.stringify(result)]);return result;}catch(error){const e=error instanceof HttpError?error:new HttpError(500,'SEMANTIC_OPERATION_FAILED','Операция не завершена');await ctx.pool.query("UPDATE guide_semantic_requests SET status='completed',result=$2 WHERE id=$1",[claim.id,{error:{status:e.status,code:e.code,message:e.message}}]);throw error;}
}
async function queryVectors(pool:Pool,userId:string,queries:Array<{q:string;locale:Locale}>,config:SemanticConfig,fetchFn:FetchLike){
 const result:number[][]=new Array(queries.length);const missing:Array<{index:number;digest:string;q:string;locale:Locale}>=[];const usageIds:string[]=[];
 for(const [index,q] of queries.entries()){const digest=hash({q:q.q,redaction:REDACTION_VERSION});const cached=(await pool.query('SELECT vector FROM guide_semantic_queries WHERE query_hash=$1 AND locale=$2 AND model=$3',[digest,q.locale,config.model])).rows[0];if(cached)result[index]=cached.vector;else missing.push({index,digest,...q});}
 if(missing.length){const reply=await embedTexts(pool,userId,missing.map(q=>q.q),config,'semantic_query',fetchFn);usageIds.push(reply.usageId);
  await transaction(pool,async db=>{for(const [index,item] of missing.entries()){const vector=reply.vectors[index]!;await db.query('INSERT INTO guide_semantic_queries(query_hash,locale,model,vector,dimensions,usage_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(query_hash,locale,model) DO NOTHING',[item.digest,item.locale,config.model,vector,vector.length,reply.usageId]);result[item.index]=vector;}});
 }
 return {vectors:result,usageIds};
}
async function rank(db:Queryable,articles:GuideArticle[],vector:number[],model:string,current:State){
 const entries=(await db.query('SELECT article_id,revision_hash,vector FROM guide_semantic_embeddings WHERE model=$1 AND article_id=ANY($2::uuid[])',[model,articles.map(a=>a.id)])).rows;
 return entries.filter(e=>current.indexed.get(e.article_id)?.revision_hash===e.revision_hash).map(e=>({id:e.article_id as string,score:cosine(vector,e.vector)})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,3);
}
async function baseline(pool:Pool,user:User,q:{q:string;locale:Locale},reason:string){const articles=await searchGuide(pool,user,{...q,limit:3});await assertCurrentActor(pool,user);return {source:'sql' as const,fallbackReason:reason,articles:articles.map(a=>dto(a))};}
async function enabledState(db:Queryable,config:SemanticConfig){const current=await state(db,config.model);const settings=(await db.query('SELECT * FROM guide_semantic_settings WHERE singleton')).rows[0];return {current,valid:config.enabled&&settings.enabled&&settings.model===config.model&&settings.corpus_hash===current.corpusHash&&settings.index_hash===current.indexHash};}

export async function handleSemantic(ctx:RouteContext,options:{config?:SemanticConfig;fetchFn?:FetchLike}={}):Promise<boolean>{
 const {path,method,pool,user}=ctx;const isSearch=path==='/api/v1/guide/semantic-search';const isAdmin=['/api/v1/admin/semantic/index','/api/v1/admin/semantic/evaluate','/api/v1/admin/semantic/enable'].includes(path);
 if(method!=='POST'||(!isSearch&&!isAdmin))return false;if(isAdmin)requireRole(user,'admin');
 const config=options.config??readSemanticConfig();const fetchFn=options.fetchFn??fetch;
 if(isSearch){
  const p=queryShape.parse(await ctx.body());if(!config.enabled){ctx.send(await baseline(pool,user,p,'DISABLED'));return true;}
  let check:Awaited<ReturnType<typeof enabledState>>;try{check=await enabledState(pool,config);}catch{ctx.send(await baseline(pool,user,p,'INDEX_UNAVAILABLE'));return true;}
  if(!check.valid){ctx.send(await baseline(pool,user,p,'NOT_ENABLED_OR_STALE'));return true;}
  const allowed=await authorizedArticles(pool,user,check.current,p.locale);
  if(!allowed.length||allowed.some(a=>!check.current.indexed.has(a.id))){ctx.send(await baseline(pool,user,p,'UNINDEXED'));return true;}
  const safe=(await sanitizer(pool))(p.q);if(safe.length<2){ctx.send(await baseline(pool,user,p,'EMPTY_SAFE_QUERY'));return true;}
  const stored=await requestOnce(ctx,'semantic.search',{...p,q:hash(p.q),model:config.model,corpusHash:check.current.corpusHash,indexHash:check.current.indexHash},async()=>{
   try{const query=await queryVectors(pool,user.id,[{q:safe,locale:p.locale}],config,fetchFn);const hits=await rank(pool,allowed,query.vectors[0]!,config.model,check.current);return {hits,usageIds:query.usageIds,fallbackReason:null};}
   catch(e){if(!(e instanceof HttpError))throw e;return {hits:[] as {id:string;score:number}[],usageIds:[] as string[],fallbackReason:e.code};}
  });
  const after=await enabledState(pool,config);if(!after.valid||after.current.corpusHash!==check.current.corpusHash||after.current.indexHash!==check.current.indexHash||stored.fallbackReason){ctx.send(await baseline(pool,user,p,stored.fallbackReason??'INDEX_CHANGED'));return true;}
  const articles=[];for(const hit of stored.hits){try{const a=await getGuideArticle(pool,user,hit.id);if(a.ai_allowed&&revision(a)===after.current.indexed.get(a.id)?.revision_hash)articles.push(dto(a,hit.score));}catch(e){if(!(e instanceof HttpError&&e.status===404))throw e;}}
  if(!articles.length){ctx.send(await baseline(pool,user,p,'NO_ACCESSIBLE_RESULTS'));return true;}await assertCurrentActor(pool,user);ctx.send({source:'semantic',articles,usageIds:stored.usageIds,fallbackReason:null});return true;
 }
 if(path.endsWith('/index')){
  configured(config);const p=z.object({articleIds:z.array(z.uuid()).min(1).max(10).refine(ids=>new Set(ids).size===ids.length)}).strict().parse(await ctx.body());
  const result=await requestOnce(ctx,'semantic.index',{...p,model:config.model},async()=>{
   const before=await state(pool,config.model);const clean=await sanitizer(pool);const selected:GuideArticle[]=[];
   for(const id of p.articleIds){const a=await getGuideArticle(pool,user,id,true);if(!before.articles.some(s=>s.id===id&&revision(s)===revision(a)))throw new HttpError(409,'ARTICLE_NOT_INDEXABLE','Индексируются только актуальные утверждённые ai_allowed статьи');selected.push(a);}
   const inputs=selected.map(a=>clean([a.title,a.summary,a.applies_when,...a.steps,a.body].join('\n')));const reply=await embedTexts(pool,user.id,inputs,config,'semantic_index',fetchFn);
   return transaction(pool,async db=>{await assertCurrentActor(db,user,true);await db.query('SELECT id FROM guide_articles WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[p.articleIds]);const current=await state(db,config.model);const indexed=[];
    for(const [i,a] of selected.entries()){const live=current.articles.find(x=>x.id===a.id);if(!live||revision(live)!==revision(a))throw new HttpError(409,'ARTICLE_CHANGED','Статья изменилась во время индексации');const vector=reply.vectors[i]!;
     if([...current.indexed.values()].some(v=>v.dimensions!==vector.length))throw new HttpError(409,'EMBEDDING_DIMENSIONS','Размерность модели изменилась; выберите новый идентификатор модели');
     const truncated=[a.title,a.summary,a.applies_when,...a.steps,a.body].join('\n').length>2000;
     await db.query(`INSERT INTO guide_semantic_embeddings(article_id,model,revision_hash,vector,dimensions,vector_hash,input_hash,input_characters,truncated,usage_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(article_id,model) DO UPDATE SET revision_hash=EXCLUDED.revision_hash,vector=EXCLUDED.vector,dimensions=EXCLUDED.dimensions,vector_hash=EXCLUDED.vector_hash,input_hash=EXCLUDED.input_hash,input_characters=EXCLUDED.input_characters,truncated=EXCLUDED.truncated,usage_id=EXCLUDED.usage_id,created_at=now()`,[a.id,config.model,revision(a),vector,vector.length,hash(vector),hash(inputs[i]),inputs[i]!.length,truncated,reply.usageId]);indexed.push({articleId:a.id,revisionHash:revision(a),charactersIndexed:inputs[i]!.length,truncated});}
    const after=await state(db,config.model);await audit(db,user,'semantic.index','guide_semantic',config.model,{articleIds:p.articleIds},ctx.requestId);return {indexed,model:config.model,corpusHash:after.corpusHash,indexHash:after.indexHash,usageId:reply.usageId};
   });
  });ctx.send(result);return true;
 }
 if(path.endsWith('/evaluate')){
  configured(config);const p=z.object({queries:z.array(queryShape.extend({expectedArticleIds:z.array(z.uuid()).min(1).max(3).refine(ids=>new Set(ids).size===ids.length)})).min(10).max(30)}).strict().parse(await ctx.body());
  const clean=await sanitizer(pool);const queries=p.queries.map(q=>({...q,q:clean(q.q)}));if(new Set(queries.map(q=>q.q.toLocaleLowerCase().replace(/\s+/g,' '))).size<10)throw new HttpError(400,'EVALUATION_DIVERSITY','Нужно минимум 10 различных вопросов после очистки');
  const result=await requestOnce(ctx,'semantic.evaluate',{queries,model:config.model},async()=>{
   const before=await state(pool,config.model);const byLocale=new Map<Locale,GuideArticle[]>();for(const q of queries){if(!byLocale.has(q.locale))byLocale.set(q.locale,await authorizedArticles(pool,user,before,q.locale));const allowed=byLocale.get(q.locale)!;
    if(q.expectedArticleIds.some(id=>!allowed.some(a=>a.id===id))||allowed.some(a=>!before.indexed.has(a.id)))throw new HttpError(409,'EVALUATION_UNINDEXED','Все доступные статьи и ожидаемые ответы должны входить в актуальный индекс');}
   const embeddings=await queryVectors(pool,user.id,queries,config,fetchFn);const results:Array<{q:string;locale:Locale;expectedArticleIds:string[];sqlArticleIds:string[];semanticArticleIds:string[];sqlRecallAt3:number;semanticRecallAt3:number}>=[];
   for(const [i,q] of queries.entries()){const sql=await searchGuide(pool,user,{q:q.q,locale:q.locale,limit:3});const semantic=await rank(pool,byLocale.get(q.locale)!,embeddings.vectors[i]!,config.model,before);results.push({...q,sqlArticleIds:sql.map(a=>a.id),semanticArticleIds:semantic.map(a=>a.id),sqlRecallAt3:recallAt3(sql.map(a=>a.id),q.expectedArticleIds),semanticRecallAt3:recallAt3(semantic.map(a=>a.id),q.expectedArticleIds)});}
   const after=await state(pool,config.model);if(after.corpusHash!==before.corpusHash||after.indexHash!==before.indexHash)throw new HttpError(409,'INDEX_CHANGED','Индекс изменился во время оценки');
   for(const q of queries)for(const id of q.expectedArticleIds)await getGuideArticle(pool,user,id);
   const sqlRecall=results.reduce((n,r)=>n+r.sqlRecallAt3,0)/results.length;const semanticRecall=results.reduce((n,r)=>n+r.semanticRecallAt3,0)/results.length;const passed=semanticRecall>=sqlRecall&&semanticRecall>=0.7;
   const row=await transaction(pool,async db=>{await assertCurrentActor(db,user,true);const inserted=(await db.query('INSERT INTO guide_semantic_evaluations(actor,model,corpus_hash,index_hash,query_count,sql_recall,semantic_recall,passed,results) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',[user.id,config.model,before.corpusHash,before.indexHash,queries.length,sqlRecall,semanticRecall,passed,JSON.stringify(results)])).rows[0];await audit(db,user,'semantic.evaluate','guide_semantic_evaluation',inserted.id,{passed,sqlRecallAt3:sqlRecall,semanticRecallAt3:semanticRecall},ctx.requestId);return inserted;});
   return {id:row.id,model:config.model,corpusHash:before.corpusHash,indexHash:before.indexHash,queryCount:queries.length,sqlRecallAt3:sqlRecall,semanticRecallAt3:semanticRecall,passed,results,usageIds:embeddings.usageIds};
  });ctx.send(result);return true;
 }
 const p=z.object({enabled:z.boolean(),evaluationId:z.uuid().optional()}).strict().refine(p=>!p.enabled||Boolean(p.evaluationId),'Нужна сохранённая оценка').parse(await ctx.body());
 if(p.enabled)configured(config);
 await assertCurrentActor(pool,user);
 const result=await idempotent(ctx,'semantic.enable',p,async db=>{await assertCurrentActor(db,user,true);
  if(!p.enabled){await db.query('UPDATE guide_semantic_settings SET enabled=false,changed_by=$1,updated_at=now() WHERE singleton',[user.id]);await audit(db,user,'semantic.disable','guide_semantic','settings',{},ctx.requestId);return {enabled:false};}
  const current=await state(db,config.model);const evaluation=(await db.query('SELECT * FROM guide_semantic_evaluations WHERE id=$1',[p.evaluationId])).rows[0];
  if(!evaluation||!evaluation.passed||evaluation.query_count<10||Number(evaluation.semantic_recall)<0.7||Number(evaluation.semantic_recall)<Number(evaluation.sql_recall)||evaluation.model!==config.model||evaluation.corpus_hash!==current.corpusHash||evaluation.index_hash!==current.indexHash)throw new HttpError(409,'EVALUATION_REQUIRED','Нужна успешная оценка текущих модели, статей и индекса');
  await db.query('UPDATE guide_semantic_settings SET enabled=true,model=$1,corpus_hash=$2,index_hash=$3,evaluation_id=$4,changed_by=$5,updated_at=now() WHERE singleton',[config.model,current.corpusHash,current.indexHash,evaluation.id,user.id]);await audit(db,user,'semantic.enable','guide_semantic','settings',{evaluationId:evaluation.id},ctx.requestId);return {enabled:true,evaluationId:evaluation.id,model:config.model,corpusHash:current.corpusHash,indexHash:current.indexHash};
 });ctx.send(result);return true;
}
