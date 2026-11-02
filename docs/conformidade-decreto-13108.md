# Conformidade — Decreto nº 13.108/2026 (venda de ingressos)

Análise técnica feita em 2026-10-27 sobre `main` @ `2d46458`. **Não é parecer
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

| # | Requisito | O que o Evento Brasil faz hoje | Lacuna | Gravidade |
| --- | --- | --- | --- | --- |
| R1 | **Preço total e taxas discriminadas desde a oferta** | Página do evento mostra preço e "+ R$ x de taxa de serviço" por tipo, e o resumo do checkout discrimina subtotal/taxa/total. **Cards da home, busca e cidade mostram "A partir de R$ X" sem a taxa** (`src/components/site/event-card.tsx`, `priceLabel`). | Mostrar o **total por ingresso (preço + taxa)** em todo ponto de oferta, com a taxa discriminada; mesmo valor que o servidor cobrará. | Alta |
| R2 | Taxa só com ciência prévia; nada embutido; sem cobrança duplicada ou sem serviço | Taxa calculada no servidor (`computeFees`), ingresso gratuito sem taxa, nenhum serviço adicional vendido. **A parte fixa da comissão (`fixedCentsPerTicket`) incide cheia sobre meia-entrada** (`commissionPerUnit` em `src/features/fees/policy.ts`). | Decidir se a taxa da meia deve ser proporcional (uma fonte diz que taxa cheia em meia é abusiva — **confirmar**, art. 9º). | Média |
| R3 | **Reserva temporária** e preço congelado durante a compra (art. 13) | Reserva com trava do evento e CHECK no banco, `RESERVATION_MINUTES=15`, contagem regressiva no checkout, preço gravado no pedido (`OrderItem.unitPriceCents`), PIX expira com a reserva. | Teste explícito de que mudar o preço durante a reserva não altera o pedido; revisar se 15 min é "tempo necessário" (cartão + 3DS) — **confirmar**. | Baixa |
| R4 | Proteção contra compras abusivas (robôs/cambismo) | Limite mínimo/máximo **por pedido** (`maxPerOrder`), rate limit em login/cadastro. **Nada limita compras por conta/CPF por evento nem a criação de pedidos** (`createOrderAction` sem rate limit); sem verificação anti-robô. | Limite por conta por evento, rate limit em criação de pedido e de pagamento, sinal anti-robô (fornecedor a decidir), e a transferência (R6) não pode furar esses limites. | Alta |
| R5 | **Canal acessível de cancelamento e arrependimento** | Botão de reembolso na página do pedido quando elegível (`refundEligibility`: 7 dias após a compra **e** 48 h antes do evento); `/ajuda` explica. Sem canal quando o botão não aparece; sem protocolo. | Link "Cancelar compra" visível (rodapé, Meus pedidos, e-mail), formulário com **número de protocolo** mesmo fora da elegibilidade automática, fila no admin com prazo de resposta. Regra dos 48 h × arrependimento do CDC — **confirmar**. | Alta |
| R6 | **Transferência gratuita de titularidade**, com autenticação, rastreabilidade e histórico por **≥ 2 anos** | **Não existe.** `IssuedTicket` guarda `holderName`/`holderEmail` definidos na compra; não há dono por conta nem histórico. | Fluxo completo (ver T-TRANSF): pedido pelo titular autenticado, aceite pelo destinatário autenticado, novo QR (o antigo deixa de valer), histórico imutável retido ≥ 2 anos, gratuito, sem burlar limites antifraude. | **Crítica** |
| R7 | **Meia-entrada** e relatórios | Tipo `HALF_PRICE`, cota por evento (`halfPriceQuotaBps`), declaração obrigatória no checkout, cota restante exibida, relatório da cota em *Vendas e repasses*, aviso no ingresso. **A cota é um teto, não uma reserva**: ingressos inteiros podem consumir a capacidade e deixar a meia sem lugar. | Reservar a cota de meia até **48 h antes** do evento (fonte secundária — **confirmar**); relatório exportável por evento; check-in sinalizar "exigir documento" ao ler meia. | Alta |
| R8 | **Reembolso integral** (inclui taxas) em cancelamento, **adiamento ou alteração relevante** (art. 20) | Cancelamento pelo organizador/admin reembolsa tudo, inclusive a taxa (`cancelEvent`). **Editar data, local ou formato de evento publicado com vendas não gera aviso nem direito a reembolso** (`updateEvent` só audita). Não há estado "adiado". | Detectar alteração relevante em evento com vendas, exigir motivo, guardar histórico, avisar compradores e abrir **janela de reembolso integral** fora da regra normal. Definir "alteração relevante" — **confirmar**. | **Crítica** |
| R9 | Proteção de dados, logs de auditoria e **retenção legal** | `AuditLog` e razão somente inserção (triggers), CPF/CNPJ cifrado, exportação de participantes auditada, cookies só essenciais. Sem política de retenção aplicada, sem exportação/exclusão de dados pelo titular, sem expurgo programado. | Tabela de retenção por tipo de dado (com prazos jurídicos), atendimento LGPD (exportar, corrigir, excluir/anonimizar mantendo o que a lei obriga guardar), auditoria de transferências e pedidos de cancelamento. | Alta |
| R10 | **Contratos claros** (responsabilidade de organizador × plataforma) | `/termos` e `/privacidade` são **rascunhos técnicos** (aviso na página); nenhum aceite é registrado; página do evento não identifica a pessoa jurídica responsável. | Textos definitivos (jurídico), termos versionados com **aceite registrado** (comprador no cadastro/checkout, organizador no cadastro), identificação do organizador responsável no evento e no ingresso. | Alta |

Já atende (manter e cobrir com testes): sem overselling (CHECK + trava), preço
e taxa calculados no servidor, reembolso integral automático no cancelamento,
pagamento confirmado só pelo provedor, auditoria somente inserção.

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
