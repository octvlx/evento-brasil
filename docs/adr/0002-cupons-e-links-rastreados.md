# ADR 0002 — Cupons de desconto e links de venda rastreados

- Status: **proposto** — revisões de `pagamentos-financeiro` e
  `banco-de-dados` (comentários no PR #14) incorporadas
- Data: 2026-10-26
- Autor: agente `area-organizador`

## Contexto

Produtores esperam dois recursos que concorrentes de bilheteria oferecem e que
o Evento Brasil não tem:

1. **Cupom de desconto** digitado no checkout.
2. **Link de venda rastreado**: saber de onde veio cada venda (UTM, campanha,
   divulgador), base para comissários/promoters no futuro.

Fatos do código atual que limitam o desenho:

- Preço vem sempre do banco; `computeFees` (`src/features/fees/policy.ts`)
  calcula comissão e taxa de serviço **por unidade** a partir de
  `unitPriceCents`. Ingresso de preço 0 nunca gera comissão.
- O banco exige `Order.totalCents = subtotalCents + serviceFeeCents`
  (`Order_amounts_nonnegative`), e a reconciliação
  (`ORDER_TOTALS_MISMATCH`) exige
  `totalCents = Σ (unitPriceCents + serviceFeePerUnitCents) × quantity`.
- Razão (`postSale`/`postReversal`) e reembolsos usam apenas totais do pedido
  (`totalCents`, `commissionCents`, `serviceFeeCents`); reembolso é sempre do
  pedido inteiro.
- `createOrder` trava a linha do `Event` e serializa as compras por evento.

## Decisões propostas

### D1. Cupom é desconto do organizador sobre o preço de face

O desconto reduz o preço unitário **antes** de `computeFees`. Consequências:

- `OrderItem.unitPriceCents` passa a ser o **preço efetivamente cobrado**
  (líquido de desconto). Novas colunas guardam o preço de tabela e o desconto
  por unidade. Assim o `CHECK` do pedido, a reconciliação, o razão e os
  reembolsos **não mudam**.
- Comissão e taxa de serviço (bearer `BUYER`) incidem sobre o preço líquido
  (**confirmado por `pagamentos-financeiro`**). Um cupom de 100% gera pedido
  gratuito (fluxo `FREE` existente, sem comissão) e, como qualquer ingresso
  gratuito, dispensa a checagem de conta de recebimento do organizador.
- O desconto sai da receita do organizador; a plataforma não subsidia cupom.

**Guarda contra repasse negativo (bloqueador B1 da revisão).** Com bearer
`ORGANIZER` e `fixedCentsPerTicket > 0`, a comissão por unidade continua
`bps + fixo` mesmo quando o preço líquido fica abaixo do fixo (ex.: 95% em
R$ 10 com fixo de R$ 1). O repasse `totalCents − commissionCents` fica
negativo e `postSale` lança `UnbalancedLedgerError` dentro da confirmação do
pagamento: o webhook falha para sempre, com dinheiro recebido e sem ingresso.
Regras:

- `createOrder` recusa o pedido (`VALIDATION`, "Desconto alto demais para este
  ingresso") quando, com bearer `ORGANIZER`, alguma linha tiver comissão por
  unidade maior que o preço líquido. Preço líquido 0 continua válido (comissão 0).
- A criação/edição do cupom avisa o organizador quando o desconto puder levar
  algum tipo de ingresso abaixo da taxa fixa vigente.
- A mesma guarda corrige um bug latente que já existe sem cupom (preço de
  tabela menor que a taxa fixa); `pagamentos-financeiro` trata isso como
  correção separada, antes deste pacote.
- Com bearer `BUYER` não ocorre (repasse = preço líquido ≥ 0).

### D2. Só dois tipos de desconto, ambos por unidade

- `PERCENT` (`percentBps`, 1–10000): `desconto = applyBps(preço, bps)`.
- `FIXED_PER_TICKET` (`amountCents`): `desconto = min(amountCents, preço)`.

Desconto fixo **por pedido** fica fora: exigiria ratear centavos entre
unidades e complicaria reembolso parcial futuro. Desconto nunca deixa preço
negativo. Ingresso já gratuito não recebe desconto. Em `PERCENT`, `applyBps`
arredonda o **desconto** meia-para-cima: o comprador ganha no meio centavo.

### D3. Escopo e regras do cupom

- Pertence a uma **organização**; opcionalmente restrito a um evento e a
  tipos de ingresso (tabela de junção). Sem restrição de tipo = todos os tipos
  pagos do evento.
- Código: `[A-Z0-9_-]{3,32}`, armazenado em maiúsculas, único por organização
  (comparação sem diferenciar maiúsculas).
- Validade (`validFrom`/`validUntil`), limite total de usos (`maxUses`),
  limite por comprador (`maxUsesPerUser`), ativo/desativado (`disabledAt`).
  Cupom já usado nunca é apagado: o banco impede (`onDelete: Restrict`), e
  desativar é o único caminho.
- Um cupom por pedido. Um **uso = um pedido**, não um ingresso.
- **Meia-entrada:** por padrão o cupom **não** se aplica a `HALF_PRICE`.
  Pendência jurídica: a legislação de meia-entrada se refere ao valor cobrado
  do público geral; um cupom público pode exigir que a meia acompanhe o
  desconto. Registrar em `docs/legal-review.md` antes de liberar cupons
  públicos. Não há impacto na cota de meia (ela conta ingressos, não valores).
  Até a revisão jurídica, a validação do cupom **recusa** (no pedido) e
  **avisa** (na criação) quando o preço líquido de um ingresso inteiro ficar
  abaixo do preço da meia do mesmo evento (ex.: cupom de 60%). Só conta quando
  é o cupom que leva o ingresso abaixo da meia: um tipo cujo preço de tabela já
  é menor que a meia mais barata não é afetado. Se a decisão
  for "meia acompanha o desconto", o cálculo por unidade já suporta, sem
  mudança no razão.

### D4. Contagem de usos sem corrida

Contadores no cupom, no mesmo padrão do estoque de ingressos.

**Definição exata** (verificada pela reconciliação por igualdade, sem
tolerância — o "excesso" é em relação a `maxUses`, nunca ao contador):

- `timesReserved` = número de pedidos `PENDING_PAYMENT` com o cupom.
- `timesRedeemed` = número de pedidos com o cupom que têm **≥ 1
  `IssuedTicket`**. Ingressos nunca são apagados, então isso cobre pedido
  gratuito, pago, pago com atraso, reembolsado e com chargeback, e exclui o
  pagamento tardio sem estoque (`LATE_PAYMENT_NO_INVENTORY`), que não emite
  ingresso e não consome uso. Contar por status do pedido quebraria nesse caso
  (ele passa a `REFUND_PENDING`/`REFUNDED` sem resgate).

**Onde cada contador muda** (e só aí, para não contar em dobro):

- `createOrder`: `timesReserved += 1`.
- `finalizePaidOrderTx` (guardado por `status = PENDING_PAYMENT`):
  `timesReserved -= 1`, `timesRedeemed += 1`. O pedido gratuito por cupom de
  100% passa por aqui porque `createOrder` já chama `finalizePaidOrderTx`;
  **não** há marcação de resgate à parte.
- `acquireLateInventoryTx` (só chamado com `!wasPaid`): `timesRedeemed += 1`
  sem checar `maxUses`; se ultrapassar, auditar `coupon.redeemed_over_limit`.
- `releaseOrderTx`: `timesReserved -= 1` somente quando a transição de fato
  ocorreu (`count = 1`).
- Reembolso e chargeback **não** devolvem o uso (mesma regra do estoque).

**Travas.** A ordem é **Event → Order → Coupon**: o caminho de pagamento já
trava Event → Order antes de `finalizePaidOrderTx`/`acquireLateInventoryTx`,
então o cupom é sempre a **trava-folha** — nunca travar Order ou Event depois
de um cupom. Cupom de organização (`eventId = null`) é compartilhado entre
eventos, e uma mesma transação pode tocar vários cupons (`createOrder` libera
o pedido pendente anterior com o cupom C1 e cria o novo com C2;
`releaseExpiredForEventTx`, `expireStaleOrders` e `cancelEvent` liberam vários
pedidos). Para não haver deadlock, cada transação trava **todos** os cupons
envolvidos de uma vez, antes de qualquer incremento:
`SELECT id FROM "Coupon" WHERE id IN (…) ORDER BY id FOR UPDATE`. Um `UPDATE`
atômico do contador sozinho não resolve (também segura a trava até o commit).
Documentar a ordem em `orders.ts`.

Custo aceito no MVP: a trava de um cupom de organização serializa as compras
com ele em todos os eventos da organização.

**Limites.**

- `CHECK` no banco: contadores ≥ 0. O limite `reserved + redeemed ≤ maxUses`
  é garantido no serviço e **não** como `CHECK`, porque o pagamento tardio
  precisa honrar o preço que o comprador já pagou mesmo se o cupom esgotou
  nesse intervalo.
- Limite por comprador (`maxUsesPerUser`): contar, sob a trava do cupom, os
  pedidos do usuário com o cupom em `PENDING_PAYMENT` **e** na família paga
  (`PAID`, `REFUND_PENDING`, `REFUNDED`, `DISPUTED`) — senão o comprador
  compra, pede reembolso e usa de novo. Contar **depois** de liberar o pedido
  pendente anterior do mesmo usuário (que `createOrder` já faz), senão o
  próprio pedido substituído conta.

### D5. Link rastreado = registro + redirecionamento + atribuição no pedido

- `TrackingLink` por evento: nome interno, código curto público, UTMs
  (`source`, `medium`, `campaign`, `content`, `term`) e contador de cliques.
  Valores de UTM são truncados ao tamanho da coluna (200) antes de gravar.
- Rota pública `GET /r/[code]`: incrementa cliques, grava cookie
  primário `eb_attr` (id do link + UTMs, `httpOnly`, `sameSite=lax`,
  7 dias, último clique vence) e redireciona para `/eventos/[slug]`.
  UTMs soltos na URL do evento (sem link cadastrado) também são aceitos.
- Na criação do pedido, a atribuição é copiada para o `Order` (instantâneo
  imutável). Link de outro evento é ignorado. Nenhum dado pessoal no cookie.
- Opcional na v1: o link pode **pré-aplicar um cupom** (campo
  `couponId`), base para links de comissário na fase seguinte.

> **LGPD:** cookie de atribuição é de medição própria, sem dado pessoal e sem
> terceiros. Validar com a revisão jurídica se precisa de consentimento.

### D6. Permissões (sem papel novo)

- Criar/editar/desativar cupons e links: `event:write`
  (OWNER, ADMIN, EVENT_MANAGER), sempre via `assertOrgPermission` /
  `assertEventPermission` e com `audit()` na mesma transação.
- Relatórios de cupom e de origem: `finance:read`.

## Proposta de schema (para `banco-de-dados`)

Somente proposta; `prisma/schema.prisma` e migrações são do `banco-de-dados`.
Revisada por `banco-de-dados` (comentário no PR #14); `prisma validate` será
rodado na implementação.

**Regras de exclusão.** Onde há histórico, `onDelete: Restrict`: o banco
impede apagar cupom ou link já usado, e a desativação (`disabledAt` /
`archivedAt`) é o único caminho. `Event → Order` já é `Restrict` e organização
nunca é excluída, então `Cascade` em cupom/link não traria ganho. Exceções:
`CouponTicketType` (junção sem histórico próprio) fica `Cascade`, e
`TrackingLink.couponId` fica `SetNull` (o pedido guarda a cópia do cupom).

**Mesmo tenant no banco.** FKs compostas, declaradas no `schema.prisma` (uma
FK escrita só no SQL seria removida pelo próximo `migrate dev`):

- `Event @@unique([id, organizationId])`; `Coupon(eventId, organizationId)` e
  `TrackingLink(eventId, organizationId)` referenciam `Event(id, organizationId)`.
- `Coupon @@unique([id, organizationId])`; `Order(couponId, organizationId)`
  referencia `Coupon(id, organizationId)`.
- Com `organizationId` obrigatório, `SetNull` numa FK composta tentaria anular a
  organização; por isso essas FKs são `Restrict`.
- Fica no serviço (e na reconciliação): `TrackingLink.couponId` da mesma
  organização (FK simples por causa do `SetNull`), `Order.trackingLinkId` do
  mesmo evento do pedido e `CouponTicketType` com tipos do evento do cupom.

**Textos não confiáveis.** UTMs vêm de URL/cookie; nomes e códigos vêm de
formulário. Todos com tamanho máximo (`VarChar`).

```prisma
enum DiscountType {
  PERCENT
  FIXED_PER_TICKET
}

// Event (acréscimo): @@unique([id, organizationId]) — alvo das FKs compostas.

model Coupon {
  id             String       @id @default(cuid())
  organizationId String
  eventId        String?      // null = todos os eventos da organização
  code           String       @db.VarChar(32) // ^[A-Z0-9_-]{3,32}$
  description    String?      @db.VarChar(200)
  discountType   DiscountType
  percentBps     Int?         // PERCENT
  amountCents    Int?         // FIXED_PER_TICKET
  validFrom      DateTime?    @db.Timestamptz(3)
  validUntil     DateTime?    @db.Timestamptz(3)
  maxUses        Int?         // null = ilimitado
  maxUsesPerUser Int?         @default(1) // null = ilimitado; default é decisão de produto
  timesReserved  Int          @default(0)
  timesRedeemed  Int          @default(0)
  disabledAt     DateTime?    @db.Timestamptz(3)
  createdById    String
  createdAt      DateTime     @default(now()) @db.Timestamptz(3)
  updatedAt      DateTime     @updatedAt @db.Timestamptz(3)

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  event        Event?             @relation(fields: [eventId, organizationId], references: [id, organizationId], onDelete: Restrict)
  ticketTypes  CouponTicketType[]
  orders       Order[]
  links        TrackingLink[]

  @@unique([organizationId, code])
  @@unique([id, organizationId]) // alvo de Order(couponId, organizationId)
  @@index([eventId])
}

model CouponTicketType {
  couponId     String
  ticketTypeId String

  coupon     Coupon     @relation(fields: [couponId], references: [id], onDelete: Cascade)
  ticketType TicketType @relation(fields: [ticketTypeId], references: [id], onDelete: Cascade)

  @@id([couponId, ticketTypeId])
}

model TrackingLink {
  id             String    @id @default(cuid())
  organizationId String
  eventId        String
  code           String    @unique @db.VarChar(16) // curto, público, aleatório
  name           String    @db.VarChar(120)
  utmSource      String?   @db.VarChar(200)
  utmMedium      String?   @db.VarChar(200)
  utmCampaign    String?   @db.VarChar(200)
  utmContent     String?   @db.VarChar(200)
  utmTerm        String?   @db.VarChar(200)
  couponId       String?   // pré-aplica um cupom (opcional); organização checada no serviço
  clicks         Int       @default(0)
  archivedAt     DateTime? @db.Timestamptz(3)
  createdById    String
  createdAt      DateTime  @default(now()) @db.Timestamptz(3)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  event        Event        @relation(fields: [eventId, organizationId], references: [id, organizationId], onDelete: Restrict)
  coupon       Coupon?      @relation(fields: [couponId], references: [id], onDelete: SetNull)
  orders       Order[]

  @@index([eventId])
}

// Order (novas colunas — instantâneos imutáveis da compra)
//   couponId        String?
//   couponCode      String?  @db.VarChar(32)   // cópia do código usado
//   discountCents   Int      @default(0)       // Σ desconto × quantidade
//   trackingLinkId  String?
//   utmSource / utmMedium / utmCampaign / utmContent / utmTerm  String? @db.VarChar(200)
//   coupon        Coupon?       @relation(fields: [couponId, organizationId], references: [id, organizationId], onDelete: Restrict)
//   trackingLink  TrackingLink? @relation(fields: [trackingLinkId], references: [id], onDelete: Restrict)
//   @@index([couponId, userId])   // limite por comprador; cobre consultas só por couponId
//   @@index([trackingLinkId])
//   (sem índice por utmSource até o relatório existir e um EXPLAIN ANALYZE pedir;
//    o índice [eventId, status] existente já filtra por evento)
//
// OrderItem (novas colunas)
//   listUnitPriceCents    Int   // preço de tabela; = unitPriceCents quando sem cupom
//   discountPerUnitCents  Int   @default(0)
```

`CHECK`s propostos:

- `Coupon`: `timesReserved >= 0 AND timesRedeemed >= 0` (pegam decremento
  duplo em `releaseOrderTx`/`finalizePaidOrderTx`);
  `maxUses IS NULL OR maxUses > 0`; `maxUsesPerUser IS NULL OR maxUsesPerUser > 0`;
  `(discountType = 'PERCENT' AND percentBps BETWEEN 1 AND 10000 AND amountCents IS NULL) OR (discountType = 'FIXED_PER_TICKET' AND amountCents > 0 AND percentBps IS NULL)`;
  `validUntil IS NULL OR validFrom IS NULL OR validUntil > validFrom`;
  `code ~ '^[A-Z0-9_-]{3,32}$'` (cobre maiúsculas e formato).
  Sem `CHECK` de `maxUses` contra os contadores (D4); reduzir `maxUses` abaixo
  do uso atual é aceito e só bloqueia novos usos.
- `TrackingLink`: `clicks >= 0`; formato do `code` (ex.: `code ~ '^[A-Za-z0-9]{6,16}$'`).
- `OrderItem` (novo `OrderItem_discount`): `discountPerUnitCents >= 0 AND unitPriceCents = listUnitPriceCents - discountPerUnitCents`.
  Com o `unitPriceCents >= 0` já existente, implica desconto ≤ preço de tabela.
- `Order`: `discountCents >= 0 AND (couponCode IS NOT NULL OR discountCents = 0)`
  e `("couponId" IS NULL) = ("couponCode" IS NULL)` (código copiado se e só se
  houver cupom; com `Restrict`, `couponId` nunca vira nulo).
- `discountCents = Σ discountPerUnitCents × quantity` envolve duas tabelas e
  fica na reconciliação (`ORDER_DISCOUNT_MISMATCH`).

**Migração escrita à mão** (`migrate dev --create-only` e edição). O SQL gerado
pelo Prisma (`ADD COLUMN "listUnitPriceCents" INTEGER NOT NULL` sem default)
falha em tabela com linhas. Ordem:

```sql
ALTER TABLE "OrderItem" ADD COLUMN "discountPerUnitCents" INTEGER NOT NULL DEFAULT 0; -- só metadados (PG 11+)
ALTER TABLE "OrderItem" ADD COLUMN "listUnitPriceCents" INTEGER;
UPDATE "OrderItem" SET "listUnitPriceCents" = "unitPriceCents";
ALTER TABLE "OrderItem" ALTER COLUMN "listUnitPriceCents" SET NOT NULL;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_discount" CHECK (...);
```

`Order.discountCents INTEGER NOT NULL DEFAULT 0` dispensa backfill. O `UPDATE`
mexe só em `OrderItem`; os gatilhos do razão e da auditoria não são afetados.
Em tabelas grandes no futuro: `ADD CONSTRAINT … NOT VALID` + `VALIDATE
CONSTRAINT`, para não segurar `ACCESS EXCLUSIVE` durante a varredura.

**Ordem de deploy (opção a).** Com `listUnitPriceCents` obrigatório e sem
default, o cliente gerado exige o campo no `create`, então a etapa 1 não
compila sozinha. A etapa 1 já inclui a linha mínima em `createOrder`
(`listUnitPriceCents: unitPriceCents`), revisada por `pagamentos-financeiro`.
Descartada a opção (b), `DEFAULT` temporário: um INSERT que esquecesse o campo
gravaria preço de tabela 0 e violaria o `CHECK` só em produção.

**Seed.** Cupom `DEMO10` (10%) ligado por `CouponTicketType` só aos tipos que
não são `HALF_PRICE` (D3) e um link de exemplo num evento da Sonora Produções
(demo). O seed já detecta banco populado (#13). Quando `coupons.ts` existir, o
seed cria o cupom pelo serviço, como faz com pedidos. `banco-de-dados`
atualiza `docs/database.md` com os novos objetos e `CHECK`s na mesma migração.

## Mudanças de preço (para `pagamentos-financeiro`)

1. **`computeFees`** recebe por linha `listUnitPriceCents` e
   `discountPerUnitCents` opcionais e calcula comissão/taxa sobre
   `listUnitPriceCents - discountPerUnitCents`; devolve também
   `discountCents` total. Função pura nova `discountPerUnit(preço, cupom)`
   em `src/features/fees/` (testes unitários: arredondamento meia-para-cima de
   `applyBps`, cupom > preço, preço 0, 100%).
2. **`createOrder`** (`orders.ts`):
   - `createOrderSchema` ganha `couponCode?: string` (normalizado para
     maiúsculas) e `attribution?` (link/UTMs, preenchido pela Server Action a
     partir do cookie — nunca do corpo enviado pelo cliente sem validação).
   - Depois de travar o evento: buscar o cupom pela organização do evento,
     travar **todos** os cupons que a transação vai tocar (o do novo pedido e
     o do pedido pendente anterior que será liberado) com
     `WHERE id IN (…) ORDER BY id FOR UPDATE` (D4); liberar o pedido anterior;
     validar ativo, janela, evento, tipos, `maxUses` e `maxUsesPerUser`
     (contagem de D4); calcular o desconto por linha.
   - Recusar (`VALIDATION`) quando, com bearer `ORGANIZER`, alguma linha tiver
     comissão por unidade maior que o preço líquido (guarda B1, D1), e quando o
     preço líquido de uma inteira ficar abaixo do preço da meia do mesmo
     evento (D3).
   - Incrementar `timesReserved`. Erro genérico "Cupom inválido ou
     indisponível" para código inexistente, de outra organização ou desativado
     (não revelar qual).
   - Gravar instantâneos no `Order`/`OrderItem`; `audit` com `couponCode` e
     `discountCents`.
   - Pedido gratuito por cupom 100% segue o fluxo `FREE` atual; o resgate
     acontece só dentro de `finalizePaidOrderTx` (sem marcação extra).
3. **Contadores no ciclo do pedido:** exatamente os pontos listados em D4
   (`createOrder`, `finalizePaidOrderTx`, `acquireLateInventoryTx`,
   `releaseOrderTx`), sempre com o cupom travado por último (Event → Order →
   Coupon). `releaseExpiredForEventTx`, `expireStaleOrders` e `cancelEvent`
   travam de uma vez, ordenados por id, os cupons dos pedidos que liberam.
4. **Razão e reembolsos:** sem mudança de lançamentos (D1). Apenas o
   relatório de repasse passa a mostrar "descontos concedidos" a partir de
   `Order.discountCents`. Como `unitPriceCents` e `subtotalCents` passam a ser
   líquidos, qualquer relatório de "vendas brutas" deve dizer que é líquido de
   desconto ou usar `listUnitPriceCents`.
5. **Reconciliação:** `COUPON_COUNTERS_MISMATCH` por **igualdade exata** com
   as definições de D4 (`timesReserved` = pedidos `PENDING_PAYMENT` com o
   cupom; `timesRedeemed` = pedidos com o cupom e ≥ 1 `IssuedTicket`) e
   `ORDER_DISCOUNT_MISMATCH` (`discountCents = Σ discountPerUnitCents × quantity`).
   Também `COUPON_TENANT_MISMATCH`, para o que a FK não garante: link com
   cupom de outra organização, pedido com link de outro evento e
   `CouponTicketType` com tipo de outro evento.
6. Rate limit de tentativas de cupom: `rateLimit("coupon:<userId>", 10, 10 min)`
   na Server Action, contra força bruta de códigos.

## Divisão do trabalho

| Etapa | Agente | Entrega |
|---|---|---|
| 0 | `pagamentos-financeiro` | Correção separada, antes do pacote: guarda B1 em `createOrder` (comissão por unidade > preço com bearer `ORGANIZER`), que já pode ocorrer sem cupom |
| 1 | `banco-de-dados` | Migração escrita à mão (modelos, colunas, FKs compostas, `CHECK`s, backfill), seed `DEMO10` + link demo, `docs/database.md`; inclui a linha mínima `listUnitPriceCents: unitPriceCents` em `createOrder`, revisada por `pagamentos-financeiro` (ordem de deploy, opção a) |
| 2 | `pagamentos-financeiro` | `computeFees` + `discountPerUnit`, cupom em `createOrder`, contadores no ciclo do pedido, reconciliação, testes de integração (incl. concorrência no último uso) |
| 3 | `area-organizador` | Serviços `coupons.ts` e `tracking-links.ts` (CRUD com `event:write` + auditoria); telas em `/organizador/eventos/[id]/editar` (abas Cupons e Links) ; relatórios "uso de cupons" e "vendas por origem" em `/organizador/vendas` (`finance:read`); testes de autorização |
| 4 | `paginas-publicas` | Campo de cupom no checkout com resumo (preço de tabela, desconto, total); `OrderSummary` com linha de desconto; rota `/r/[code]` e captura de UTMs na página do evento; Server Action lê o cookie de atribuição |
| 5 | todos | E2E: link rastreado → compra com cupom → relatório mostra origem e desconto; reembolso não devolve uso |

Etapas 2 e 3 podem andar em paralelo depois da 1; a 4 depende da 2 (contrato de
`createOrder`).

## Testes que fecham o pacote

- Unitários: `discountPerUnit` e `computeFees` com desconto (arredondamento,
  100%, fixo maior que o preço, preço 0, meia-entrada excluída, preço líquido
  abaixo da taxa fixa, pedido misto com uma linha zerada pelo cupom e outra
  paga).
- Integração (`pagamentos-financeiro`): cupom válido/expirado/desativado/de
  outra organização/de outro evento/tipo não elegível; `maxUses = 1` com 10
  compras simultâneas → 1 sucesso; `maxUsesPerUser` contando pedido
  reembolsado (comprar → reembolsar → usar de novo é recusado); expiração
  libera o uso; pagamento tardio acima do limite é aceito e auditado;
  pagamento tardio sem estoque não consome uso; cupom 100% conta um único
  resgate; reembolso não devolve o uso; guarda B1 recusa desconto que deixaria
  o repasse negativo; inteira com cupom abaixo da meia é recusada; razão e
  reconciliação (contadores por igualdade exata) fecham com desconto.
- Concorrência: dois eventos da mesma organização com um cupom de organização
  compartilhado, compras simultâneas que trocam o pedido pendente de cada
  comprador entre cupons diferentes — sem deadlock e contadores exatos.
- Integração (`area-organizador`): CRUD com `event:write`; FINANCE e
  CHECKIN_STAFF negados; outra organização negada; cupom usado não pode ser
  apagado (só desativado); relatórios só de pedidos pagos e não reembolsados.
- E2E: fluxo completo descrito na etapa 5.

## Fora do escopo (fases seguintes)

- Comissários/promoters (links por pessoa, comissão no razão, papel ou
  convite próprio).
- Desconto fixo por pedido, cupom que desbloqueia tipo oculto, cupons
  combináveis, geração de cupons em lote.
- Recuperação de carrinho abandonado por e-mail.
