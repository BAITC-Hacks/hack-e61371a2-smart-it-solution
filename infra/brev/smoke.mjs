// Explicit live check against self-hosted GPU + synthetic demo API. No OpenAI calls.
// Run in the back container as documented in Back/NVIDIA_BREV_SETUP.md.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

assert.equal(process.env.AI_PROVIDER, 'self_hosted');
assert.equal(process.env.DEMO_MODE, 'true');
const modelBase = process.env.AI_BASE_URL;
const modelKey = process.env.AI_API_KEY;
assert.ok(modelBase && modelKey, 'Self-hosted credentials missing');
const unauthenticated = await fetch(`${modelBase}/models`, { signal: AbortSignal.timeout(10000) });
assert.equal(unauthenticated.status, 401, 'Model endpoint must require authentication');
await unauthenticated.body?.cancel();
const models = await fetch(`${modelBase}/models`, {
  headers: { Authorization: `Bearer ${modelKey}` }, signal: AbortSignal.timeout(10000),
});
assert.equal(models.status, 200);
assert.ok((await models.json()).data.some(m => m.id === process.env.AI_MODEL_FAST));

const base = `http://127.0.0.1:${process.env.API_PORT || 3001}/api/v1`;
const headers = { Origin: process.env.APP_ORIGIN, 'Content-Type': 'application/json' };
async function request(path, method = 'GET', body, key) {
  const response = await fetch(base + path, {
    method, headers: { ...headers, ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(65000),
  });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${result.error?.code || ''}`);
  return { data: result.data, response };
}
const login = await request('/auth/login', 'POST', { login: 'demo.employee', demo: true });
headers.Cookie = login.response.headers.get('set-cookie').split(';', 1)[0];
headers['X-CSRF-Token'] = login.data.csrfToken;
const threads = [];
try {
  const cases = [
    { locale: 'ru', content: 'Сломался ноутбук. К кому обратиться?', expected: 'citations' },
    { locale: 'kk', content: 'Ноутбук істемейді. Кімге хабарласу керек?', expected: 'citations' },
    { locale: 'ru', content: 'Какие навыки мне нужно развивать для моей карьерной цели?', expected: 'facts' },
  ];
  const prepared = [];
  for (const item of cases) {
    const { data: thread } = await request('/assistant/threads', 'POST', {
      title: 'Brev integration smoke', locale: item.locale,
    });
    threads.push(thread.id);
    prepared.push({ ...item, threadId: thread.id });
  }
  async function check(item) {
    const started = performance.now();
    const key = randomUUID();
    const path = `/assistant/threads/${item.threadId}/messages`;
    const { data: answer } = await request(path, 'POST', { content: item.content }, key);
    assert.equal(answer.source, 'ai', `${item.locale}: ${answer.fallbackReason || 'no AI selection'}`);
    assert.ok(answer[item.expected].length > 0, `${item.locale}: missing verified ${item.expected}`);
    assert.ok(answer.content.length > 0);
    const latencyMs = Math.round(performance.now() - started);
    const { data: replay } = await request(path, 'POST', { content: item.content }, key);
    assert.equal(replay.id, answer.id, 'Idempotent replay must reuse the answer');
    console.log(JSON.stringify({ locale: item.locale, kind: item.expected, source: answer.source,
      latencyMs, citations: answer.citations.length, facts: answer.facts.length, replay: 'passed' }));
  }
  // Two simultaneous requests exercise the configured A10G concurrency.
  const pair = await Promise.allSettled(prepared.slice(0, 2).map(check));
  const failed = pair.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  await check(prepared[2]);
  console.log('Live self-hosted smoke passed. OpenAI was not used.');
} finally {
  for (const id of threads) await request(`/assistant/threads/${id}`, 'DELETE');
  await request('/auth/logout', 'POST', {});
}
