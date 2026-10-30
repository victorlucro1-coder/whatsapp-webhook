# Piloto comercial da FV Anúncios

O serviço e o webhook existentes são reutilizados. O piloto aceita somente o telefone de teste configurado; não há opção para liberar todos os remetentes nesta versão.

## Regras e comandos

As condições comerciais aprovadas estão em `sales-policy.js`. Nenhum token é incluído nesses arquivos.

- Perguntas naturais sobre nome, ramo e experiência; preço direto quando perguntado.
- Respostas com até 240 caracteres e uma ideia por vez. Primeira resposta apresenta Francisco; sem preços quando o lead apenas pergunta como funciona. Materiais não são solicitados durante a apresentação.
- Confusão recebe um exemplo simples, sem repetir a oferta inteira. Respostas que violam essas regras são reescritas uma vez; se continuarem inválidas, o atendimento é pausado para Francisco. Nenhum texto é cortado ou dividido para contornar o limite.
- Gestão de R$ 400 por plataforma; entrada de R$ 200 e R$ 200 ao iniciar a veiculação.
- Verba da plataforma separada; opcionais de página/domínio e vídeo conforme as condições aprovadas.
- Sem lucro garantido, dados locais inventados, urgência fictícia ou desconto não autorizado.
- Agrupa mensagens por 5 segundos, gera a resposta e espera mais 8–15 segundos para textos curtos ou 15–25 segundos para maiores.
- Novas mensagens invalidam as respostas ainda não enviadas.
- Fechamento, cobrança, pedido de áudio/ligação, pergunta sobre IA e solicitação humana pausam a conversa e geram aviso ao operador. Áudios recebidos também são encaminhados, sem transcrição nesta etapa.
- Pedido para parar cancela os agendamentos e bloqueia retomada automática.

Do número de operador autorizado, para o WhatsApp comercial:

- `#fila`: lista as conversas pausadas.
- `#pausar TELEFONE`: pausa uma conversa do piloto e cancela os follow-ups pendentes.
- `#retomar TELEFONE`: libera respostas a novas mensagens. Não responde retroativamente ao pedido que motivou o atendimento humano.
- `#retomar TELEFONE | resumo do atendimento humano`: também informa o contexto do que foi combinado. Áudios e mensagens enviados manualmente fora desta integração não são transcritos/importados automaticamente.

Os telefones nos comandos usam código do país e DDD, somente números. O operador também precisa estar em uma janela de 24 horas aberta para receber avisos livres pelo WhatsApp. Enviar `#fila` no início do dia abre essa janela. Fora dela, os avisos aguardam; o sistema não envia modelos cobrados nem mensagens livres fora da janela.

## Configuração do piloto gratuito

Manter as credenciais existentes e `WHATSAPP_DIRECT_AGENT=true`. Acrescentar:

```dotenv
AGENT_SALES_PILOT=true
AGENT_OPERATOR_PHONE=<telefone autorizado do operador>
AGENT_AUTO_REPLY=true
AGENT_FOLLOWUPS=false
AGENT_PERSISTENT_STORAGE=false
```

`AGENT_TEST_PHONE` mantém a restrição ao teste. Sem `AGENT_DATABASE_PATH`, o SQLite fica em memória: os dados do piloto podem ser perdidos em reinicializações. Não usar esse modo para operação comercial contínua.

O modo antigo de teste continua disponível com `AGENT_SALES_PILOT=false`.

## Memória e follow-ups duráveis, ainda sem ativação

O código implementa SQLite para contatos, conversas, mensagens, permissões de retorno e tarefas. Em disco permanente, o histórico, a deduplicação, as pausas e os agendamentos sobrevivem a reinícios.

O caminho sugerido, após montar e verificar um disco permanente, é `/var/data/agent.sqlite`. Somente depois de verificar esse volume:

```dotenv
AGENT_DATABASE_PATH=/var/data/agent.sqlite
AGENT_PERSISTENT_STORAGE=true
AGENT_FOLLOWUPS=true
```

Não configurar esses valores em um diretório efêmero da Render. SQLite não exige outro serviço de banco. O agendador executa no mesmo processo, a cada segundo, com apenas uma instância. Um serviço pago que permaneça ativo e um disco persistente são necessários para essa opção na Render; nenhuma mudança paga foi autorizada ou aplicada.

- Sequência de 1h e 5h desde a resposta comercial original, sem reiniciar o relógio ao enviar o primeiro follow-up.
- O segundo só é criado quando há justificativa contextual e é reavaliado antes de enviar.
- Exige permissão de retorno do contato; o piloto reconhece pedidos explícitos de lembrete ou confirmação à pergunta de permissão.
- Segunda a sexta, 9h–18h em `America/Sao_Paulo`. Ajusta vencimentos fora do período e espaça mensagens que cairiam juntas.
- Se a janela de 24h da última mensagem do cliente acabar, a retomada é descartada. Não usa templates de marketing nem envia em 24h/48h.
- Cliente respondeu, optou por parar ou a conversa foi pausada: cancela a sequência.
- Falha ou envio incerto pausa a conversa. Um envio que pode ter chegado à Meta nunca é repetido automaticamente.
- Limite conservador de 30 chamadas à IA por contato em 24 horas, com histórico recente limitado e resumo do contexto anterior.

É necessário definir backups do banco por mecanismo próprio do SQLite e cópia fora do serviço antes da produção. Os snapshots de disco da Render não substituem um backup consistente do banco.

## Verificação

`npm test` usa transportes falsos, sem chamadas reais à Meta ou OpenAI. Testa assinaturas, remetentes, agrupamento, concorrência, pausas, opt-out, reinicialização, agendamento e falhas incertas. Um teste real restrito continua necessário para avaliar a qualidade comercial e os avisos.

`GET /health` informa modo, configuração e se os follow-ups estão habilitados, sem dados de clientes. A fila HTTP de atendimento só pode ser consultada se `AGENT_CONTROL_TOKEN` estiver definido e for enviado como Bearer; o piloto pode usar somente os comandos do operador.
