# Conformidade — Decreto nº 13.108/2026 (venda de ingressos)

Análise técnica feita em 2026-10-27 sobre `main` @ `2d46458`; situação atualizada
em 2026-11-02. **Não é parecer
jurídico.** O texto integral do decreto não pôde ser lido nesta análise; as
regras abaixo vêm do resumo do backlog de lançamento e de reportagens/análises
citadas em [Fontes](#fontes). Cada linha marcada **(confirmar)** precisa ser
conferida no texto oficial e por assessoria jurídica antes da homologação
comercial, inclusive para decidir quais obrigações se aplicam ao nosso modelo
(marketplace que vende em nome do organizador).

Vigência informada pelas fontes: publicado em 01/09/2026; deveres dos
comercializadores, reserva temporária, armazenamento/auditoria de dados e
transferência de titularidade valem 20 dias depois (≈ 21/09/2026) — ou seja,
**já estão em vigor**. Eventos esportivos da Lei Geral do Esporte ficam fora.

## Situação por requisito

Atualizada em 2026-11-02 sobre `main` @ `8a54b1f` (Fases 1 a 4 entregues, PRs #25–#61;
exclusão de conta no #88). A análise original de 2026-10-27 está no histórico do git.
"Provisório" = funciona com um padrão técnico até a decisão jurídica indicada.

| # | Requisito | Situação em `main` | O que falta | Gravidade do que falta |
| --- | --- | --- | --- | --- |
| R1 | **Preço total e taxas discriminadas desde a oferta** | Feito (L1a, L1b): cards, busca, cidade e página do evento mostram o total por ingresso com a taxa discriminada, pela mesma regra que o servidor cobra. | — | — |
| R2 | Taxa só com ciência prévia; nada embutido; sem cobrança duplicada ou sem serviço | Feito: taxa calculada no servidor, ingresso gratuito sem taxa, nenhum serviço adicional. A parte fixa da comissão (`fixedCentsPerTicket`) ainda incide cheia sobre a meia-entrada (`commissionPerUnit`, `src/features/fees/policy.ts`). | Decidir se a taxa da meia deve ser proporcional (**D4**, art. 9º — confirmar) e, se sim, ajustar a regra. | Média |
| R3 | **Reserva temporária** e preço congelado durante a compra (art. 13) | Feito: reserva com trava e CHECK no banco, 15 min com contagem regressiva, preço gravado no pedido; teste de congelamento (L3). | Confirmar se 15 min é "tempo necessário" para cartão (Checkout Pro). | Baixa |
| R4 | Proteção contra compras abusivas (robôs/cambismo) | Feito: limite por pedido, **limite por conta por evento** (`Event.maxTicketsPerAccount`, L4b, vale também na transferência) e limite de frequência na criação de pedido e de pagamento (L4a). | **Verificação anti-robô** (fornecedor a escolher, ex.: Cloudflare Turnstile) no cadastro e no checkout. | Média |
| R5 | **Canal acessível de cancelamento e arrependimento** | Feito: link "Cancelar compra / arrependimento" no rodapé, Meus pedidos, Meus ingressos, pedido e `/ajuda` (L5a); pedido de cancelamento com **protocolo** e prazo de resposta mesmo fora da elegibilidade automática (L5b); fila no admin (A1). Prazo de reembolso automático por evento (`refundWindowDays`/`refundMinHoursBeforeEvent`, padrão 7 dias e 48 h). | Regra das 48 h × arrependimento do CDC (**D3**) e prazo de resposta definitivo — provisórios. | Média |
| R6 | **Transferência gratuita de titularidade**, com autenticação, rastreabilidade e histórico por **≥ 2 anos** | Feito (T-TRANSF, telas na Fase 4): pedido pelo titular autenticado, aceite pelo destinatário autenticado, novo QR, histórico só de inserção (`TicketTransfer`), gratuito, sem furar o limite por conta; política por evento (prazo e número de trocas). Reembolso de ingresso transferido vai ao pagador original. | Confirmar **D7** (quem recebe o reembolso, prazo-limite para transferir) — provisório. | Baixa |
| R7 | **Meia-entrada** e relatórios | Feito: tipo `HALF_PRICE`, cota por evento, declaração no checkout, CSV de meia por evento (L7b), check-in sinaliza "exigir documento" (L7a). **A cota ainda é um teto, não uma reserva.** | **L7c**: reservar a cota de meia até o prazo de **D5** (48 h antes? — confirmar). | Alta |
| R8 | **Reembolso integral** (inclui taxas) em cancelamento, **adiamento ou alteração relevante** (art. 20) | Feito: cancelamento reembolsa tudo; alteração relevante em evento com vendas exige motivo, grava `EventChange`, avisa compradores e abre janela de reembolso integral (L8a, L8b), também para ingressos transferidos. | Definição de "alteração relevante" e prazo da janela (**D2**) — provisórios. | Baixa |
| R9 | Proteção de dados, logs de auditoria e **retenção legal** | Feito: auditoria e razão só de inserção, CPF/CNPJ cifrado, exportação "Meus dados" (L9b), **exclusão/anonimização da conta pelo titular e expurgo programado com prazos provisórios** (#88, `src/server/retention.ts`, `docs/dados-pessoais-e-retencao.md` §2.1). | Prazos definitivos (**D6**); protocolo de pedidos do titular; expurgo de CPF/CNPJ de organizações encerradas; decidir se o Marco Civil exige guardar registros de acesso (IP), hoje não coletados. | Média |
| R10 | **Contratos claros** (responsabilidade de organizador × plataforma) | Feito: termos versionados com **aceite registrado** no cadastro, checkout e cadastro de organizador, com bloqueio em versão nova (L10a); organizador responsável identificado no evento e no ingresso/PDF (L10b). **`/termos` e `/privacidade` ainda são rascunhos técnicos.** | Textos definitivos de termos, privacidade e contrato do organizador (**D8**). | Alta |

Já atende (manter e cobrir com testes): sem overselling (CHECK + trava), preço
e taxa calculados no servidor, reembolso integral automático no cancelamento,
pagamento confirmado só pelo provedor, auditoria somente inserção.

### O que falta, em resumo

1. **Jurídico (bloqueia a homologação comercial — V2):** ler e conferir o texto
   oficial do decreto (as regras vieram de fontes secundárias) e decidir D1–D8.
   D2, D3, D6 e D7 já têm padrão provisório em produção; D4, D5 e D8 bloqueiam
   trabalho técnico.
2. **Técnico:** L7c (reserva da cota de meia, depende de D5); ajuste da taxa
   sobre meia (depende de D4); verificação anti-robô; sobras de R9.

## Plano por agente

As tarefas usam os ramos e worktrees de `C:\dev\evento-brasil-agentes\COORDENACAO.md`.
**Todas as mudanças de schema vão num único lote do `banco-de-dados`**, depois
da migração de cupons (ADR 0002) que está em andamento, para não gerar
migrações concorrentes.

### Fase 0 — Decisões jurídicas (usuário + assessoria) — bloqueia o que está marcado (confirmar)

D1 aplicabilidade ao nosso modelo · D2 definição de "alteração relevante" e prazo
da janela de reembolso · D3 arrependimento × regra de 48 h · D4 taxa sobre meia ·
D5 reserva da cota de meia (48 h?) · D6 prazos de retenção por tipo de dado ·
D7 quem recebe o reembolso de ingresso transferido (pagador original?) e se há
prazo-limite para transferir · D8 textos de termos, privacidade e contrato do organizador.

### Fase 1 — Sem schema (em paralelo, já pode começar)

| ID | Tarefa | Agente | Depende |
| --- | --- | --- | --- |
| L1a | Função de prévia de preço ao comprador (preço + taxa por tipo, mesma regra de `computeFees`/`resolveCommissionRule`) exposta ao catálogo | pagamentos-financeiro | — |
| L1b | Cards, busca, cidade e página do evento mostram **total por ingresso** com taxa discriminada; e2e comparando com o checkout | paginas-publicas | L1a |
| L3 | Teste de congelamento de preço durante a reserva | pagamentos-financeiro | — |
| L4a | Rate limit em criação de pedido e de pagamento; mensagens pt-BR | pagamentos-financeiro | — |
| L5a | Link "Cancelar compra / arrependimento" no rodapé, Meus pedidos, e-mail de confirmação; texto da política em `/ajuda` | paginas-publicas | — |
| L7a | Check-in sinaliza **"Meia-entrada — exigir documento"** ao admitir `HALF_PRICE` | check-in | — |
| L7b | CSV de meia-entrada por evento (vendidos, cota, restante) no painel | area-organizador | — |
| L9a | Inventário de dados pessoais e proposta de tabela de retenção | banco-de-dados | — (alimenta D6) |

### Fase 2 — Lote de schema único (`banco-de-dados`)

Pedidos no formato de COORDENACAO.md, revisados pelos donos de domínio:

- `TicketTransfer` (ingresso, de/para usuário, nomes, status PENDENTE/ACEITA/CANCELADA/EXPIRADA, hash do token, datas, IP/agente opcional) **somente inserção para o histórico**, sem `onDelete: Cascade`; `IssuedTicket.holderUserId` (dono atual) com backfill = comprador. Revisão: check-in + pagamentos-financeiro.
- `EventChange` (evento, campos alterados antes/depois, motivo, autor, `refundUntil`) e, se D2 pedir, status/flag de adiado. Revisão: area-organizador + pagamentos-financeiro.
- `CancellationRequest` (protocolo, pedido, motivo, status, prazos, decisão). Revisão: pagamentos-financeiro + admin.
- `TermsVersion` / `TermsAcceptance` (tipo, versão, hash do texto, usuário, data, IP). Revisão: paginas-publicas + area-organizador.
- Limite por conta por evento (`Event.maxTicketsPerAccount` ou no tipo). Revisão: pagamentos-financeiro.
- Reserva da cota de meia (se D5) — provavelmente só regra de serviço, sem coluna.
- Campos de anonimização/retenção conforme D6.

### Fase 3 — Serviços

| ID | Tarefa | Agente | Depende |
| --- | --- | --- | --- |
| T-TRANSF | **Transferência**: iniciar (titular autenticado, ingresso válido, sem check-in, sem reembolso em andamento, evento não encerrado), aceitar (destinatário autenticado), cancelar, expirar; ao aceitar: novo `validationToken`/QR, novo titular, auditoria e e-mail aos dois; gratuito; limite de transferências por ingresso e respeito ao limite por conta | check-in | Fase 2, D7 |
| L4b | Limite por conta por evento na criação do pedido e na transferência | pagamentos-financeiro | Fase 2 |
| L7c | Reservar a cota de meia até o prazo de D5 (disponibilidade de inteiras = capacidade − cota de meia restante) | pagamentos-financeiro (pedido) + paginas-publicas (`catalog.ts`) | D5 |
| L8a | `openChangeRefundWindow(eventId)`: reembolso integral (com taxas) a pedido do comprador até `refundUntil`, fora da regra normal; também para ingressos transferidos (paga o pagador original — D7) | pagamentos-financeiro | Fase 2, D2 |
| L8b | `updateEvent` detecta alteração relevante em evento com vendas, exige motivo, grava `EventChange`, chama L8a e notifica compradores | area-organizador | L8a |
| L5b | Pedido de cancelamento com protocolo, prazos e decisão (aprovar → `requestCustomerRefund`/`adminRefundOrder`) | pagamentos-financeiro | Fase 2 |
| L9b | Exportar meus dados; excluir/anonimizar conta preservando pedidos, razão, auditoria e histórico de transferência pelo prazo legal; cron de expurgo. **Feito com prazos provisórios** (`src/server/retention.ts`, `docs/dados-pessoais-e-retencao.md` §2.1); D6 confirma ou ajusta | banco-de-dados (expurgo) + paginas-publicas (`/minha-conta`) | D6 (prazos finais) |
| L10a | Aceite registrado de termos no cadastro, checkout e cadastro de organizador; bloqueio se houver versão nova | paginas-publicas + area-organizador | Fase 2, D8 |

### Fase 4 — Telas, admin e verificação

| ID | Tarefa | Agente |
| --- | --- | --- |
| T-TRANSF-UI | "Transferir" em Meus ingressos, transferências recebidas, página de aceite, PDF/QR atualizados | paginas-publicas |
| T-TRANSF-ORG | Participantes mostram titular atual e histórico de transferências; CSV | area-organizador |
| A1 | Fila de pedidos de cancelamento (protocolo, prazo, decisão), histórico de transferências com reversão de fraude, alterações de evento e janelas de reembolso abertas | admin |
| L10b | Identificar o organizador responsável (razão social/CNPJ ou nome) na página do evento e no ingresso | paginas-publicas + check-in (PDF) |
| V1 | Testes de integração de cada fluxo (incl. concorrência: transferência × check-in × reembolso) e e2e; `checkFinancialInvariants` sem erros | todos |
| V2 | Atualizar `docs/legal-review.md` e este documento com as decisões; revisão jurídica antes da homologação comercial | usuário + agentes |

### Ordem sugerida

1. **Agora:** Fase 0 com o jurídico e, em paralelo, Fase 1 (L1a → L1b, L3, L4a, L5a, L7a, L7b, L9a).
2. Quando a migração de cupons entrar: lote de schema da Fase 2.
3. Fase 3 começando por **T-TRANSF** e **L8a/L8b** (lacunas críticas, já em vigor).
4. Fase 4 e verificação; só então homologação comercial.

## Fontes

- Texto oficial: [Decreto nº 13.108, de 31 de agosto de 2026 — Planalto](http://www.planalto.gov.br/ccivil_03/_ato2023-2026/2026/decreto/d13108.htm) (não lido integralmente nesta análise)
- [Consumidor Moderno — o que muda na compra de ingressos](https://consumidormoderno.com.br/novo-decreto-compra-ingressos-regras/)
- [Atlas Público — regras para venda e revenda de ingressos](https://atlaspublico.com.br/noticias/presidencia-da-republica-cria-regras-para-venda-e-revenda-84095)
- [Morais & Andrade — novas regras já em vigor](https://moraisandrade.com/site-2026/consumidor-novas-regras-para-a-comercializacao-de-ingressos-ja-estao-em-vigor-decreto-no-13-108-2026-amplia-as-obrigacoes-de-produtores-comercializadores-e-plataformas-de-revenda-de-ingressos-ente/)
- [ADV Review — cambismo e meia-entrada](https://advreview.com/blog/ingresso-de-show-cambismo-meia-entrada-novas-regras) (fonte da regra de 48 h da meia e do art. 9º — confirmar)
- [Brasil em Folhas — taxas ocultas](https://www.brasilemfolhas.com.br/2026/09/decreto-proibe-taxas-ocultas-na-venda-de-ingressos/)
