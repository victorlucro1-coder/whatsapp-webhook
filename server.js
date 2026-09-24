'use strict';
// Meta deliveries succeed only after the PC commits the signed event to SQLite.
const http = require('node:http');
const crypto = require('node:crypto');
function equal(a,b) {
  const x=Buffer.from(a||''), y=Buffer.from(b||'');
  return x.length===y.length && crypto.timingSafeEqual(x,y);
}
function createRelay({secret=process.env.META_APP_SECRET, token=process.env.RELAY_TOKEN,
  verify=process.env.VERIFY_TOKEN, deadlineMs=18000, maxBytes=16*1024*1024}={}) {
  const pending=new Map(); let bytes=0;
  const reply=(res,code,data)=>{
    if(res.destroyed || res.writableEnded) return;
    res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(data));
  };
  const finish=(id,code)=>{
    const item=pending.get(id); if(!item) return;
    pending.delete(id); bytes-=item.raw.length; clearTimeout(item.timer);
    for(const res of item.waiters) reply(res,code,{status:code===200?'stored_on_pc':'retry'});
  };
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET' && ['/', '/health'].includes(url.pathname))
        return reply(res,200,{status:'ok',version:'pc-relay-1'});
      if(url.pathname.startsWith('/relay/')) {
        if(!token || token.length<32) return reply(res,503,{error:'not_configured'});
        if(!equal(req.headers.authorization,'Bearer '+token)) return reply(res,401,{error:'unauthorized'});
      }
      if(req.method==='GET' && url.pathname==='/relay/events') {
        const events=[]; let batchBytes=0;
        for(const [id,item] of pending) {
          if(events.length>=10 || batchBytes+item.raw.length>4*1024*1024) break;
          events.push({id,body:item.raw.toString('base64'),signature:item.signature});
          batchBytes+=item.raw.length;
        }
        return reply(res,200,{events});
      }
      if(req.method==='GET' && url.pathname==='/webhook') {
        if(!verify || url.searchParams.get('hub.mode')!=='subscribe' || !equal(url.searchParams.get('hub.verify_token'),verify))
          return reply(res,403,{error:'verification'});
        res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});
        return res.end(url.searchParams.get('hub.challenge')||'');
      }
      if(req.method!=='POST' || !['/webhook','/relay/ack'].includes(url.pathname)) return reply(res,404,{error:'not_found'});
      const chunks=[]; let length=0;
      for await(const chunk of req) {
        length+=chunk.length;
        if(length>(url.pathname==='/relay/ack'?8192:4*1024*1024)) return reply(res,413,{error:'too_large'});
        chunks.push(chunk);
      }
      const raw=Buffer.concat(chunks);
      if(url.pathname==='/relay/ack') {
        const data=JSON.parse(raw);
        if(!Array.isArray(data.ids) || data.ids.length>10 || data.ids.some(id=>typeof id!=='string')) return reply(res,400,{error:'invalid_ack'});
        for(const id of data.ids) finish(id,200);
        return reply(res,200,{status:'acknowledged'});
      }
      if(!secret || !token || token.length<32) return reply(res,503,{error:'not_configured'});
      const signature=req.headers['x-hub-signature-256'];
      const expected='sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex');
      if(!equal(signature,expected)) return reply(res,401,{error:'invalid_signature'});
      const data=JSON.parse(raw);
      if(!data || data.object!=='whatsapp_business_account' || !Array.isArray(data.entry)) return reply(res,400,{error:'invalid_event'});
      const id=crypto.createHash('sha256').update(raw).digest('hex');
      if(pending.has(id)) {
        const item=pending.get(id);
        if(item.waiters.size>=5) return reply(res,503,{status:'retry'});
        item.waiters.add(res); return;
      }
      if(pending.size>=100 || bytes+raw.length>maxBytes) return reply(res,503,{status:'retry'});
      pending.set(id,{raw,signature,waiters:new Set([res]),timer:setTimeout(()=>finish(id,503),deadlineMs)});
      bytes+=raw.length;
    } catch { reply(res,400,{error:'invalid_request'}); }
  });
  server.requestTimeout=25000; server.headersTimeout=10000;
  server.on('close',()=>{for(const id of pending.keys()) finish(id,503);});
  return server;
}
module.exports={createRelay};
if(require.main===module) createRelay().listen(process.env.PORT||10000,'0.0.0.0',()=>console.log('PC relay started'));
