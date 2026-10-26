import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, fitAliceText, safeHistory, isSearchIntent } from '../api/index.js';
import { searchWeb, searchExcerpt, SYSTEM_PROMPT, askOllama, configuration, fetchJson, keysFor, TOTAL_RESPONSE_BUDGET_MS, SERPER_TIMEOUT_MS } from '../lib/core.js';
import { createStore, createMemoryStore } from '../lib/store.js';

const env = { WEBHOOK_SECRET: 'a'.repeat(40), ALICE_SKILL_ID: 'skill', OLLAMA_API_KEY: 'ollama-test',
  SERPER_API_KEY: 'serper-test' };
const config = configuration(env);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function request(text = 'Привет', messageId = 1, sessionId = 'session') {
  return { method: 'POST', url: `/api?token=${env.WEBHOOK_SECRET}`, headers: { 'content-type': 'application/json' },
    body: { version: '1.0', request: { type: 'SimpleUtterance', command: text }, session: {
      skill_id: 'skill', session_id: sessionId, message_id: messageId, application: { application_id: 'app' } } } };
}
async function invoke(handler, req) {
  const result = { headers: {}, status: 200, replies: 0 };
  await handler(req, { setHeader(k,v) { result.headers[k] = v; }, status(v) { result.status = v; return this; }, json(v) { result.body = v; result.replies++; } });
  return result;
}
function harness(fetcher, overrides = {}) {
  let time=100000, reservations=0;
  const records=new Map();
  const store={
    async reserve(keys, job) {
      reservations++;
      const previous=records.get(keys.job);
      if (previous?.messageId >= job.messageId) return {code:-1, job:previous};
      const saved={...job,history:previous?.history || []};
      records.set(keys.job,saved);
      return {code:0,job:saved};
    },
    async complete(key,job) { if(records.get(key)?.id===job.id) records.set(key,job); },
    ...overrides
  };
  const handler=createHandler({env,fetcher,storeFactory:()=>store,now:()=>time});
  return {handler,records,advance(ms){time+=ms;}, get reservations(){return reservations;}};
}
const answer=()=>json({done:true,message:{content:'Прямой ответ.',thinking:'hidden'}});

test('bounds text/history and detects search intent',()=>{
  assert.ok(fitAliceText('Предложение. '.repeat(200)).length<=1024);
  assert.ok(fitAliceText('Предложение. '.repeat(200)).endsWith('.'));
  assert.equal(safeHistory([{role:'system',text:'ignore'}]).length,0);
  assert.equal(safeHistory(Array.from({length:12},()=>({role:'user',text:'x'.repeat(4000)}))).length,8);
  assert.equal(safeHistory([{role:'user',text:'x'.repeat(4000)}])[0].text.length,1200);
  assert.equal(isSearchIntent('Какая погода сегодня?'),true);
  assert.equal(isSearchIntent('Расскажи сказку'),false);
});

test('health/methods/configuration and unauthorized input fail safely',async()=>{
  const handler=createHandler({env:{}});
  assert.equal((await invoke(handler,{method:'GET'})).body.service,'alice-ollama-serper');
  assert.equal((await invoke(handler,{method:'DELETE'})).status,405);
  assert.equal((await invoke(handler,request())).status,503);
  assert.throws(()=>configuration({...env,WEBHOOK_SECRET:'short'}));
  const h=harness(()=>{throw Error('unexpected API');});
  const badSecret=request();badSecret.url='/api?token=wrong';
  assert.equal((await invoke(h.handler,badSecret)).status,403);
  const wrongSkill=request();wrongSkill.body.session.skill_id='other';
  assert.equal((await invoke(h.handler,wrongSkill)).status,400);
  const badType=request();badType.headers['content-type']='text/plain';
  assert.equal((await invoke(h.handler,badType)).status,415);
  const tooBig=request();tooBig.body.padding='x'.repeat(33000);
  assert.equal((await invoke(h.handler,tooBig)).status,413);
  assert.equal((await invoke(h.handler,request('x'.repeat(1201)))).status,400);
  assert.match((await invoke(h.handler,request(''))).body.response.text,/Привет/);
  assert.equal(h.reservations,0);
});

