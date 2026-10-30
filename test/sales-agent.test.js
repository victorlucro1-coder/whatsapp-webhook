'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {SalesStore}=require('../sales-store');
const {SalesEngine,configuration,createSalesAgent}=require('../sales-agent');
const {immediateAction,businessHours,nextBusinessTime,replyDelay,SYSTEM_PROMPT}=require('../sales-policy');

const PHONE='5511993680362',OPERATOR='5511888888888';
const START=Date.parse('2026-10-29T13:00:00Z');
function decision(extra={}){return {action:'reply',reason:'none',reply:'Oi, João! Aqui é o Francisco, da FV Anúncios. Posso colocar um anúncio da sua empresa para alcançar pessoas da sua região que precisam de instalação de ar-condicionado.',summary:'João tem uma empresa de instalação de ar-condicionado.',name:'João',company_type:'Instalação de ar-condicionado',city:'Recife',ad_experience:'primeira vez',followup_eligible:true,followup_5h:true,...extra};}
function fixture(overrides={},transportOverrides={},store){
  let time=START,seq=0;const sends=[],decisions=[],logs=[];
  const config={...configuration({}),phoneId:'phone-id',testPhone:PHONE,operator:OPERATOR,activated:START-1000,
    database:':memory:',persistent:false,followups:false,enabled:()=>true,ready:()=>true,
    env:{META_APP_SECRET:'test-only-secret',VERIFY_TOKEN:'test-verify'},...overrides};
  const transport={decide:async ctx=>{decisions.push(ctx);return {decision:decision(),responseId:'mock-ai'};},
    send:async(to,body)=>{sends.push({to,body});return 'mock-out-'+(++seq);},...transportOverrides};
  const engine=new SalesEngine({config,store:store||new SalesStore(),transport,now:()=>time,delay:()=>0,log:(stage,fields)=>logs.push({stage,...fields})});
  const msg=(id,body,from=PHONE,type='text')=>({id,from,type,timestamp:String(Math.floor(time/1000)),text:{body}});
  return {engine,config,sends,decisions,logs,msg,now:()=>time,advance:ms=>{time+=ms;},set:ms=>{time=ms;}};
}
async function reply(f){f.advance(5000);await f.engine.tick();await f.engine.tick();}
test('business facts and delay policy match approved offer',()=>{
  for(const term of ['R$ 400','R$ 200','R$ 350','R$ 100','2 a 3 dias','R$ 15 a R$ 20'])assert(SYSTEM_PROMPT.includes(term));
  assert.equal(replyDelay('Oi',()=>0),8000);assert.equal(replyDelay('Oi',()=>0.99999),15000);
  assert.equal(replyDelay('x'.repeat(221),()=>0),15000);assert.equal(replyDelay('x'.repeat(221),()=>0.99999),25000);
});
test('one grouped reply, isolated history, duplicate events and non-test contacts ignored',async()=>{
  const f=fixture();
  try{
    f.engine.ingest(f.msg('a','Oi, sou João'));
    f.advance(3000);f.engine.ingest(f.msg('b','Instalo ar-condicionado em Recife'));
    f.engine.ingest(f.msg('b','Instalo ar-condicionado em Recife'));
    f.engine.ingest(f.msg('other','Sou outro cliente','5511777777777'));
    await reply(f);
    assert.equal(f.decisions.length,1);assert.equal(f.sends.length,1);
    assert.deepEqual(f.decisions[0].history.map(x=>x.content),['Oi, sou João','Instalo ar-condicionado em Recife']);
    assert.equal(f.engine.store.conversation('5511777777777'),undefined);
    assert.equal(f.engine.store.conversation(PHONE).name,'João');
  }finally{await f.engine.close();}
});
test('a new inbound during model generation invalidates the old reply',async()=>{
  let release,calls=0;
  const f=fixture({}, {decide:async()=>{calls++;if(calls===1)await new Promise(resolve=>release=resolve);return {decision:decision()};}});
  try{
    f.engine.ingest(f.msg('a','Oi'));f.advance(5000);
    const processing=f.engine.tick();await Promise.resolve();
    f.engine.ingest(f.msg('b','Quero entender Google também'));release();await processing;
    assert.equal(f.sends.length,0);await reply(f);assert.equal(f.sends.length,1);assert.equal(calls,2);
  }finally{await f.engine.close();}
});
test('handoff triggers do not answer the lead or call AI; notification uses operator only',async()=>{
  for(const [text,reason] of [['Quero fechar','close'],['Me manda a chave Pix','payment'],['Pode mandar um áudio?','audio'],['Você é uma IA?','ai_question'],['Pode me ligar?','call']]){
    const f=fixture();
    try{
      f.engine.store.setMeta('operator_last_inbound',f.now());f.engine.ingest(f.msg('a',text));await f.engine.tick();
      assert.equal(f.decisions.length,0,text);assert.equal(f.sends.length,1,text);assert.equal(f.sends[0].to,OPERATOR);
      assert.equal(f.engine.store.conversation(PHONE).handoff_reason,reason);
      assert.equal(f.engine.store.conversation(PHONE).paused,1);
    }finally{await f.engine.close();}
  }
});
test('audio receipt pauses; questions about pricing/payment terms remain eligible for normal explanation',()=>{
  assert.equal(immediateAction({type:'audio'}).reason,'audio');
  assert.equal(immediateAction({type:'text',text:{body:'Qual o preço e como funciona o pagamento?'}}),null);
  assert.equal(immediateAction({type:'text',text:{body:'Não tenho interesse'}}).action,'opt_out');
});
test('opt-out cancels followups and operator resume does not override it',async()=>{
  const f=fixture({persistent:true,followups:true});
  try{
    f.engine.ingest(f.msg('a','Quero anunciar, pode me lembrar'));await reply(f);
    assert.equal(f.engine.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind LIKE 'followup%' AND state='pending'").get().n,2);
    f.engine.ingest(f.msg('b','Não tenho interesse'));
    f.engine.ingest(f.msg('cmd','#retomar '+PHONE,OPERATOR));
    assert.equal(f.engine.store.conversation(PHONE).opted_out,1);assert.equal(f.engine.store.conversation(PHONE).paused,1);
    assert.equal(f.engine.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind LIKE 'followup%' AND state='pending'").get().n,0);
  }finally{await f.engine.close();}
});
test('SQLite retains context, incoming dedup and jobs across restarts',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fv-agent-')),file=path.join(dir,'agent.sqlite');
  let f=fixture({}, {},new SalesStore(file));
  try{
    f.engine.ingest(f.msg('a','Sou João e instalo ar-condicionado'));await f.engine.close();
    f=fixture({}, {},new SalesStore(file));f.engine.ingest(f.msg('a','Sou João e instalo ar-condicionado'));await reply(f);
    assert.equal(f.engine.store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='received'").get().n,1);
    assert.equal(f.sends.length,1);assert.equal(f.engine.store.conversation(PHONE).name,'João');
    await f.engine.close();
    const reopened=new SalesStore(file);
    assert.equal(reopened.conversation(PHONE).name,'João');assert.equal(reopened.history(PHONE).length,2);reopened.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('send uncertainty is not retried, including after restart',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fv-uncertain-')),file=path.join(dir,'agent.sqlite');
  let f=fixture({}, {send:async()=>{const e=new Error('timeout');e.uncertain=true;throw e;}},new SalesStore(file));
  try{
    f.engine.ingest(f.msg('a','Quero saber mais'));await reply(f);
    assert.equal(f.engine.store.conversation(PHONE).paused,1);
    assert.equal(f.engine.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='uncertain'").get().n,1);
    await f.engine.close();f=fixture({}, {},new SalesStore(file));f.advance(60000);await f.engine.tick();
    assert.equal(f.sends.length,0);assert.equal(f.engine.store.conversation(PHONE).paused,1);
  }finally{await f.engine.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('business hours use Sao Paulo, skip weekends and do not permit followups outside customer window',async()=>{
  assert.equal(businessHours(Date.parse('2026-10-30T21:00:00Z')),false);
  assert.equal(nextBusinessTime(Date.parse('2026-10-30T21:00:00Z')),Date.parse('2026-11-02T12:00:00Z'));
  const f=fixture({persistent:true,followups:true});
  try{
    f.set(Date.parse('2026-10-30T20:30:00Z'));f.engine.ingest(f.msg('a','Quero anunciar, pode me lembrar'));await reply(f);
    const jobs=f.engine.store.db.prepare("SELECT due_at FROM jobs WHERE kind LIKE 'followup%' ORDER BY due_at").all();
    assert(jobs[1].due_at-jobs[0].due_at>=3600000);
    f.set(jobs[0].due_at);await f.engine.tick();assert.equal(f.sends.length,1);
    assert.equal(f.engine.store.db.prepare("SELECT state FROM jobs WHERE kind='followup_1h'").get().state,'skipped');
  }finally{await f.engine.close();}
});
test('first followup can send; 5h requires model justification and any inbound cancels pending followups',async()=>{
  let calls=0;const f=fixture({persistent:true,followups:true},{decide:async()=>({decision:decision(++calls===3?{action:'skip',reply:''}:{})})});
  try{
    f.engine.ingest(f.msg('a','Quero divulgar minha empresa, pode me chamar'));await reply(f);
    f.advance(3600000);await f.engine.tick();await f.engine.tick();assert.equal(f.sends.length,2);
    f.advance(4*3600000);await f.engine.tick();await f.engine.tick();assert.equal(f.sends.length,2);
    assert.equal(f.engine.store.db.prepare("SELECT state FROM jobs WHERE kind='followup_5h'").get().state,'skipped');
    f.engine.ingest(f.msg('b','Outra dúvida'));assert.equal(f.engine.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind LIKE 'followup%' AND state='pending'").get().n,0);
  }finally{await f.engine.close();}
});
test('free temporary pilot cannot activate followups; late operator notification waits for operator window',async()=>{
  const f=fixture({persistent:false,followups:true});
  try{
    f.engine.ingest(f.msg('a','Quero anunciar'));await reply(f);
    assert.equal(f.engine.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind LIKE 'followup%'").get().n,0);
    f.engine.ingest(f.msg('b','Quero fechar'));await f.engine.tick();assert.equal(f.sends.length,1);
    f.engine.ingest(f.msg('cmd','#fila',OPERATOR));f.advance(60000);await f.engine.tick();await f.engine.tick();
    assert(f.sends.slice(1).every(x=>x.to===OPERATOR));
  }finally{await f.engine.close();}
});
test('bad model output pauses safely without sending fabricated pricing/identity claims',async()=>{
  const f=fixture({}, {decide:async()=>({decision:decision({reply:'Não sou uma IA, garanto lucro.'})})});
  try{f.engine.ingest(f.msg('a','Olá'));await reply(f);assert.equal(f.sends.length,0);assert.equal(f.engine.store.conversation(PHONE).paused,1);}
  finally{await f.engine.close();}
});
test('no followup is scheduled without customer permission even with durable storage',async()=>{
  const f=fixture({persistent:true,followups:true});
  try{f.engine.ingest(f.msg('a','Quero anunciar'));await reply(f);
    assert.equal(f.engine.store.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind LIKE 'followup%'").get().n,0);
  }finally{await f.engine.close();}
});
test('operator resume accepts a human summary, while a customer cannot operate the queue',async()=>{
  const f=fixture();
  try{
    f.engine.ingest(f.msg('a','Quero fechar'));assert.equal(f.engine.store.conversation(PHONE).paused,1);
    f.engine.ingest(f.msg('not-op','#retomar '+PHONE));assert.equal(f.engine.store.conversation(PHONE).paused,1);
    f.engine.ingest(f.msg('op','#retomar '+PHONE+' | Combinei começar em novembro.',OPERATOR));
    assert.equal(f.engine.store.conversation(PHONE).paused,0);assert.match(f.engine.store.conversation(PHONE).summary,/novembro/);
    assert.equal(f.decisions.length,0);
  }finally{await f.engine.close();}
});
test('a crash while sending is recovered as uncertain and cannot produce a repeated reply',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fv-crash-')),file=path.join(dir,'agent.sqlite');
  let f=fixture({}, {},new SalesStore(file));
  try{
    f.engine.ingest(f.msg('a','Olá'));const job=f.engine.store.db.prepare("SELECT id FROM jobs WHERE kind='reply'").get();
    f.engine.store.finish(job.id,'sending');await f.engine.close();
    f=fixture({}, {},new SalesStore(file));f.advance(60000);await f.engine.tick();
    assert.equal(f.sends.length,0);assert.equal(f.engine.store.jobState(job.id),'uncertain');
    assert.equal(f.engine.store.conversation(PHONE).paused,1);
  }finally{await f.engine.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('delivery status is recorded without regressing from delivered to sent',async()=>{
  const f=fixture();
  try{f.engine.ingest(f.msg('a','Olá'));await reply(f);
    const value={metadata:{phone_number_id:'phone-id'},statuses:[{id:'mock-out-1',status:'delivered',timestamp:String(Math.floor(f.now()/1000))}]};
    f.engine.ingestEvent({entry:[{changes:[{value}]}]});value.statuses[0].status='sent';f.engine.ingestEvent({entry:[{changes:[{value}]}]});
    assert.equal(f.engine.store.db.prepare("SELECT status FROM messages WHERE id='mock-out-1'").get().status,'delivered');
    assert(f.logs.some(x=>x.stage==='whatsapp_status'&&x.status==='delivered'&&Number.isFinite(x.delivery_ms)));
  }finally{await f.engine.close();}
});
test('global pause prevents both model calls and outgoing messages',async()=>{
  const f=fixture({enabled:()=>false});
  try{f.engine.ingest(f.msg('a','Olá'));await reply(f);assert.equal(f.decisions.length,0);assert.equal(f.sends.length,0);}
  finally{await f.engine.close();}
});
test('webhook validates signatures, hides the queue and persists before acknowledgement',async()=>{
  const f=fixture();const server=createSalesAgent({config:f.config,engine:f.engine});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    const body=JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'phone-id'},messages:[f.msg('http-msg','Olá')]}}]}]});
    let r=await fetch(base+'/webhook',{method:'POST',body});assert.equal(r.status,401);
    const signature='sha256='+crypto.createHmac('sha256',f.config.env.META_APP_SECRET).update(body).digest('hex');
    r=await fetch(base+'/webhook',{method:'POST',body,headers:{'x-hub-signature-256':signature}});assert.equal(r.status,200);
    assert.equal(f.engine.store.history(PHONE).length,1);assert.equal(f.sends.length,0);
    r=await fetch(base+'/agent/handoffs');assert.equal(r.status,401);
    r=await fetch(base+'/health');const h=await r.json();assert.equal(h.testOnly,true);assert.equal(h.followups,false);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
