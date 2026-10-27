# ADR 0003 — Schema de conformidade ao Decreto nº 13.108/2026 (Fase 2 / S1)

- Status: **proposto** — revisões de `check-in`, `pagamentos-financeiro`,
  `area-organizador`, `admin` e `paginas-publicas` incorporadas (abaixo)
- Data: 2026-10-27
- Autor: agente `banco-de-dados`
- Migração: `20261027180000_compliance_schema` (empilhada sobre
  `20261027120000_coupons_tracking_links`, PR #24)
- Plano: `docs/conformidade-decreto-13108.md` (PR #23), Fase 2

## Contexto

O plano de conformidade junta numa única migração o schema de que a Fase 3
(serviços) precisa: transferência de titularidade (R6), alteração relevante ou
adiamento (R8), canal de cancelamento com protocolo (R5), termos versionados com
aceite registrado (R10) e limite de compra por conta (R4).

As decisões jurídicas D1–D8 estão em aberto. Regra deste ADR: **o schema não fixa
nenhuma delas**. Prazos, o que é "relevante", quem recebe o reembolso de um
ingresso transferido e os textos finais ficam em colunas nulas ou no serviço.
Colunas de anonimização/retenção dependem de D6 e ficam fora (ver follow-ups).

Nenhum serviço ou tela muda nesta fase.

## Decisão

### 1. Transferência de titularidade (R6) — `TicketTransfer`, `IssuedTicket.holderUserId`

- `IssuedTicket.userId` continua sendo o **comprador** (quem pagou). Novo
  `holderUserId` = **titular atual**, `NOT NULL`, FK `RESTRICT`, índices
  `(holderUserId, issuedAt)` ("meus ingressos"), `(eventId, holderUserId)` e
  `(eventId, userId)` (limite por conta).
- Backfill: `holderUserId = Order.userId` (11/11 ingressos no banco de teste).
- Novos ingressos: o Prisma declara o campo como `@default(dbgenerated())` e o
  gatilho `BEFORE INSERT IssuedTicket_default_holder` preenche
  `holderUserId := userId` quando ele não vem. Assim a coluna é `NOT NULL` desde
  já e `issueTicketsTx` não muda nesta fase. O serviço de transferência pode
  passar a gravá-lo explicitamente; o gatilho continua inofensivo.
- `TicketTransfer`: ingresso, evento, `initiatedBy` (`HOLDER` | `ADMIN`),
  remetente (usuário + nome + e-mail copiados), destinatário (`toUserId` nulo até o
  aceite, `toEmail` em minúsculas, `toHolderName`), `status`
  (`PENDING`/`ACCEPTED`/`CANCELLED`/`EXPIRED`), `tokenHash` (SHA-256 do token de
  aceite, **nunca o token**), `previousTokenHash` (QR invalidado no aceite),
  `reversesTransferId` (reversão por fraude), `reason`, `createdById`,
  `createdAt`/`expiresAt`/`decidedAt`, `decidedById`, `decisionReason`, IP e
  agente do pedido e da decisão.
- Histórico ≥ 2 anos: todas as FKs `RESTRICT` (sem cascata a partir de ingresso,
  evento ou usuário) e o gatilho `TicketTransfer_append_only`: sem DELETE; UPDATE
  só na transição PENDING → decidida, sem alterar os dados do pedido nem um
  destinatário já definido; linha decidida é imutável.
- Uma transferência `PENDING` por ingresso (índice único parcial).
- Reversão pelo admin é uma **linha nova** `ADMIN`, já decidida, sem token, com
  motivo obrigatório e `reversesTransferId` único.

### 2. Alteração relevante / adiamento (R8) — `EventChange`

- Evento + organização (FK composta para `Event(id, organizationId)`), autor
  (nulo = sistema), `changedFields`, `before`/`after` (JSON com datas em ISO UTC,
  sem dados pessoais), `reason`, `relevant` (nulo até D2), `refundUntil` (nulo =
  sem janela), `extendsChangeId` (prorrogação), `createdAt`. Somente inserção.
- Elegibilidade é **por alteração**: um pedido pago antes de `createdAt` pode pedir
  reembolso integral até o `refundUntil` daquela alteração (ou da sua prorrogação
  mais recente). Prorrogar = nova linha com `extendsChangeId`; o serviço recusa
  data menor que a vigente.
- Sem status "adiado" em `Event` (só se D2 pedir).
- `RefundReason.EVENT_CHANGED` + `Refund.eventChangeId` (CHECK: um existe ⇔ o
  outro), para a chave de idempotência de L8a não colidir com `CUSTOMER_REQUEST`.

### 3. Pedido de cancelamento (R5) — `CancellationRequest`

- `protocol` único, gerado pelo serviço no formato `CAN-AAAAMMDD-XXXXXX`
  (base32 Crockford, CHECK de formato; sem sequência no banco, que revelaria
  volume e seria previsível), pedido, evento + organização (desnormalizados para a
  fila e para `AuditLog`), solicitante, motivo, `status`
  (`OPEN`/`APPROVED`/`REJECTED`/`WITHDRAWN`), `respondBy` (nulo até D3; definido
  uma vez), `autoEligibleAtRequest`, `assignedToId`/`assignedAt`, decisão
  (`decisionNote`, `decidedById`, `decidedAt`).
- Um pedido `OPEN` por compra; recusa exige justificativa; desistência só pelo
  solicitante; gatilho `CancellationRequest_guard` congela os dados do pedido e a
  linha decidida.
- O vínculo com o reembolso fica em `Refund.cancellationRequestId` (sem
  unicidade: um reembolso que falha é seguido de outro; pedido não pago aprovado
  não gera reembolso).

### 4. Termos (R10) — `TermsVersion`, `TermsAcceptance`

- `TermsVersion`: `kind` (`BUYER`/`ORGANIZER`/`PRIVACY`), `version`, `textHash`
  (SHA-256 hex), `documentPath`, `isDraft` (padrão `true`: os textos atuais são
  rascunho até D8), `publishedAt`. Único `(kind, version)`. Somente inserção.
- `TermsAcceptance`: **um registro por evento de aceite** com `context`
  (`SIGNUP`/`CHECKOUT`/`ORGANIZER_SIGNUP`/`REACCEPT`), `orderId` (obrigatório e
  só em CHECKOUT), `organizationId` (obrigatório em ORGANIZER_SIGNUP, proibido em
  SIGNUP/CHECKOUT), `acceptedAt`, IP, agente. Somente inserção. Únicos parciais:
  um aceite por versão por pedido e por organização.
- Versão vigente: maior `publishedAt <= now()` por `kind`. "Bloquear se houver
  versão nova" = não existe aceite do usuário para a versão vigente.

### 5. Limite por conta (R4) — `Event.maxTicketsPerAccount`

- `Int?` no **evento** (nulo = sem limite, CHECK > 0). Por evento e não por tipo:
  o cambismo compra vários tipos e vários pedidos do mesmo evento, o decreto fala
  em limite por consumidor e o tipo já tem `maxPerOrder`. Um limite por tipo pode
  ser somado depois sem conflito.
- Contagem (L4b, serviço): ingressos não revogados do evento com
  `userId = conta OR holderUserId = conta`, mais reservas ativas dos pedidos da
  conta (índice `Order(userId, eventId, status)`). Contar só o titular deixaria
  comprar N, transferir e comprar de novo.

## Revisões dos donos de domínio (subagentes, somente leitura)

| Dono | Veredito | Aplicado | Não aplicado / adiado |
| --- | --- | --- | --- |
| `check-in` | aprovar com mudanças | `fromHolderEmail`; `previousTokenHash` congelado após a decisão; `decisionReason`; `holderUserId` `NOT NULL` já agora | Pediu trocar o gatilho por uma linha em `issueTicketsTx`: mantido o gatilho porque esta fase não altera serviços; o campo é `NOT NULL` mesmo assim (via `dbgenerated()`), sem `string \| null` no cliente |
| `pagamentos-financeiro` | aprovar com mudanças | `Timestamptz(3)` em tudo; `RefundReason.EVENT_CHANGED` + `Refund.eventChangeId`; elegibilidade por alteração + `extendsChangeId` + CHECK `refundUntil > createdAt`; `Refund.cancellationRequestId` no lugar de `CancellationRequest.refundId`; CHECKs de recusa/desistência; `autoEligibleAtRequest`; índices de contagem do limite | — |
| `area-organizador` | aprovar com mudanças | `relevant Boolean?`; índice `(eventId, refundUntil)`; FK composta evento/organização; FK de `TermsAcceptance.organizationId`; aceite único por organização | `notifiedAt`: o aviso aos compradores vai para `AuditLog` (a linha é somente inserção) |
| `admin` | aprovar com mudanças | Sem `IN_REVIEW`, com `assignedToId`/`assignedAt`; índice `(status, createdAt)`; `eventId`/`organizationId` desnormalizados; protocolo gerado no serviço com CHECK exato; gatilho de imutabilidade parcial; reversão de fraude (`initiatedBy`, `reversesTransferId`, `reason`); `decisionReason` | — |
| `paginas-publicas` | aprovar com mudanças | `context`; um registro por aceite com `orderId` no checkout; CHECKs de contexto; `documentPath`; `isDraft` | Aceite de BUYER + PRIVACY no cadastro: duas linhas na mesma transação (serviço) |

Notas para a Fase 3 levantadas nas revisões (sem schema):

- `check-in`: aceitar com `UPDATE "IssuedTicket" … WHERE status = 'VALID' AND
  "holderUserId" = fromUserId`; trocar `validationToken` no aceite; a rota do PDF
  (`src/app/api/tickets/[code]/pdf/route.ts`) e "meus ingressos" devem autorizar
  por `holderUserId`, no mesmo PR do aceite; "reembolso em andamento" é por pedido
  (travar `Order` com `FOR KEY SHARE`).
- `pagamentos-financeiro`: aceite de transferência trava o `Event` antes de
  conferir o limite (mesma ordem de travas de `createOrder`); até D7, bloquear
  reembolso ao comprador quando houver transferência aceita.
- `area-organizador`: `maxTicketsPerAccount` não menor que nenhum `maxPerOrder`;
  exceção para cortesias/equipe é regra de serviço.

## Verificação

Executado nesta worktree (banco embutido descartável na porta 5461; testes na 5460):

- `npx prisma format`, `npx prisma validate`.
- `prisma migrate deploy` até a migração de cupons → seed → nova migração:
  backfill 11/11. `prisma migrate diff` banco × schema depois da migração:
  **vazio** (os CHECKs, índices parciais e gatilhos não são removidos), e o SQL
  gerado não tem `DROP`.
- 37 cenários SQL contra os CHECKs/gatilhos (12 aceitos e 25 recusados, todos
  como esperado).
- `npm run db:generate`, `npx next typegen`, `npm run typecheck`.
- `TEST_DB_PORT=5460 npm test`: 19 arquivos, 135 testes passando.
- Banco novo: `migrate deploy` + `db:seed` duas vezes (a segunda sai sem
  alterar nada); 11/11 ingressos emitidos pelos serviços com
  `holderUserId = userId` (gatilho).

Não executado: `npm run build`, `npm run lint`, testes de integração novos para
os gatilhos (o quadro reserva letras de arquivo de teste; ver follow-ups).

## Riscos

- `ALTER TYPE "RefundReason" ADD VALUE` não pode ser usado na mesma transação;
  o CHECK compara `reason::text` para contornar.
- FKs `RESTRICT` + gatilhos: excluir usuário, ingresso, evento ou pedido com
  histórico falha (intencional). A exclusão de conta LGPD vira anonimização (D6).
- O gatilho `IssuedTicket_default_holder` é lógica fora do Prisma; está documentado
  em `docs/database.md`.
- Depende do PR #24 (migração de cupons) ser mergeado antes.

## Follow-ups

- **D6** — colunas de anonimização/retenção (`anonymizedAt`, expurgo de IP/agente
  de `TicketTransfer` e `TermsAcceptance`, nomes/e-mails após o prazo).
- **D2** — se pedir, status/flag "adiado" e uso de `relevant`.
- **D3** — prazo de `respondBy`; **D7** — reembolso de ingresso transferido e prazo
  para transferir; **D8** — textos finais (nova `TermsVersion` com `isDraft = false`).
- Testes de integração dos gatilhos e CHECKs (reservar letra no quadro).
- Atualizar §23 de `.claude/agents/banco-de-dados.md` (lista de migrações).