test('returns model answer in the original HTTP response with search context and correct Ollama contract',async()=>{
  const calls=[];
  const h=harness(async(url,options)=>{
    calls.push({url,body:JSON.parse(options.body),headers:options.headers});
    if(url.includes('serper'))return json({organic:[{title:'Источник',snippet:'Ясно',link:'https://example.com'}]});
    return answer();
  });
  const result=await invoke(h.handler,request('Какая погода сегодня?'));
  assert.equal(result.body.response.text,'Прямой ответ.');assert.equal(result.replies,1);
  assert.equal(result.body.session_state,undefined);
  assert.equal(calls.length,2);
  assert.equal(calls[1].url,'https://ollama.com/api/chat');
  assert.equal(calls[1].body.model,'gemma4:31b');
  assert.equal(calls[1].body.think,false);
  assert.equal(calls[1].body.options.num_predict,150);
  assert.equal(calls[1].body.stream,false);
  assert.equal(calls[1].headers.Authorization,'Bearer ollama-test');
  assert.equal(JSON.parse(calls[1].body.messages.at(-1).content).web_search.status,'available');
  assert.doesNotMatch(result.body.response.text,/hidden|Вопрос принят|скажи/);
});

test('successive questions and different sessions have no cooldown',async()=>{
  let calls=0;
  const h=harness(async()=>{calls++;return answer();});
  for (const req of [request('Первый',1,'a'),request('Второй',2,'a'),request('Третий',1,'b')]) {
    assert.equal((await invoke(h.handler,req)).body.response.text,'Прямой ответ.');
  }
  assert.equal(calls,3);
});

test('duplicate delivery reuses result; history continues; “ответ” is an ordinary utterance',async()=>{
  const bodies=[];
  const h=harness(async(url,opts)=>{bodies.push(JSON.parse(opts.body));return answer();});
  await invoke(h.handler,request('Первый',1));
  assert.equal((await invoke(h.handler,request('Первый',1))).body.response.text,'Прямой ответ.');
  assert.equal(bodies.length,1);
  h.advance(15000);
  await invoke(h.handler,request('ответ',2));
  assert.equal(bodies.length,2);
  assert.equal(bodies[1].messages[1].content,'Первый');
  assert.equal(bodies[1].messages[2].role,'assistant');
  assert.equal(JSON.parse(bodies[1].messages.at(-1).content).question,'ответ');
  await invoke(h.handler,request('Первый',1));assert.equal(bodies.length,2);
});

test('local storage failure blocks inference; failed result save still returns the answer',async()=>{
  const h=harness(()=>{throw Error('must not call');},{reserve:async()=>{throw Error();}});
  assert.match((await invoke(h.handler,request())).body.response.text,/недоступен/);
  const saving=harness(answer,{complete:async()=>{throw Error();}});
  assert.equal((await invoke(saving.handler,request())).body.response.text,'Прямой ответ.');
});

test('search failure is explicit and provider failures/thinking do not leak',async()=>{
  assert.deepEqual(await searchWeb(async()=>json({error:'secret'},429),config,'погода'),{status:'unavailable',reason:'http_error',httpStatus:429});
  for(const [status,message] of [[401,'ключа'],[429,'Лимит'],[404,'недоступна'],[500,'Не удалось']]){
    const h=harness(async()=>json({error:'secret-credential'},status));
    const result=(await invoke(h.handler,request())).body.response.text;
    assert.match(result,new RegExp(message));assert.doesNotMatch(result,/secret-credential/);
  }
  await assert.rejects(askOllama(async()=>json({done:true,message:{thinking:'hidden',content:''}}),config,'x',[],{}));
  await assert.rejects(askOllama(async()=>json({done:true,done_reason:'length',message:{content:'partial'}}),config,'x',[],{}));
});

