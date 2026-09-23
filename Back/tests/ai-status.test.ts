import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readAiConfig} from '../src/ai-config.js';
import {readSemanticConfig} from '../src/semantic-config.js';
import {handleAssistant} from '../src/ai.js';
import type {RouteContext} from '../src/http.js';

const key='private-test-embedding-key';
const embeddingEnv={AI_ENABLED:'false',AI_EMBEDDING_ENABLED:'true',OPENAI_API_KEY:key,AI_EMBEDDING_MODEL:'test-embedding-model',AI_EMBEDDING_USD_PER_MILLION:'0.1'};
async function status(env:NodeJS.ProcessEnv){
 let data:any;
 const ctx={path:'/api/v1/admin/ai/usage',method:'GET',user:{role:'admin'},pool:{query:async()=>({rows:[{requests:4,charged_microusd:'1250000',unresolved:1}]})},send:(result:unknown)=>{data=result;}} as unknown as RouteContext;
 assert.equal(await handleAssistant(ctx,readAiConfig(env),readSemanticConfig(env)),true);
 return data;
}
test('AI status enables configured embeddings independently from disabled generation',async()=>{
 const data=await status(embeddingEnv);
 assert.equal(data.enabled,false);assert.equal(data.embeddingsEnabled,true);assert.equal(data.embeddingsConfigured,true);assert.equal(data.embeddingModel,'test-embedding-model');
 assert.equal(data.costBasis,'openai_api_tokens');assert.equal(data.chargedUsd,1.25);assert.equal(data.gpuCostExcluded,true);
 assert.ok(!JSON.stringify(data).includes(key));
});
test('self-hosted generation does not enable embeddings or publish private connection details',async()=>{
 const data=await status({AI_ENABLED:'true',AI_PROVIDER:'self_hosted',AI_BASE_URL:'http://127.0.0.1:18000/v1',AI_API_KEY:'private-gpu-test-key',AI_MODEL_FAST:'test-gpu-model',AI_EMBEDDING_ENABLED:'false'});
 assert.equal(data.provider,'self_hosted');assert.equal(data.enabled,true);assert.equal(data.embeddingsEnabled,false);assert.equal(data.embeddingsConfigured,false);
 assert.ok(!JSON.stringify(data).includes('private-gpu-test-key'));assert.ok(!JSON.stringify(data).includes('18000'));assert.equal(data.gpuCostExcluded,true);
});
test('configured but disabled embeddings and incomplete settings stay distinguishable',async()=>{
 const off=await status({...embeddingEnv,AI_EMBEDDING_ENABLED:'false'});assert.equal(off.embeddingsEnabled,false);assert.equal(off.embeddingsConfigured,true);
 const missing=await status({...embeddingEnv,OPENAI_API_KEY:''});assert.equal(missing.embeddingsEnabled,false);assert.equal(missing.embeddingsConfigured,false);
});
test('AI usage metadata remains administrator-only',async()=>{
 const ctx={path:'/api/v1/admin/ai/usage',method:'GET',user:{role:'employee'}} as unknown as RouteContext;
 await assert.rejects(handleAssistant(ctx,readAiConfig({}),readSemanticConfig({})),{status:403});
});
