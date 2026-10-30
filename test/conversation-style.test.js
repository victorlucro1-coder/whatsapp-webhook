'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {conversationRules,validateDecision}=require('../sales-policy');
const {SalesEngine}=require('../sales-agent');
const {SalesStore}=require('../sales-store');
const first='Olá sou o joao, tenho uma empresa de ar condicionado em recife e nunca anunciei, como funciona?';
const introduction='Oi, João! Aqui é o Francisco, da FV Anúncios. Posso divulgar sua empresa para pessoas da sua região que precisam instalar ar-condicionado.';
const decision=reply=>({action:'reply',reason:'none',reply,summary:'João instala ar-condicionado em Recife e nunca anunciou.',name:'João',company_type:'Ar-condicionado',city:'Recife',ad_experience:'primeira vez',followup_eligible:false,followup_5h:false});
const history=[{role:'user',content:first}];
test('opening explains one idea, identifies Francisco, and cannot rush price or materials',()=>{
  const rules=conversationRules(history);
  assert.equal(rules.first_reply,true);assert.equal(rules.allow_price,false);
  assert.doesNotThrow(()=>validateDecision(decision(introduction),rules));
  for(const text of ['Olá João! Nós da FV Anúncios trabalhamos com gestão de tráfego pago.',
    'Aqui é o Francisco. A gestão custa R$ 400 por plataforma.',
    'Aqui é o Francisco. Me mande fotos e vídeos para começar.',
    'Aqui é o Francisco. '+('Uma explicação muito extensa. '.repeat(15))]) {
    assert.throws(()=>validateDecision(decision(text),rules),/style_/);
  }
});
test('confusion receives an example instead of a repeated proposal or another generic question',()=>{
  for(const text of ['Não entendi nada','Difícil entender']) {
    const rules=conversationRules([...history,{role:'assistant',content:introduction},{role:'user',content:text}]);
    assert.equal(rules.confused,true);assert.equal(rules.allow_price,false);
    assert.doesNotThrow(()=>validateDecision(decision('Por exemplo: alguém procura instalação de ar-condicionado no Google. Seu anúncio pode aparecer ali, com um botão para falar com sua empresa.'),rules));
    assert.throws(()=>validateDecision(decision('Qual parte você não entendeu?'),rules),/style_unhelpful/);
    assert.throws(()=>validateDecision(decision('A gestão custa R$ 400. Precisamos de fotos e vídeos.'),rules),/style_/);
  }
});
test('direct price questions are answered even on first contact; a generic how-it-works is not price permission',()=>{
  for(const text of ['Quanto custa?','Qual o investimento?','Como funciona o pagamento?']) {
    const rules=conversationRules([{role:'user',content:text}]);
    assert.equal(rules.allow_price,true);
    assert.doesNotThrow(()=>validateDecision(decision('Aqui é o Francisco, da FV Anúncios! A gestão é R$ 400 por mês, por plataforma. A verba dos anúncios é separada: sugiro começar com R$ 15 a R$ 20 por dia.'),rules));
  }
  const rules=conversationRules([...history,{role:'assistant',content:introduction},{role:'user',content:'Qual a diferença entre Instagram e Google?'}]);
  assert.equal(rules.allow_price,false);
  assert.doesNotThrow(()=>validateDecision(decision('No Google, seu anúncio aparece quando alguém procura instalação de ar-condicionado. No Instagram, ele aparece enquanto a pessoa vê fotos e vídeos, mesmo sem estar procurando esse serviço.'),rules));
});
test('invalid draft is rewritten once before any send; repeated invalid drafts pause without sending',async()=>{
  for(const rewriteSucceeds of [true,false]) {
    let now=Date.now(),calls=0;const sends=[],contexts=[];
    const store=new SalesStore();
    const engine=new SalesEngine({store,now:()=>now,delay:()=>0,log:()=>{},
      config:{testPhone:'5511993680362',operator:'5511888888888',activated:now-1000,enabled:()=>true,ready:()=>true,followups:false,persistent:false},
      transport:{decide:async context=>{contexts.push(context);calls++;return {decision:decision(calls===2&&rewriteSucceeds?introduction:'Aqui é o Francisco. A gestão custa R$ 400. Envie fotos e vídeos.')};},send:async(to,body)=>{sends.push(body);return 'out';}}});
    try {
      engine.ingest({id:'in',from:'5511993680362',timestamp:String(Math.floor(now/1000)),type:'text',text:{body:first}});
      now+=5000;await engine.tick();await engine.tick();
      assert.equal(calls,2);assert.match(contexts[1].correction,/^style_/);
      assert.deepEqual(sends,rewriteSucceeds?[introduction]:[]);
      assert.equal(store.conversation('5511993680362').paused,rewriteSucceeds?0:1);
    }finally{await engine.close();}
  }
});
