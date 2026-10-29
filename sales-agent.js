'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {SalesStore}=require('./sales-store');
const {SYSTEM_PROMPT,SCHEMA,immediateAction,businessHours,nextBusinessTime,replyDelay,validateDecision}=require('./sales-policy');
function normalized(t){return t.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}

function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function audit(stage,fields={}){console.log(JSON.stringify({stage,at:new Date().toISOString(),...fields}));}
const REASONS={close:'Quer fechar a contratação',payment:'Pediu informações para pagar',audio:'Pediu ou enviou áudio',call:'Pediu ligação',
  ai_question:'Perguntou sobre atendimento automático',human:'Pediu atendimento pessoal',other:'Precisa da sua avaliação',none:'Pediu para encerrar o contato',
  delivery_failed:'A Meta informou falha de entrega',model_failed:'Não foi possível preparar uma resposta segura',reply_expired:'A resposta ficou pendente por tempo demais',
  consumption_limit:'Foi atingido o limite de uso do piloto',uncertain_send:'Não foi possível confirmar o envio anterior',send_failed:'Não foi possível enviar a resposta',operator:'Pausa solicitada por você'};
function configuration(env=process.env){
  return {
    phoneId:env.WHATSAPP_PHONE_NUMBER_ID,testPhone:env.AGENT_TEST_PHONE,operator:env.AGENT_OPERATOR_PHONE,
    activated:Number(env.AGENT_TEST_STARTED_AT),database:env.AGENT_DATABASE_PATH||':memory:',
    persistent:env.AGENT_PERSISTENT_STORAGE==='true'&&Boolean(env.AGENT_DATABASE_PATH)&&env.AGENT_DATABASE_PATH!==':memory:',
    followups:env.AGENT_FOLLOWUPS==='true', model:env.OPENAI_MODEL||'gpt-4.1-mini',
    enabled:()=>env.AGENT_AUTO_REPLY==='true',ready:()=>['META_APP_SECRET','VERIFY_TOKEN','WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','OPENAI_API_KEY','AGENT_TEST_PHONE','AGENT_OPERATOR_PHONE']
      .every(k=>Boolean(env[k]))&&/^\d{10,15}$/.test(env.AGENT_TEST_PHONE)&&/^\d{10,15}$/.test(env.AGENT_OPERATOR_PHONE),
    env
  };
}
async function post(url,token,body) {
  let r;
  try {r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});}
  catch {const e=new Error('remote_send_uncertain');e.uncertain=true;throw e;}
  const data=await r.json().catch(()=>null);
  if(!r.ok){const e=new Error(`remote_http_${r.status}_code_${String(data?.error?.code||'unknown').replace(/[^\w]/g,'')}`);e.uncertain=r.status>=500;throw e;}
  if(!data){const e=new Error('remote_response_uncertain');e.uncertain=true;throw e;}
  return data;
}
function liveTransport(config){
  return {
    async decide(context){
      const data=await post('https://api.openai.com/v1/chat/completions',config.env.OPENAI_API_KEY,{
        model:config.model,store:false,max_tokens:1000,
        response_format:{type:'json_schema',json_schema:{name:'fv_sales_decision',strict:true,schema:SCHEMA}},
        messages:[{role:'system',content:SYSTEM_PROMPT},
          {role:'user',content:JSON.stringify({task:context.task,followups_enabled:context.followups_enabled,contact_facts:context.facts,summary_untrusted:context.summary})},...context.history]
      });
      const choice=data.choices?.[0];
      if(choice?.finish_reason!=='stop'||choice.message?.refusal)throw new Error('model_incomplete_or_refused');
      return {decision:JSON.parse(choice.message.content),responseId:data.id};
    },
    async send(to,body){
      const data=await post(`https://graph.facebook.com/${config.env.GRAPH_API_VERSION||'v23.0'}/${encodeURIComponent(config.phoneId)}/messages`,
        config.env.WHATSAPP_ACCESS_TOKEN,{messaging_product:'whatsapp',recipient_type:'individual',to,type:'text',text:{preview_url:false,body}});
      const id=data.messages?.[0]?.id;
      if(!id){const e=new Error('missing_message_id');e.uncertain=true;throw e;}
      return id;
    }
  };
}

