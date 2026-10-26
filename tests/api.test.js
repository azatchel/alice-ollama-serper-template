import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, fitAliceText, safeHistory, isSearchIntent } from '../api/index.js';
import { searchWeb, askOllama, configuration, fetchJson, keysFor, TOTAL_RESPONSE_BUDGET_MS, SERPER_TIMEOUT_MS } from '../lib/core.js';
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
  const result = { headers: {}, status: 200, replies: 0 };
  await handler(req, { setHeader(k,v) { result.headers[k] = v; }, status(v) { result.status = v; return this; }, json(v) { result.body = v; result.replies++; } });
  return result;
}
function harness(fetcher, overrides = {}) {
  let time=100000, nextAllowed=0, reservations=0;
  const records=new Map();
  const store={
    async reserve(keys, job) {
      reservations++;
      const previous=records.get(keys.job);
      if (previous?.messageId >= job.messageId) return {code:-1, job:previous};
      if (time < nextAllowed) return {code:nextAllowed-time};
      nextAllowed=time+15000;
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
  assert.throws(()=>configuration({...env,UPSTASH_REDIS_REST_URL:'https://attacker.example'}));
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
  assert.equal(calls[1].body.model,'kimi-k2.7-code');
  assert.equal(calls[1].body.stream,false);
  assert.equal(calls[1].headers.Authorization,'Bearer ollama-test');
  assert.equal(JSON.parse(calls[1].body.messages.at(-1).content).web_search.status,'available');
  assert.doesNotMatch(result.body.response.text,/hidden|Вопрос принят|скажи/);
});

test('global 15-second limit across sessions; rejected attempts do not extend cooldown',async()=>{
  let calls=0;
  const h=harness(async()=>{calls++;return answer();});
  const results=await Promise.all([invoke(h.handler,request('Первый',1,'a')),invoke(h.handler,request('Второй',1,'b'))]);
  assert.equal(results.filter(x=>x.body.response.text==='Прямой ответ.').length,1);assert.equal(calls,1);
  h.advance(14999);
  assert.match((await invoke(h.handler,request('Второй',2,'b'))).body.response.text,/через 1 секунд/);
  h.advance(1);
  assert.equal((await invoke(h.handler,request('Второй',3,'b'))).body.response.text,'Прямой ответ.');assert.equal(calls,2);
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

test('storage outage blocks inference; failed result save still returns the answer',async()=>{
  const h=harness(()=>{throw Error('must not call');},{reserve:async()=>{throw Error();}});
  assert.match((await invoke(h.handler,request())).body.response.text,/недоступен/);
  const saving=harness(answer,{complete:async()=>{throw Error();}});
  assert.equal((await invoke(saving.handler,request())).body.response.text,'Прямой ответ.');
});

test('search failure is explicit and provider failures/thinking do not leak',async()=>{
  assert.deepEqual(await searchWeb(async()=>json({error:'secret'},429),config,'погода'),{status:'unavailable'});
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

test('Serper cancellation at 600ms leaves time for Ollama',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let signal;
  const work=searchWeb(async(url,opts)=>{
    signal=opts.signal;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
  },config,'новости');
  t.mock.timers.tick(SERPER_TIMEOUT_MS-1);assert.equal(signal.aborted,false);
  t.mock.timers.tick(1);assert.deepEqual(await work,{status:'unavailable'});
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

test('deadline also covers a stalled rate-limit backend and never starts inference',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let calls=0;
  const h=harness(()=>{calls++;return answer();},{reserve:()=>new Promise(()=>{})});
  const work=invoke(h.handler,request());
  t.mock.timers.tick(TOTAL_RESPONSE_BUDGET_MS);
  assert.match((await work).body.response.text,/Не успела/);assert.equal(calls,0);
});

test('atomic Redis contract loads history and limits in one call, completion uses CAS',async()=>{
  const calls=[];const job={id:'test',messageId:1,history:[]};
  const store=createStore(config,async(url,opts)=>{
    calls.push(JSON.parse(opts.body));
    return json({result:calls.length===1?[0,JSON.stringify(job)]:1});
  });
  assert.deepEqual(await store.reserve({rate:'rate',job:'job'},job),{code:0,job});
  await store.complete('job',job);
  assert.deepEqual(calls[0],['EVAL',RESERVE_SCRIPT,2,'rate','job',1,JSON.stringify(job),15,180]);
  assert.deepEqual(calls[1],['EVAL',COMPLETE_SCRIPT,1,'job','test',JSON.stringify(job),180]);
  const broken=createStore(config,async()=>json({error:'failure'}));
  await assert.rejects(broken.reserve({rate:'rate',job:'job'},job),/STORE_UNAVAILABLE/);
  const malformed=createStore(config,async()=>json({result:0}));
  await assert.rejects(malformed.reserve({rate:'rate',job:'job'},job),/STORE_UNAVAILABLE/);
});

test('session keys bind application and session without exposing raw identifiers',()=>{
  const a=keysFor(config,request().body.session);
  const b=keysFor(config,{...request().body.session,session_id:'other'});
  assert.equal(a.rate,b.rate);assert.notEqual(a.job,b.job);assert.doesNotMatch(a.job,/session|skill|app/);
});