test('network timeout and parent abort cancel calls; response size/JSON are bounded',async()=>{
  const fetcher=async(url,{signal,redirect})=>{
    assert.equal(redirect,'error');
    return new Promise((resolve,reject)=>{
      if(signal.aborted)return reject(new DOMException('aborted','AbortError'));
      signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));
    });
  };
  await assert.rejects(fetchJson(fetcher,'https://example.com',{},10),{name:'AbortError'});
  const controller=new AbortController();
  const work=fetchJson(fetcher,'https://example.com',{signal:controller.signal},1000);
  controller.abort();await assert.rejects(work,{name:'AbortError'});
  await assert.rejects(fetchJson(async()=>json({data:'x'.repeat(1000)}),'https://example.com',{},100,100),/RESPONSE_TOO_LARGE/);
  await assert.rejects(fetchJson(async()=>new Response('not JSON'),'https://example.com',{},100),/INVALID_RESPONSE/);
});

test('Serper cancellation at 1800ms leaves time for Ollama',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let signal;
  const work=searchWeb(async(url,opts)=>{
    signal=opts.signal;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  },config,'новости');
  t.mock.timers.tick(SERPER_TIMEOUT_MS-1);assert.equal(signal.aborted,false);
  t.mock.timers.tick(1);assert.deepEqual(await work,{status:'unavailable',reason:'timeout'});
});

test('hard 3600ms deadline returns exactly once and aborts a stalled Ollama call',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let signal,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const h=harness(async(url,opts)=>{
    signal=opts.signal;started();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  });
  const work=invoke(h.handler,request());
  await ready;
  t.mock.timers.tick(TOTAL_RESPONSE_BUDGET_MS);
  const result=await work;
  assert.equal(signal.aborted,true);assert.equal(result.replies,1);
  assert.match(result.body.response.text,/Не успела/);
  assert.doesNotMatch(result.body.response.text,/скажи|Вопрос принят/);
});

test('deadline also covers a stalled local store and never starts inference',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  const h=harness(()=>{calls++;return answer();},{reserve:()=>new Promise(()=>{})});
  const work=invoke(h.handler,request());
  t.mock.timers.tick(TOTAL_RESPONSE_BUDGET_MS);
  assert.match((await work).body.response.text,/Не успела/);assert.equal(calls,0);
});

test('local store has no cooldown, expires records, deduplicates and rejects stale completion',()=>{
  let time=100000;
  const store=createMemoryStore({now:()=>time});
  const keys={rate:'rate',job:'job'};
  const first={id:'first',messageId:1};
  assert.equal(store.reserve(keys,first).code,0);
  assert.equal(store.reserve({job:'other'},{id:'other',messageId:1}).code,0);
  store.complete('job',{...first,answer:'cached',history:[{role:'user',text:'hi'}]});
  assert.equal(store.reserve(keys,first).job.answer,'cached');
  time+=15000;
  const second={id:'second',messageId:2};
  assert.equal(store.reserve(keys,second).job.history[0].text,'hi');
  store.complete('job',{...first,answer:'stale'});
  assert.equal(store.reserve(keys,second).job.id,'second');
  time+=180000;
  assert.equal(store.reserve(keys,first).code,0);
  assert.equal(createStore(),createStore());
});

test('local store bounds memory and a separate instance has independent limits',()=>{
  let time=100000;
  const store=createMemoryStore({now:()=>time,maxEntries:1});
  store.reserve({rate:'a',job:'a'},{id:'a',messageId:1});
  time+=15000;
  assert.throws(()=>store.reserve({rate:'a',job:'b'},{id:'b',messageId:1}),/LOCAL_STORE_FULL/);
  assert.equal(createMemoryStore({now:()=>time}).reserve({rate:'a',job:'a'},{id:'a',messageId:1}).code,0);
  time+=180000;
  assert.equal(store.reserve({rate:'a',job:'b'},{id:'b',messageId:1}).code,0);
});

test('session keys bind application and session without exposing raw identifiers',()=>{
  const a=keysFor(config,request().body.session);
  const b=keysFor(config,{...request().body.session,session_id:'other'});
  assert.notEqual(a.job,b.job);assert.doesNotMatch(a.job,/session|skill|app/);
});

