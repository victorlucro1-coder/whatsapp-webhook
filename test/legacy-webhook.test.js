const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createDirectAgent}=require('../direct-agent');
test('signed webhook: allowlist, real API stages mocked, delivery, duplicate and disabled guards',async()=>{
 Object.assign(process.env,{META_APP_SECRET:'test-secret',VERIFY_TOKEN:'verify',WHATSAPP_ACCESS_TOKEN:'fake',WHATSAPP_PHONE_NUMBER_ID:'123',OPENAI_API_KEY:'fake',SALES_AGENT_PROMPT:'test',AGENT_AUTO_REPLY:'true',AGENT_TEST_PHONE:'5511999999999',AGENT_TEST_STARTED_AT:String(Date.now()-5000)});
 const originalFetch=global.fetch,originalLog=console.log,calls=[],logs=[];
 global.fetch=async(url,options)=>{
  if(String(url).startsWith('http://127.0.0.1')) return originalFetch(url,options);
  calls.push({url,body:JSON.parse(options.body)});
  return {ok:true,json:async()=>String(url).includes('openai')?{id:'completion-test',choices:[{message:{content:'Teste: olá'}}]}:{messages:[{id:'out-test'}]}};
 };
 console.log=x=>logs.push(JSON.parse(x));
 const server=createDirectAgent(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port+'/webhook';
 const event=(id,from='5511999999999')=>({object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'123'},messages:[{id,from,type:'text',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'olá'}}]}}]}]});
 async function send(e,signed=true){const body=JSON.stringify(e);return fetch(url,{method:'POST',body,headers:{'x-hub-signature-256':signed?'sha256='+crypto.createHmac('sha256','test-secret').update(body).digest('hex'):'bad'}});}
 try{
  assert.equal((await send(event('invalid'),false)).status,401);
  await send(event('other','5511888888888')); await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,0);
  await send(event('incoming')); await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,2);
  assert.equal(calls[0].body.messages.at(-1).content,'olá');assert.equal(calls[1].body.to,'5511999999999');assert.equal(calls[0].body.store,false);
  await send(event('incoming'));await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,2);
  const status=event('unused');status.entry[0].changes[0].value.messages=[];status.entry[0].changes[0].value.statuses=[{id:'out-test',status:'delivered',timestamp:String(Math.floor(Date.now()/1000)+1)}];
  await send(status);await new Promise(r=>setTimeout(r,30));assert.ok(logs.some(l=>l.stage==='whatsapp_status'&&l.status==='delivered'));
  process.env.AGENT_AUTO_REPLY='false';await send(event('disabled'));await new Promise(r=>setTimeout(r,30));assert.equal(calls.length,2);
  assert.ok(!JSON.stringify(logs).includes('test-secret'));
 }finally{global.fetch=originalFetch;console.log=originalLog;await new Promise(r=>server.close(r));}
});