class SalesEngine {
  constructor({config=configuration(),store=new SalesStore(config.database),transport=liveTransport(config),now=Date.now,delay=replyDelay,log=audit}={}){
    Object.assign(this,{config,store,transport,now,delay,log});this.running=new Set();this.pending=new Set();
    if(config.followups&&!config.persistent) this.log('followups_disabled',{reason:'persistent_storage_required'});
    for(const c of store.queue())if(c.handoff_reason==='uncertain_send')this.notify(c.phone,store.conversation(c.phone).revision,'uncertain_send');
  }
  allowed(phone){return /^\d{10,15}$/.test(this.config.testPhone||'')&&phone===this.config.testPhone;}
  openWindow(c){return c?.last_inbound_at>this.now()-86400000&&c.last_inbound_at<=this.now()+60000;}
  notify(phone,revision,reason,body){
    this.store.job(phone,revision,'notify',this.now(),{reason,body:body||`AVISO PARA FRANCISCO\nContato: ${phone}\nMotivo: ${REASONS[reason]||'Precisa da sua avaliação'}\nAtendimento automático pausado nessa conversa. Para devolver ao agente: #retomar ${phone}`},this.now());
  }
  handoff(phone,reason,optOut=false){
    const c=this.store.conversation(phone);
    this.store.pause(phone,reason,optOut);
    if(!c?.paused)this.notify(phone,c?.revision||0,reason);
    this.log('human_handoff',{reason});
  }
  command(msg){
    if(msg.from!==this.config.operator||msg.type!=='text')return false;
    const t=msg.text.body.trim();
    const match=/^#(pausar|retomar)\s+(\d{10,15})(?:\s*\|\s*(.{1,1000}))?$/i.exec(t);
    if(t.toLowerCase()!=='#fila'&&!match)return false;
    if(!this.store.see(msg.id,this.now()))return true;
    let body;
    if(match){
      const phone=match[2];
      if(!this.allowed(phone))body='Este piloto só permite operar o número de teste autorizado.';
      else if(!this.store.conversation(phone))body='Não há conversa registrada para esse número.';
      else if(match[1].toLowerCase()==='pausar'){this.store.pause(phone,'operator');body='Conversa pausada. Nenhum follow-up será enviado.';}
      else {
        if(match[3])this.store.db.prepare('UPDATE conversations SET summary=? WHERE phone=? AND opted_out=0')
          .run(('Resumo informado por Francisco após atendimento humano: '+match[3]).slice(0,1200),phone);
        const c=this.store.resume(phone);
        body=c.opted_out?'O contato pediu interrupção. O agente permanece pausado.':'Conversa devolvida ao agente. Aguarde uma nova mensagem do lead.';
      }
    } else {
      const rows=this.store.queue();
      body=rows.length?'Pendências:\n'+rows.map(r=>`${r.phone}: ${REASONS[r.handoff_reason]||'Precisa da sua avaliação'}`).join('\n'):'Nenhuma conversa aguardando atendimento humano.';
    }
    this.store.ensure(msg.from);
    const revision=Number(this.store.getMeta('command_sequence')||0)+1;
    this.store.setMeta('command_sequence',revision);
    this.notify(msg.from,-revision,'operator_command',body);
    return true;
  }
  ingest(msg,receivedAt=this.now()){
    if(!msg?.id||!msg.from||!msg.type)return;
    if(msg.from!==this.config.operator&&!this.allowed(msg.from))return;
    const at=Number(msg.timestamp)*1000,age=this.now()-at;
    if(!Number.isFinite(age)||age< -60000||age>600000||!this.config.activated||at<this.config.activated)return;
    if(msg.type==='text'&&(typeof msg.text?.body!=='string'||!msg.text.body.trim()))return;
    if(msg.from===this.config.operator)this.store.setMeta('operator_last_inbound',at);
    if(this.command(msg))return;
    if(!this.allowed(msg.from)||!this.config.enabled()||!this.config.ready())return;
    const c=this.store.receive(msg,receivedAt);
    if(!c)return;
    if(msg.type==='text'){
      const t=normalized(msg.text.body),history=this.store.history(msg.from);
      const previous=history.at(-2);
      const revoked=/\bnao.{0,25}(?:chamar|lembrar|avisar|retomar|retornar|entrar em contato)\b/.test(t);
      if(revoked)this.store.setMeta('followup_permission:'+msg.from,'');
      if(!revoked&&(/\b(pode me (?:chamar|lembrar|avisar)|me (?:chama|lembra|avisa)|pode (?:retomar|retornar|entrar em contato))\b/.test(t)||
        (/^(sim|pode|pode sim|claro)[.! ]*$/.test(t)&&previous?.role==='assistant'&&/posso.{0,40}(?:chamar|retomar|lembrar)/.test(normalized(previous.content))))
        )this.store.permitFollowup(msg.from,msg.id);
    }
    this.log('message_received',{incoming_id:msg.id,received_at:new Date(receivedAt).toISOString()});
    if(c.paused||c.opted_out)return;
    const action=immediateAction(msg);
    if(action){this.handoff(msg.from,action.reason,action.action==='opt_out');return;}
    this.store.job(msg.from,c.revision,'reply',this.now()+5000,{incoming_id:msg.id,receivedAt},this.now());
  }
  ingestEvent(event,receivedAt=this.now()){
    for(const entry of event.entry||[])for(const change of entry.changes||[]){
      const v=change.value||{};
      if(v.metadata?.phone_number_id!==this.config.phoneId)continue;
      for(const status of v.statuses||[]){
        const row=this.store.status(status);
        if(row){
          this.log('whatsapp_status',{outgoing_id:status.id,status:status.status,provider_timestamp:status.timestamp,
            delivery_ms:status.status==='delivered'&&row.received_at?Number(status.timestamp)*1000-row.received_at:undefined,
            status_observed_ms:row.received_at?this.now()-row.received_at:undefined,error_codes:status.errors?.map(x=>x.code)});
          if(status.status==='failed'&&row.kind!=='notify')this.handoff(row.conversation_id,'delivery_failed');
        }
      }
      for(const msg of v.messages||[])this.ingest(msg,receivedAt);
    }
  }
  scheduleFollowups(job,decision,now){
    if(!this.config.followups||!this.config.persistent||!decision.followup_eligible||!this.store.hasFollowupPermission(job.phone))return;
    const one=nextBusinessTime(now+3600000);
    let five=nextBusinessTime(now+5*3600000);
    if(five<one+3600000)five=nextBusinessTime(one+4*3600000);
    this.store.job(job.phone,job.revision,'followup_1h',one,{origin:now},now);
    if(decision.followup_5h)this.store.job(job.phone,job.revision,'followup_5h',five,{origin:now},now);
  }
  current(job){
    const c=this.store.conversation(job.phone);
    return c&&!c.paused&&!c.opted_out&&c.revision===job.revision&&this.allowed(job.phone)&&this.config.enabled()&&this.config.ready();
  }
  async process(job){
    let payload=JSON.parse(job.payload);
    if(job.kind==='notify'){
      const opAt=Number(this.store.getMeta('operator_last_inbound'));
      if(!this.config.enabled()||!this.config.ready()||!opAt||this.now()-opAt>=86400000){
        this.store.defer(job.id,this.now()+60000,payload);return;
      }
      this.store.finish(job.id,'sending');
      try{
        const id=await this.transport.send(this.config.operator,payload.body);
        this.store.accepted(job,id,payload.body,this.now(),this.config.operator);
        this.log('operator_notice_accepted',{outgoing_id:id});
      }catch(e){this.store.finish(job.id,e.uncertain?'uncertain':'failed','operator_notice_failed');this.log('operator_notice_failed');}
      return;
    }
    const c=this.store.conversation(job.phone);
    if(!this.current(job)||!this.openWindow(c)){this.store.finish(job.id,'skipped','conversation_changed_or_window_closed');return;}
    if(job.kind==='reply'&&this.now()-c.last_inbound_at>600000){this.store.finish(job.id,'skipped','reply_expired');this.handoff(job.phone,'reply_expired');return;}
    if(job.kind!=='reply'){
      if(!this.config.followups||!this.config.persistent||!this.store.hasFollowupPermission(job.phone)){this.store.finish(job.id,'skipped','followups_disabled_or_no_permission');return;}
      if(!businessHours(this.now())){this.store.defer(job.id,nextBusinessTime(this.now()),payload);return;}
    }
    if(!payload.decision){
      if(!this.store.allowAi(job.phone,this.now())){this.store.finish(job.id,'skipped','consumption_limit');this.handoff(job.phone,'consumption_limit');return;}
      this.log('openai_started',{incoming_id:payload.incoming_id,task:job.kind});
      const started=this.now();
      try{
        const result=await this.transport.decide({task:job.kind,summary:c.summary,followups_enabled:this.config.followups&&this.config.persistent,
          facts:{name:c.name,company_type:c.company_type,city:c.city,ad_experience:c.ad_experience},history:this.store.history(job.phone)});
        const decision=validateDecision(result.decision);
        this.log('openai_completed',{incoming_id:payload.incoming_id,openai_ms:this.now()-started,response_id:result.responseId});
        if(!this.current(job)||this.store.jobState(job.id)!=='running'){this.store.finish(job.id,'cancelled');return;}
        if(decision.action==='handoff'||decision.action==='opt_out'){
          this.store.saveFacts(job.phone,decision);this.store.finish(job.id,'skipped');
          this.handoff(job.phone,decision.reason,decision.action==='opt_out');return;
        }
        if(decision.action==='skip'){this.store.finish(job.id,'skipped','model_skipped');return;}
        payload={...payload,decision,aiMs:this.now()-started};
        this.store.defer(job.id,this.now()+this.delay(decision.reply),payload);return;
      }catch{
        this.store.finish(job.id,'failed','model_failed');this.handoff(job.phone,'model_failed');return;
      }
    }
    if(!this.current(job)||!this.openWindow(this.store.conversation(job.phone))){this.store.finish(job.id,'cancelled');return;}
    this.store.finish(job.id,'sending');
    try{
      const id=await this.transport.send(job.phone,payload.decision.reply);
      this.store.accepted(job,id,payload.decision.reply,this.now());
      if(this.current(job))this.store.saveFacts(job.phone,payload.decision);
      this.log('whatsapp_accepted',{incoming_id:payload.incoming_id,outgoing_id:id,processing_ms:payload.receivedAt?this.now()-payload.receivedAt:undefined,task:job.kind});
      if(job.kind==='reply'&&this.current(job))this.scheduleFollowups(job,payload.decision,this.now());
    }catch(e){
      this.store.finish(job.id,e.uncertain?'uncertain':'failed','send_failed');
      this.handoff(job.phone,e.uncertain?'uncertain_send':'send_failed');
      this.log('processing_failed',{incoming_id:payload.incoming_id,error:e.message?.match(/^remote_\w+$/)?e.message:'send_failed'});
    }
  }
  async tick(){
    if(!this.config.enabled()||!this.config.ready())return;
    const tasks=[];
    for(const job of this.store.due(this.now())){
      if(this.running.has(job.phone)||!this.store.claim(job.id))continue;
      this.running.add(job.phone);
      const task=this.process(job).catch(()=>{this.store.finish(job.id,'failed','job_failed');this.handoff(job.phone,'job_failed');})
        .finally(()=>{this.running.delete(job.phone);this.pending.delete(task);});
      this.pending.add(task);tasks.push(task);
    }
    await Promise.all(tasks);
  }
  start(){this.timer=setInterval(()=>void this.tick(),1000);this.timer.unref();}
  async close(){clearInterval(this.timer);await Promise.allSettled([...this.pending]);this.store.close();}
}

