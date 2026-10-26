# ADR 0002 — Cupons de desconto e links de venda rastreados

- Status: **proposto** (aguarda revisão de `banco-de-dados` e `pagamentos-financeiro`)
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
- Comissão e taxa de serviço incidem sobre o preço líquido. Um cupom de 100%
  gera pedido gratuito (fluxo `FREE` existente, sem comissão).
- O desconto sai da receita do organizador; a plataforma não subsidia cupom.

> **Pergunta para `pagamentos-financeiro`:** confirmar comissão sobre o preço
> líquido (proposta) em vez do preço de tabela. Cobrar sobre o preço de tabela
> faria um cupom de 100% gerar comissão sem receita.

### D2. Só dois tipos de desconto, ambos por unidade

- `PERCENT` (`percentBps`, 1–10000): `desconto = applyBps(preço, bps)`.
- `FIXED_PER_TICKET` (`amountCents`): `desconto = min(amountCents, preço)`.

Desconto fixo **por pedido** fica fora: exigiria ratear centavos entre
unidades e complicaria reembolso parcial futuro. Desconto nunca deixa preço
negativo. Ingresso já gratuito não recebe desconto.

### D3. Escopo e regras do cupom

- Pertence a uma **organização**; opcionalmente restrito a um evento e a
  tipos de ingresso (tabela de junção). Sem restrição de tipo = todos os tipos
  pagos do evento.
- Código: `[A-Z0-9_-]{3,32}`, armazenado em maiúsculas, único por organização
  (comparação sem diferenciar maiúsculas).
- Validade (`validFrom`/`validUntil`), limite total de usos (`maxUses`),
  limite por comprador (`maxUsesPerUser`), ativo/desativado (`disabledAt`;
  nunca apagar cupom já usado).
- Um cupom por pedido. Um **uso = um pedido**, não um ingresso.
- **Meia-entrada:** por padrão o cupom **não** se aplica a `HALF_PRICE`.
  Pendência jurídica: a legislação de meia-entrada se refere ao valor cobrado
  do público geral; um cupom público pode exigir que a meia acompanhe o
  desconto. Registrar em `docs/legal-review.md` antes de liberar cupons
  públicos.

### D4. Contagem de usos sem corrida

Contadores no cupom, no mesmo padrão do estoque de ingressos:

- Ao criar o pedido: `timesReserved += 1`. Pago: `timesReserved -= 1`,
  `timesRedeemed += 1`. Expirado/cancelado/pagamento recusado: `timesReserved -= 1`.
- Limite verificado com a linha do cupom travada. Ordem de travas passa a ser
  **Event → Coupon → Order** (documentar em `orders.ts`).
- `CHECK` no banco: contadores ≥ 0. O limite `reserved + redeemed ≤ maxUses`
  é garantido no serviço e **não** como `CHECK`, porque o caminho de pagamento
  tardio (`acquireLateInventoryTx`) precisa honrar o preço que o comprador já
  pagou mesmo se o cupom esgotou nesse intervalo (fica auditado como
  `coupon.redeemed_over_limit`).
- Reembolso **não** devolve o uso (mesma regra do estoque).
- Limite por comprador: contar pedidos `PENDING_PAYMENT`/`PAID` do usuário
  com o cupom, sob a trava do cupom.

### D5. Link rastreado = registro + redirecionamento + atribuição no pedido

- `TrackingLink` por evento: nome interno, código curto público, UTMs
  (`source`, `medium`, `campaign`, `content`) e contador de cliques.
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

```prisma
enum DiscountType {
  PERCENT
  FIXED_PER_TICKET
}

model Coupon {
  id             String       @id @default(cuid())
  organizationId String
  eventId        String?      // null = todos os eventos da organização
  code           String       // maiúsculas
  description    String?
  discountType   DiscountType
  percentBps     Int?         // PERCENT
  amountCents    Int?         // FIXED_PER_TICKET
  validFrom      DateTime?    @db.Timestamptz(3)
  validUntil     DateTime?    @db.Timestamptz(3)
  maxUses        Int?         // null = ilimitado
  maxUsesPerUser Int?         @default(1)
  timesReserved  Int          @default(0)
  timesRedeemed  Int          @default(0)
  disabledAt     DateTime?    @db.Timestamptz(3)
  createdById    String
  createdAt      DateTime     @default(now()) @db.Timestamptz(3)
  updatedAt      DateTime     @updatedAt @db.Timestamptz(3)

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  event        Event?             @relation(fields: [eventId], references: [id], onDelete: Cascade)
  ticketTypes  CouponTicketType[]
  orders       Order[]
  links        TrackingLink[]

  @@unique([organizationId, code])
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
  code           String    @unique // curto, público, aleatório
  name           String
  utmSource      String?
  utmMedium      String?
  utmCampaign    String?
  utmContent     String?
  couponId       String?   // pré-aplica um cupom (opcional)
  clicks         Int       @default(0)
  archivedAt     DateTime? @db.Timestamptz(3)
  createdById    String
  createdAt      DateTime  @default(now()) @db.Timestamptz(3)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  event        Event        @relation(fields: [eventId], references: [id], onDelete: Cascade)
  coupon       Coupon?      @relation(fields: [couponId], references: [id], onDelete: SetNull)
  orders       Order[]

  @@index([eventId])
}

// Order (novas colunas — instantâneos imutáveis da compra)
//   couponId        String?
//   couponCode      String?   // cópia do código usado
//   discountCents   Int       @default(0)   // Σ desconto × quantidade
//   trackingLinkId  String?
//   utmSource / utmMedium / utmCampaign / utmContent / utmTerm  String?
//   @@index([couponId]) @@index([trackingLinkId]) @@index([eventId, utmSource])
//
// OrderItem (novas colunas)
//   listUnitPriceCents    Int   // preço de tabela; = unitPriceCents quando sem cupom
//   discountPerUnitCents  Int   @default(0)
```