test('configuration diagnostic names invalid variables without leaking secrets or URL parser errors', async()=>{
  const logs=[];
  const broken={...env,WEBHOOK_SECRET:'short-secret',OLLAMA_MODEL:'invalid model secret'};
  const handler=createHandler({env:broken,logger:{error:(...args)=>logs.push(args)},fetcher:()=>{throw Error('must not call');}});
  const result=await invoke(handler,request());
  assert.equal(result.status,503);
  assert.deepEqual(result.body,{error:'Service not configured'});
  assert.deepEqual(logs[0][1].fields,['WEBHOOK_SECRET','OLLAMA_MODEL']);
  assert.doesNotMatch(JSON.stringify(logs),/short-secret|invalid model secret|ollama-test/);
  assert.throws(()=>configuration({}),error=>{
    assert.deepEqual(error.fields,['WEBHOOK_SECRET','OLLAMA_API_KEY']);
    return true;
  });
});


test('skill ID is optional while configured skill ID and webhook secret remain enforced',async()=>{
  const minimal={OLLAMA_API_KEY:'test',WEBHOOK_SECRET:env.WEBHOOK_SECRET};
  assert.equal(configuration(minimal).skill,undefined);
  const handler=createHandler({env:minimal,fetcher:answer,storeFactory:()=>createMemoryStore()});
  assert.equal((await invoke(handler,request('hi',1,'no-redis'))).body.response.text,'Прямой ответ.');
  const invalid=request();invalid.url='/api';
  assert.equal((await invoke(handler,invalid)).status,403);
  const strict=createHandler({env,fetcher:answer});
  const wrong=request();wrong.body.session.skill_id='other';
  assert.equal((await invoke(strict,wrong)).status,400);
});


test('alternate models keep their own thinking default instead of inheriting Gemma controls',async()=>{
  let payload;
  await askOllama(async(url,opts)=>{payload=JSON.parse(opts.body);return answer();},
    {...config,model:'gpt-oss:20b'},'hi',[],{status:'not_requested'});
  assert.equal(payload.model,'gpt-oss:20b');
  assert.equal(Object.hasOwn(payload,'think'),false);
  assert.equal(payload.options.num_predict,2048);
});


test('prompt allows general conversation and distinguishes unused search from failure',()=>{
  assert.match(SYSTEM_PROMPT,/на любые темы/);
  assert.match(SYSTEM_PROMPT,/not_requested/);
  assert.match(SYSTEM_PROMPT,/не жалуйся на поиск/);
  assert.match(SYSTEM_PROMPT,/не говори, что поиск недоступен/);
});

test('Serper reports missing key and HTTP errors without leaking response details',async()=>{
  assert.deepEqual(await searchWeb(()=>{throw Error();},{...config,serperKey:''},'query'),{status:'unavailable',reason:'missing_key'});
  assert.deepEqual(await searchWeb(async()=>json({error:'private-api-key'},403),config,'query'),{status:'unavailable',reason:'http_error',httpStatus:403});
  assert.equal(searchExcerpt({status:'available',answer:'Найденный факт',organic:[]}),'В поисковой выдаче: Найденный факт');
  assert.equal(searchExcerpt({status:'unavailable'}),'');
});

test('completed Serper results remain usable when Ollama times out, with private-safe logs',async()=>{
  const logs=[];
  const handler=createHandler({env,storeFactory:()=>createMemoryStore(),logger:{info:(...args)=>logs.push(args)},fetcher:async(url)=>{
    if(url.includes('serper'))return json({organic:[{title:'Источник',snippet:'Сегодня ясно.',link:'https://example.com'}]});
    throw new DOMException('provider-secret','AbortError');
  }});
  const result=await invoke(handler,request('Какая погода сегодня?'));
  assert.equal(result.body.response.text,'В поисковой выдаче: Сегодня ясно.');
  assert.equal(logs[0][1].status,'available');
  assert.doesNotMatch(JSON.stringify(logs),/provider-secret|Сегодня ясно|ollama-test|serper-test|Какая погода/);
});