function createSalesAgent({publicPages={},publicPage,config=configuration(),engine=new SalesEngine({config})}={}){
  engine.start();
  const server=http.createServer(async(req,res)=>{
    const respond=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try{
      const url=new URL(req.url,'http://localhost');
      if(['GET','HEAD'].includes(req.method)&&Object.hasOwn(publicPages,url.pathname)){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'Referrer-Policy':'no-referrer'});
        return res.end(req.method==='HEAD'?'':publicPage(...publicPages[url.pathname]));
      }
      if(req.method==='GET'&&['/','/health'].includes(url.pathname))return respond(200,{status:'ok',mode:'sales-pilot',version:'sales-pilot-1',
        configured:config.ready(),autoReply:config.enabled(),testOnly:true,storage:config.persistent?'persistent-sqlite':'temporary-pilot',followups:config.followups&&config.persistent});
      if(req.method==='GET'&&url.pathname==='/webhook'){
        if(url.searchParams.get('hub.mode')!=='subscribe'||!config.env.VERIFY_TOKEN||!equal(url.searchParams.get('hub.verify_token'),config.env.VERIFY_TOKEN))return respond(403,{error:'verification'});
        res.writeHead(200,{'Content-Type':'text/plain'});return res.end(url.searchParams.get('hub.challenge')||'');
      }
      if(req.method==='GET'&&url.pathname==='/agent/handoffs'){
        const token=config.env.AGENT_CONTROL_TOKEN;
        if(!token||token.length<32||!equal(req.headers.authorization,'Bearer '+token))return respond(401,{error:'unauthorized'});
        return respond(200,{handoffs:engine.store.queue()});
      }
      if(req.method!=='POST'||url.pathname!=='/webhook')return respond(404,{error:'not_found'});
      if(!config.env.META_APP_SECRET)return respond(503,{error:'not_configured'});
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>1048576)return respond(413,{error:'too_large'});chunks.push(chunk);}
      const raw=Buffer.concat(chunks),expected='sha256='+crypto.createHmac('sha256',config.env.META_APP_SECRET).update(raw).digest('hex');
      if(!equal(req.headers['x-hub-signature-256'],expected))return respond(401,{error:'invalid_signature'});
      let event;try{event=JSON.parse(raw);}catch{return respond(400,{error:'invalid_json'});}
      if(event.object!=='whatsapp_business_account'||!Array.isArray(event.entry))return respond(400,{error:'invalid_event'});
      engine.ingestEvent(event);
      respond(200,{status:'received'});
    }catch{if(!res.headersSent)respond(503,{error:'temporary_failure'});}
  });
  server.on('close',()=>void engine.close());
  return server;
}
module.exports={SalesEngine,configuration,createSalesAgent,liveTransport};