`CHECK`s propostos:

- `Coupon`: `timesReserved >= 0 AND timesRedeemed >= 0`;
  `maxUses IS NULL OR maxUses > 0`; `maxUsesPerUser IS NULL OR maxUsesPerUser > 0`;
  `(discountType = 'PERCENT' AND percentBps BETWEEN 1 AND 10000 AND amountCents IS NULL) OR (discountType = 'FIXED_PER_TICKET' AND amountCents > 0 AND percentBps IS NULL)`;
  `validUntil IS NULL OR validFrom IS NULL OR validUntil > validFrom`;
  `code = upper(code)`.
- `OrderItem`: `discountPerUnitCents >= 0 AND unitPriceCents = listUnitPriceCents - discountPerUnitCents`.
- `Order`: `discountCents >= 0 AND (couponCode IS NOT NULL OR discountCents = 0)`
  (desconto só com cupom; `couponId` pode virar nulo se o cupom for apagado,
  por isso a regra usa o código copiado).

Migração de dados: `listUnitPriceCents = unitPriceCents` e
`discountPerUnitCents = 0` para itens existentes (backfill na mesma migração,
antes do `CHECK`). Seed: um cupom `DEMO10` (10%) e um link de exemplo na
Sonora Produções (demo).

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
     travar a linha (`FOR UPDATE`), validar ativo, janela, evento, tipos,
     `maxUses`, `maxUsesPerUser`; calcular desconto por linha; incrementar
     `timesReserved`. Erro genérico "Cupom inválido ou indisponível" para
     código inexistente, de outra organização ou desativado (não revelar qual).
   - Gravar instantâneos no `Order`/`OrderItem`; `audit` com `couponCode` e
     `discountCents`.
   - Pedido gratuito por cupom 100% segue o fluxo `FREE` atual e já marca o
     uso como resgatado.
3. **`releaseOrderTx`**: se o pedido tem cupom, `timesReserved -= 1`.
   **`finalizePaidOrderTx`**: `timesReserved -= 1`, `timesRedeemed += 1`.
   **`acquireLateInventoryTx`**: `timesRedeemed += 1` sem checar limite e
   auditar `coupon.redeemed_over_limit` quando ultrapassar.
4. **Razão e reembolsos:** sem mudança de lançamentos (D1). Apenas o
   relatório de repasse passa a mostrar "descontos concedidos" a partir de
   `Order.discountCents`.
5. **Reconciliação:** nova verificação `COUPON_COUNTERS_MISMATCH`
   (`timesRedeemed` = pedidos pagos com o cupom, tolerando o excesso auditado;
   `timesReserved` = pedidos pendentes com o cupom) e
   `ORDER_DISCOUNT_MISMATCH` (`discountCents = Σ discountPerUnitCents × quantity`).
6. Rate limit de tentativas de cupom: `rateLimit("coupon:<userId>", 10, 10 min)`
   na Server Action, contra força bruta de códigos.

## Divisão do trabalho

| Etapa | Agente | Entrega |
|---|---|---|
| 1 | `banco-de-dados` | Migração (modelos, colunas, `CHECK`s, backfill), seed `DEMO10` + link demo |
| 2 | `pagamentos-financeiro` | `computeFees` + `discountPerUnit`, cupom em `createOrder`, contadores no ciclo do pedido, reconciliação, testes de integração (incl. concorrência no último uso) |
| 3 | `area-organizador` | Serviços `coupons.ts` e `tracking-links.ts` (CRUD com `event:write` + auditoria); telas em `/organizador/eventos/[id]/editar` (abas Cupons e Links) ; relatórios "uso de cupons" e "vendas por origem" em `/organizador/vendas` (`finance:read`); testes de autorização |
| 4 | `paginas-publicas` | Campo de cupom no checkout com resumo (preço de tabela, desconto, total); `OrderSummary` com linha de desconto; rota `/r/[code]` e captura de UTMs na página do evento; Server Action lê o cookie de atribuição |
| 5 | todos | E2E: link rastreado → compra com cupom → relatório mostra origem e desconto; reembolso não devolve uso |

Etapas 2 e 3 podem andar em paralelo depois da 1; a 4 depende da 2 (contrato de
`createOrder`).

## Testes que fecham o pacote

- Unitários: `discountPerUnit` e `computeFees` com desconto (arredondamento,
  100%, fixo maior que o preço, preço 0, meia-entrada excluída).
- Integração (`pagamentos-financeiro`): cupom válido/expirado/desativado/de
  outra organização/de outro evento/tipo não elegível; `maxUses = 1` com 10
  compras simultâneas → 1 sucesso; `maxUsesPerUser`; expiração libera o uso;
  pagamento tardio acima do limite é aceito e auditado; reembolso não devolve
  o uso; razão e reconciliação fecham com desconto.
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
