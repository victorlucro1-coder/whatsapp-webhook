'use strict';
// Meta deliveries succeed only after the PC commits the signed event to SQLite.
const http = require('node:http');
const crypto = require('node:crypto');
// Public informational pages contain no account credentials or customer records.
const publicPages = {
 '/privacidade': ['Política de privacidade', `
<p>A <strong>FV Anúncios</strong> é responsável pelo atendimento realizado por meio do aplicativo Atendimento Victor IA. Contato para assuntos de privacidade: <a href="mailto:victorlucro1@gmail.com">victorlucro1@gmail.com</a>.</p>
<h2>Dados utilizados</h2><p>O atendimento utiliza o telefone, o nome disponibilizado pelo WhatsApp, o conteúdo enviado na conversa, identificadores das mensagens, datas, horários e estados de entrega. Também pode utilizar resumos, pedidos, pendências e rascunhos de respostas para manter o contexto do atendimento. Evite enviar senhas, códigos de autenticação e informações sensíveis desnecessárias.</p>
<h2>Finalidades</h2><p>Usamos essas informações para responder a solicitações, acompanhar o atendimento e preservar seu contexto. Quando o atendimento se relaciona a uma contratação solicitada pelo cliente, o tratamento necessário pode envolver procedimentos preliminares ou execução do contrato. Outras finalidades exigem avaliação da hipótese legal correspondente. Enviar uma mensagem não representa autorização genérica para qualquer uso dos dados.</p>
<h2>Armazenamento e fornecedores</h2><p>As mensagens passam pela Meta/WhatsApp. A integração utiliza o Render para transmitir os eventos ao computador responsável pelo atendimento. O aplicativo nesse serviço mantém os eventos temporariamente em memória enquanto aguarda a confirmação local; o histórico permanente da integração e seus backups ficam no computador da FV Anúncios. Os fornecedores também podem manter registros técnicos conforme suas próprias políticas.</p>
<h2>Uso de inteligência artificial</h2><p>Quando a FV Anúncios utiliza recursos de análise, resumo ou sugestão de respostas da OpenAI, o conteúdo necessário da conversa é transmitido a esse fornecedor. O tratamento depende do produto utilizado e de suas configurações. Esses serviços podem processar dados fora do Brasil. Na configuração atual, as respostas automáticas estão desativadas e o envio de rascunhos depende da autorização do responsável pelo atendimento.</p>
<h2>Conservação e segurança</h2><p>A configuração atual mantém o histórico e cópias de segurança sem exclusão automática por prazo. Solicitações de exclusão são analisadas individualmente, inclusive quanto a memórias e backups, considerando a necessidade de conservação e eventuais obrigações aplicáveis. O responsável informa quando houver motivo para conservar dados solicitados para exclusão. A integração usa credenciais, autenticação e conexões HTTPS; nenhuma medida elimina todos os riscos.</p>
<h2>Seus direitos</h2><p>Você pode solicitar confirmação do tratamento, acesso, correção, informações sobre compartilhamento e, quando aplicável, exclusão, oposição, portabilidade ou revogação de consentimento. Use o e-mail acima. Poderemos solicitar apenas informações proporcionais para confirmar sua identidade. A solicitação não tem cobrança. Consulte também as <a href="https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados-1/direito-dos-titulares">orientações da ANPD</a>.</p>
<p>Para pedir exclusão, consulte as <a href="/exclusao-de-dados">instruções de exclusão de dados</a>. Alterações relevantes no uso ou armazenamento dos dados serão refletidas nesta página.</p>`],
 '/exclusao-de-dados': ['Solicitar exclusão de dados', `
<p>Para solicitar a exclusão dos dados do atendimento por WhatsApp da <strong>FV Anúncios</strong>, escreva para <a href="mailto:victorlucro1@gmail.com?subject=Solicita%C3%A7%C3%A3o%20de%20exclus%C3%A3o%20de%20dados">victorlucro1@gmail.com</a>.</p>
<ol><li>Use o assunto “Solicitação de exclusão de dados — WhatsApp”.</li><li>Informe seu número de WhatsApp com código do país e quais dados deseja excluir.</li><li>Aguarde a resposta do responsável, que poderá confirmar sua identidade de forma proporcional ao pedido.</li></ol>
<p>Não envie senhas, tokens ou documentos de identidade na solicitação inicial. A resposta informará o resultado ou explicará os dados que precisem ser conservados e o motivo. A análise abrange o histórico, memórias e registros relacionados, inclusive cópias de segurança sob controle da FV Anúncios, observadas as obrigações aplicáveis. O pedido é gratuito.</p>
<p>A exclusão na integração não remove automaticamente mensagens do seu aparelho nem dados mantidos independentemente pelo WhatsApp ou por outros fornecedores. Para esses serviços, utilize também seus próprios canais de privacidade.</p><p><a href="/privacidade">Ler a política de privacidade</a></p>`]
};
function publicPage(title, content) {
 return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | FV Anúncios</title><style>body{margin:0;background:#f5f7fa;color:#182b3a;font:17px/1.7 system-ui,sans-serif}main{max-width:760px;margin:40px auto;padding:32px;background:white;border-radius:16px}h1{line-height:1.2}h2{font-size:1.25rem;margin-top:32px}a{color:#075ea8;overflow-wrap:anywhere}small{color:#526273}@media(max-width:600px){main{margin:12px;padding:22px}}</style></head><body><main><small>FV ANÚNCIOS · ATENDIMENTO PELO WHATSAPP</small><h1>${title}</h1><p><small>Atualizado em 29 de setembro de 2026</small></p>${content}</main></body></html>`;
}
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
      if(['GET','HEAD'].includes(req.method) && Object.hasOwn(publicPages,url.pathname)) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff',
          'Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});
        return res.end(req.method==='HEAD'?'':publicPage(...publicPages[url.pathname]));
      }
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
