'use strict';
// Minimal opt-in WhatsApp Cloud API -> OpenAI -> WhatsApp flow.
// History lives only in RAM. This is for pilot use, not durable production storage.
const http = require('node:http');
const crypto = require('node:crypto');

function secureEqual(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const memory = new Map(), chains = new Map(), seen = new Set();
const receipts = new Map();
function audit(stage, fields={}) {
  console.log(JSON.stringify({stage,at:new Date().toISOString(),...fields}));
}
function allowed(from) {
  const number = process.env.AGENT_TEST_PHONE || '';
  return /^\d{10,15}$/.test(number) && from === number;
}
function remember(id) {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
  return true;
}
function configured() {
  return ['META_APP_SECRET','VERIFY_TOKEN','WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID',
    'OPENAI_API_KEY','SALES_AGENT_PROMPT'].every(k => Boolean(process.env[k]));
}
async function jsonPost(url, headers, body) {
  const r = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json',...headers},
    body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Remote HTTP '+r.status+' code='+String(data.error?.code || 'unknown').replace(/[^a-zA-Z0-9_]/g,''));
  return data;
}
async function answerMessage(msg, receivedAt=Date.now()) {
  if (msg.type !== 'text' || !msg.text?.body || !msg.from || !msg.id) return;
  if (!allowed(msg.from) || process.env.AGENT_AUTO_REPLY!=='true' || !configured()) return;
  if (!remember(msg.id)) return;
  const age = Date.now() - Number(msg.timestamp)*1000;
  const activated = Number(process.env.AGENT_TEST_STARTED_AT);
  if (!activated || Number(msg.timestamp)*1000 < activated || !Number.isFinite(age) || age < -60000 || age > 10*60*1000) return;
  audit('message_received',{incoming_id:msg.id,received_at:new Date(receivedAt).toISOString()});
  const from = msg.from;
  const previous = chains.get(from) || Promise.resolve();
  const task = previous.then(async () => {
    const history = memory.get(from) || [];
    const question = msg.text.body.slice(0,10000);
    const aiStart = Date.now();
    audit('openai_started',{incoming_id:msg.id});
    const data = await jsonPost('https://api.openai.com/v1/chat/completions',
      {Authorization:'Bearer '+process.env.OPENAI_API_KEY},
      {model:process.env.OPENAI_MODEL || 'gpt-4.1-mini',
       messages:[{role:'system',content:process.env.SALES_AGENT_PROMPT},
         ...history,{role:'user',content:question}],
       store:false,max_tokens:300});
    const aiMs=Date.now()-aiStart;
    audit('openai_completed',{incoming_id:msg.id,openai_ms:aiMs,response_id:data.id});
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error('The model returned no text');
    const sent = await jsonPost('https://graph.facebook.com/'+(process.env.GRAPH_API_VERSION || 'v23.0')+
      '/'+encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)+'/messages',
      {Authorization:'Bearer '+process.env.WHATSAPP_ACCESS_TOKEN},
      {messaging_product:'whatsapp',recipient_type:'individual',to:from,
        type:'text',text:{preview_url:false,body:reply.slice(0,4000)}});
    memory.delete(from);
    memory.set(from,[...history,{role:'user',content:question},
      {role:'assistant',content:reply}].slice(-16));
    if (memory.size > 500) memory.delete(memory.keys().next().value);
    const outgoing=sent.messages?.[0]?.id;
    if (!outgoing) throw new Error('Meta returned no message ID');
    receipts.set(outgoing,{incoming_id:msg.id,receivedAt,openai_ms:aiMs});
    if(receipts.size>1000) receipts.delete(receipts.keys().next().value);
    audit('whatsapp_accepted',{incoming_id:msg.id,outgoing_id:outgoing,processing_ms:Date.now()-receivedAt});
  }).catch(e => audit('processing_failed',{incoming_id:msg.id,error:e.message}));
  chains.set(from,task);
  void task.finally(() => {if (chains.get(from) === task) chains.delete(from);});
}
function processEvent(event,receivedAt) {
  for (const entry of event.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    if (value.metadata?.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID) continue;
    for (const status of value.statuses || []) {
      const receipt=receipts.get(status.id);
      if(receipt) audit('whatsapp_status',{incoming_id:receipt.incoming_id,outgoing_id:status.id,status:status.status,
        provider_timestamp:status.timestamp,openai_ms:receipt.openai_ms,
        delivery_ms:status.status==='delivered'?Number(status.timestamp)*1000-receipt.receivedAt:undefined,
        status_observed_ms:Date.now()-receipt.receivedAt,error_codes:status.errors?.map(e=>e.code)});
    }
    for (const msg of value.messages || []) void answerMessage(msg,receivedAt);
  }
}
function createDirectAgent({publicPages={},publicPage}={}) {
  return http.createServer(async (req,res) => {
    function reply(status,payload) {
      res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(payload));
    }
    try {
      const url = new URL(req.url,'http://localhost');
      if (['GET','HEAD'].includes(req.method) && Object.hasOwn(publicPages,url.pathname)) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});
        return res.end(req.method==='HEAD'?'':publicPage(...publicPages[url.pathname]));
      }
      if (req.method==='GET' && ['/', '/health'].includes(url.pathname))
        return reply(200,{status:'ok',mode:'direct-agent',
          version:'direct-test-1',configured:configured(),autoReply:process.env.AGENT_AUTO_REPLY==='true',
          testOnly:true,testNumberConfigured:allowed(process.env.AGENT_TEST_PHONE)});
      if (req.method==='GET' && url.pathname==='/webhook') {
        if (!process.env.VERIFY_TOKEN || url.searchParams.get('hub.mode')!=='subscribe' ||
            !secureEqual(url.searchParams.get('hub.verify_token'),process.env.VERIFY_TOKEN))
          return reply(403,{error:'verification'});
        res.writeHead(200,{'Content-Type':'text/plain'});
        return res.end(url.searchParams.get('hub.challenge') || '');
      }
      if (req.method!=='POST' || url.pathname!=='/webhook') return reply(404,{error:'not_found'});
      if (!process.env.META_APP_SECRET) return reply(503,{error:'missing_signature_secret'});
      const receivedAt=Date.now();
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024*1024) return reply(413,{error:'too_large'});
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const expected = 'sha256='+crypto.createHmac('sha256',process.env.META_APP_SECRET)
        .update(raw).digest('hex');
      if (!secureEqual(req.headers['x-hub-signature-256'],expected))
        return reply(401,{error:'invalid_signature'});
      const event = JSON.parse(raw);
      if (event.object!=='whatsapp_business_account' || !Array.isArray(event.entry))
        return reply(400,{error:'invalid_event'});
      reply(200,{status:'received'});
      setImmediate(() => {try {processEvent(event,receivedAt);} catch(e) {audit('event_error',{error:e.name});}});
    } catch(e) {console.error('Webhook error',e.message);
      if (!res.headersSent) reply(400,{error:'bad_request'});
    }
  });
}
module.exports = {createDirectAgent};
