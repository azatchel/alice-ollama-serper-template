import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, fitAliceText, safeHistory, isSearchIntent } from '../api/index.js';
import { searchWeb, askOllama, configuration, fetchJson, keysFor } from '../lib/core.js';
import { createStore, RESERVE_SCRIPT, COMPLETE_SCRIPT } from '../lib/store.js';

const env = { WEBHOOK_SECRET: 'a'.repeat(40), ALICE_SKILL_ID: 'skill', OLLAMA_API_KEY: 'ollama-test',
  SERPER_API_KEY: 'serper-test', UPSTASH_REDIS_REST_URL: 'https://test.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'redis-test' };
const config = configuration(env);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function request(text = 'Привет', messageId = 1, sessionId = 'session') {
  return { method: 'POST', url: `/api?token=${env.WEBHOOK_SECRET}`, headers: { 'content-type': 'application/json' },
    body: { version: '1.0', request: { type: 'SimpleUtterance', command: text }, session: {
      skill_id: 'skill', session_id: sessionId, message_id: messageId, application: { application_id: 'app' } } } };
}
async function invoke(handler, req) {
  const result = { headers: {}, status: 200 };
  await handler(req, { setHeader(k,v) { result.headers[k] = v; }, status(v) { result.status = v; return this; }, json(v) { result.body = v; } });
  return result;
}
function harness(fetcher, overrides = {}) {
  let time = 100000;
  let nextAllowed = 0;
  let reads = 0;
  const records = new Map();
  const tasks = [];
  const store = {
    async get(key) { reads++; return records.get(key) || null; },
    async reserve(keys, job) {
      const previous = records.get(keys.job);
      if (previous?.messageId === job.messageId) return -1;
      if (previous?.status === 'pending') return -2;
      if (time < nextAllowed) return nextAllowed - time;
      nextAllowed = time + 15000;
      records.set(keys.job, job);
      return 0;
    },
    async complete(key, job) { if (records.get(key)?.id === job.id) records.set(key, job); },
    ...overrides
  };
  const handler = createHandler({ env, fetcher, storeFactory: () => store, defer: p => tasks.push(p), now: () => time });
  return { handler, tasks, records, advance(ms) { time += ms; }, get reads() { return reads; } };
}

test('bounds text and history; detects fresh queries', () => {
  assert.ok(fitAliceText('Предложение. '.repeat(200)).length <= 1024);
  assert.ok(fitAliceText('Предложение. '.repeat(200)).endsWith('.'));
  assert.equal(safeHistory([{ role: 'system', text: 'ignore' }]).length, 0);
  assert.equal(safeHistory(Array.from({length: 12}, () => ({role:'user', text:'x'.repeat(4000)}))).length, 8);
  assert.equal(safeHistory([{role:'user',text:'x'.repeat(4000)}])[0].text.length, 1200);
  assert.equal(isSearchIntent('Какая погода сегодня?'), true);
  assert.equal(isSearchIntent('Расскажи сказку'), false);
});

test('health is liveness only; methods and configuration fail safely', async () => {
  const handler = createHandler({ env: {} });
  assert.equal((await invoke(handler, {method:'GET'})).body.service, 'alice-ollama-serper');
  assert.equal((await invoke(handler, {method:'DELETE'})).status, 405);
  assert.equal((await invoke(handler, request())).status, 503);
  assert.throws(() => configuration({...env, UPSTASH_REDIS_REST_URL:'https://attacker.example'}));
  assert.throws(() => configuration({...env, WEBHOOK_SECRET:'short'}));
});

test('rejects unauthorized, wrong skill, oversized or malformed bodies without storage/API calls', async () => {
  const h = harness(() => { throw new Error('unexpected network'); });
  const badSecret = request(); badSecret.url='/api?token=wrong';
  assert.equal((await invoke(h.handler, badSecret)).status, 403);
  const wrongSkill=request(); wrongSkill.body.session.skill_id='other';
  assert.equal((await invoke(h.handler, wrongSkill)).status, 400);
  const badType=request(); badType.headers['content-type']='text/plain';
  assert.equal((await invoke(h.handler, badType)).status, 415);
  const tooBig=request(); tooBig.body.padding='x'.repeat(33000);
  assert.equal((await invoke(h.handler, tooBig)).status, 413);
  assert.equal((await invoke(h.handler, request('x'.repeat(1201)))).status, 400);
  const greeting=await invoke(h.handler,request(''));
  assert.match(greeting.body.response.text,/Привет/);
  assert.equal(h.reads, 0); assert.equal(h.tasks.length, 0);
});

test('acknowledges before slow search/model; polling and duplicate deliveries never repeat inference', async () => {
  let releaseSearch;
  const gate=new Promise(resolve => { releaseSearch=resolve; });
  const calls=[];
  const h=harness(async (url, options) => {
    calls.push({url, body:JSON.parse(options.body), headers:options.headers});
    if (url.includes('serper')) { await gate; return json({organic:[{title:'Источник',snippet:'Сегодня ясно',link:'https://example.com'}]}); }
    return json({done:true, message:{content:'Сегодня ясно.',thinking:'SECRET REASONING'}});
  });
  const accepted=await invoke(h.handler,request('Какая погода сегодня?'));
  assert.match(accepted.body.response.text,/Вопрос принят/);
  assert.equal(calls.length,1);
  assert.match((await invoke(h.handler,request('ответ',2))).body.response.text,/ещё готовится/);
  await invoke(h.handler,request('Какая погода сегодня?'));
  assert.equal(h.tasks.length,1);
  releaseSearch(); await Promise.all(h.tasks);
  const answer=await invoke(h.handler,request('ответ',3));
  assert.equal(answer.body.response.text,'Сегодня ясно.');
  assert.equal(answer.body.session_state,undefined);
  assert.equal(calls.length,2);
  assert.equal(calls[1].url,'https://ollama.com/api/chat');
  assert.equal(calls[1].body.model,'kimi-k2.7-code');
  assert.equal(calls[1].body.stream,false);
  assert.equal(calls[1].headers.Authorization,'Bearer ollama-test');
  assert.equal(calls[1].body.messages.at(-1).role,'user');
  assert.equal(JSON.parse(calls[1].body.messages.at(-1).content).web_search.status,'available');
});

test('one global question per 15 seconds across sessions; rejected attempts do not extend cooldown', async () => {
  let calls=0;
  const h=harness(async () => { calls++; return json({done:true,message:{content:'Ответ'}}); });
  const results=await Promise.all([invoke(h.handler,request('Первый',1,'a')),invoke(h.handler,request('Второй',1,'b'))]);
  assert.equal(results.filter(x=>/Вопрос принят/.test(x.body.response.text)).length,1);
  await Promise.all(h.tasks);
  assert.equal(calls,1);
  h.advance(14999);
  assert.match((await invoke(h.handler,request('Второй',2,'b'))).body.response.text,/через 1 секунд/);
  h.advance(1);
  assert.match((await invoke(h.handler,request('Второй',3,'b'))).body.response.text,/Вопрос принят/);
  await Promise.all(h.tasks); assert.equal(calls,2);
});

test('storage outage fails closed before inference', async () => {
  for (const override of [{get:async()=>{throw Error();}}, {reserve:async()=>{throw Error();}}]) {
    const h=harness(()=>{throw Error('must not call');},override);
    assert.match((await invoke(h.handler,request())).body.response.text,/недоступен/);
    assert.equal(h.tasks.length,0);
  }
});

test('search failure is explicit context; provider errors and reasoning never leak', async () => {
  const search=await searchWeb(async()=>json({error:'private'},429),config,'погода');
  assert.deepEqual(search,{status:'unavailable'});
  for (const [status, message] of [[401,'ключа'],[429,'Лимит'],[404,'недоступна'],[500,'Не удалось']]) {
    const h=harness(async()=>json({error:'secret-credential'},status));
    await invoke(h.handler,request('Вопрос'));
    await Promise.all(h.tasks);
    const answer=(await invoke(h.handler,request('ответ',2))).body.response.text;
    assert.match(answer,new RegExp(message)); assert.doesNotMatch(answer,/secret-credential/);
  }
  await assert.rejects(askOllama(async()=>json({done:true,message:{thinking:'hidden',content:''}}),config,'x',[],{}));
  await assert.rejects(askOllama(async()=>json({done:true,done_reason:'length',message:{content:'partial'}}),config,'x',[],{}));
});

test('network timeout aborts and response size/malformed JSON are bounded', async () => {
  const fetcher=async (url,{signal,redirect}) => {
    assert.equal(redirect,'error');
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  };
  await assert.rejects(fetchJson(fetcher,'https://example.com',{},10),{name:'AbortError'});
  await assert.rejects(fetchJson(async()=>json({data:'x'.repeat(1000)}),'https://example.com',{},100,100),/RESPONSE_TOO_LARGE/);
  await assert.rejects(fetchJson(async()=>new Response('not JSON'),'https://example.com',{},100),/INVALID_RESPONSE/);
});

test('store uses atomic Redis scripts with 15 second cooldown and 180 second result TTL', async () => {
  const calls=[];
  const store=createStore(config,async(url,opts)=>{
    calls.push(JSON.parse(opts.body));
    return json({result:calls.length===1?null:calls.length===2?0:1});
  });
  assert.equal(await store.get('job'),null);
  const job={id:'test',messageId:1};
  assert.equal(await store.reserve({rate:'rate',job:'job'},job),0);
  await store.complete('job',job);
  assert.deepEqual(calls[1],['EVAL',RESERVE_SCRIPT,2,'rate','job',1,JSON.stringify(job),15,180]);
  assert.deepEqual(calls[2],['EVAL',COMPLETE_SCRIPT,1,'job','test',JSON.stringify(job),180]);
  const broken=createStore(config,async()=>json({error:'failure'}));
  await assert.rejects(broken.get('key'),/STORE_UNAVAILABLE/);
});

test('session keys bind application and session without exposing raw identifiers', () => {
  const a=keysFor(config,request().body.session);
  const b=keysFor(config,{...request().body.session,session_id:'other'});
  assert.equal(a.rate,b.rate); assert.notEqual(a.job,b.job);
  assert.doesNotMatch(a.job,/session|skill|app/);
});

test('Serper is allowed a full 5000 milliseconds before cancellation', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let signal;
  const work=searchWeb(async (url,opts)=>{
    signal=opts.signal;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  }, config, 'новости');
  t.mock.timers.tick(4999);
  assert.equal(signal.aborted,false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted,true);
  assert.deepEqual(await work,{status:'unavailable'});
});

test('history continues only within session; pending jobs cannot be replaced', async () => {
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const bodies=[];
  const h=harness(async (url,opts)=>{
    bodies.push(JSON.parse(opts.body));
    if(bodies.length===1) await gate;
    return json({done:true,message:{content:'Первый ответ'}});
  });
  await invoke(h.handler,request('Первый',1));
  h.advance(15000);
  assert.match((await invoke(h.handler,request('Второй',2))).body.response.text,/ещё обрабатывается/);
  assert.equal(h.tasks.length,1);
  release(); await Promise.all(h.tasks);
  await invoke(h.handler,request('Второй',3));
  await Promise.all(h.tasks);
  assert.equal(bodies[1].messages[1].role,'user');
  assert.equal(bodies[1].messages[1].content,'Первый');
  assert.equal(bodies[1].messages[2].role,'assistant');
  assert.equal(bodies[1].messages[2].content,'Первый ответ');
  await invoke(h.handler,request('Первый',1));
  assert.equal(h.tasks.length,2);
});
