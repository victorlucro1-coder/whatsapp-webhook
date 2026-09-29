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
  if (!r.ok) throw new Error('Remote HTTP '+r.status+': '+JSON.stringify(data).slice(0,300));
  return data;
}
async function answerMessage(msg) {
  if (msg.type !== 'text' || !msg.text?.body || !msg.from || !msg.id) return;
  if (!remember(msg.id)) return;
  const age = Date.now() - Number(msg.timestamp)*1000;
  if (!Number.isFinite(age) || age < -60000 || age > 23*60*60*1000) return;
  const from = msg.from;
  const previous = chains.get(from) || Promise.resolve();
  const task = previous.then(async () => {
    const history = memory.get(from) || [];
    const question = msg.text.body.slice(0,10000);
    const data = await jsonPost('https://api.openai.com/v1/chat/completions',
      {Authorization:'Bearer '+process.env.OPENAI_API_KEY},
      {model:process.env.OPENAI_MODEL || 'gpt-4.1-mini',
       messages:[{role:'system',content:process.env.SALES_AGENT_PROMPT},
         ...history,{role:'user',content:question}],
       max_tokens:300});
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error('The model returned no text');
    await jsonPost('https://graph.facebook.com/'+(process.env.GRAPH_API_VERSION || 'v23.0')+
      '/'+encodeURIComponent(process.env.WHATSAPP_PHONE_NUMBER_ID)+'/messages',
      {Authorization:'Bearer '+process.env.WHATSAPP_ACCESS_TOKEN},
      {messaging_product:'whatsapp',recipient_type:'individual',to:from,
        type:'text',text:{preview_url:false,body:reply.slice(0,4000)}});
    memory.delete(from);
    memory.set(from,[...history,{role:'user',content:question},
      {role:'assistant',content:reply}].slice(-16));
    if (memory.size > 500) memory.delete(memory.keys().next().value);
    console.log('Reply delivered for incoming message ID',msg.id);
  }).catch(e => console.error('Agent failed for message ID',msg.id,e.message));
  chains.set(from,task);
  void task.finally(() => {if (chains.get(from) === task) chains.delete(from);});
}
function processEvent(event) {
  for (const entry of event.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    if (value.metadata?.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID) continue;
    for (const msg of value.messages || []) void answerMessage(msg);
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
          configured:configured(),autoReply:process.env.AGENT_AUTO_REPLY==='true'});
      if (req.method==='GET' && url.pathname==='/webhook') {
        if (!process.env.VERIFY_TOKEN || url.searchParams.get('hub.mode')!=='subscribe' ||
            !secureEqual(url.searchParams.get('hub.verify_token'),process.env.VERIFY_TOKEN))
          return reply(403,{error:'verification'});
        res.writeHead(200,{'Content-Type':'text/plain'});
        return res.end(url.searchParams.get('hub.challenge') || '');
      }
      if (req.method!=='POST' || url.pathname!=='/webhook') return reply(404,{error:'not_found'});
      if (!configured() || process.env.AGENT_AUTO_REPLY!=='true')
        return reply(503,{error:'agent_not_enabled'});
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
      setImmediate(() => {try {processEvent(event);} catch(e) {console.error(e.message);}});
    } catch(e) {console.error('Webhook error',e.message);
      if (!res.headersSent) reply(400,{error:'bad_request'});
    }
  });
}
module.exports = {createDirectAgent};
