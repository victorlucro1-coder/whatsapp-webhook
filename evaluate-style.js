'use strict';
// Executa somente chamadas à IA com diálogos fictícios. Nunca chama a API do WhatsApp.
const {liveTransport,configuration}=require('./sales-agent');
const {conversationRules,validateDecision}=require('./sales-policy');
async function main(){
  if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY não configurada');
  const transport=liveTransport(configuration()),history=[];
  const cases=['Olá sou o joao, tenho uma empresa de ar condicionado em recife e nunca anunciei, como funciona?',
    'Não entendi nada','Qual a diferença entre anunciar no Instagram e no Google?','Difícil entender','Quanto custa?'];
  let summary='',facts={};
  for(const text of cases){
    history.push({role:'user',content:text});
    const context={task:'reply',history,rules:conversationRules(history),followups_enabled:false,summary,facts};
    let result=await transport.decide(context),decision,rewrite=false;
    try{decision=validateDecision(result.decision,context.rules);}
    catch(e){if(!e.message.startsWith('style_'))throw e;rewrite=true;result=await transport.decide({...context,correction:e.message});decision=validateDecision(result.decision,context.rules);}
    if(decision.action!=='reply')throw new Error('Resposta fictícia inesperadamente encaminhada');
    console.log(JSON.stringify({question:text,reply:decision.reply,characters:decision.reply.length,rewrite}));
    history.push({role:'assistant',content:decision.reply});summary=decision.summary;
    facts=Object.fromEntries(['name','company_type','city','ad_experience'].map(k=>[k,decision[k]]));
  }
}
main().catch(e=>{console.error('Avaliação falhou:',e.message);process.exitCode=1;});
