# Encerramento automático de eventos

Um evento está **encerrado** a partir do instante do seu término (`Event.endsAt <= agora`).
Há duas camadas independentes:

1. **Relógio, em tempo real (proteção principal).** Todo o backend compara `endsAt`
   com o relógio do servidor, sem depender do status gravado no banco nem do
   frontend. `endsAt` é um instante UTC, gravado a partir do horário local e do fuso
   do evento (`zonedLocalToUtc`), então eventos em outros fusos e eventos que
   atravessam a meia-noite terminam no instante certo.
2. **Job (cron).** `POST /api/cron/maintenance` grava `COMPLETED` nos eventos
   `PUBLISHED` cujo término chegou (`completeEndedEvents`). Se o job falhar ou
   atrasar, nada muda para o usuário: a camada 1 já trata o evento como encerrado.

Regra central: `src/lib/event-lifecycle.ts`.

| Função | Uso |
|---|---|
| `hasEventEnded(event, now)` | `endsAt <= now` |
| `effectiveEventStatus(event, now)` | `PUBLISHED` com término passado vale como `COMPLETED` |
| `checkinWindowOpen(event, now)` | portaria aberta até 12 h após o término (`CHECKIN_GRACE_MS`) |

## Onde a regra vale

| Área | Comportamento depois do término |
|---|---|
| Home, carrossel de destaques, `/eventos`, busca inteligente e sugestões, páginas de cidade, "Perto de você", fim de semana, sitemap | Não aparece (`publicEventWhere`: `endsAt > now`; ranking SQL com o mesmo filtro) |
| Página do evento `/eventos/[slug]` | Continua acessível (`PUBLISHED` ou `COMPLETED`), com o selo **Evento encerrado**, sem seletor de ingressos e sem ofertas no JSON-LD |
| Carrinho (`createCheckoutDraft`), reserva/pedido (`createOrder`), confirmação da revisão (`confirmCheckoutReview`), início do pagamento (`startPayment`) | Recusados com `SALES_CLOSED` ("Este evento já foi encerrado") |
| Área do organizador e admin | Evento fica na lista e nos relatórios com status **Encerrado**; não pode mais ser editado nem cancelado; pode ser arquivado |
| Check-in | Aceita entrada até 12 h depois do término, com o status `PUBLISHED` ou `COMPLETED`; depois disso responde `EVENT_NOT_ACTIVE`. O ingresso continua `VALID` |

## O que o encerramento NÃO faz

O job só altera `Event.status`. Pedidos, pagamentos, ingressos e QR Codes
(`validationToken`), check-ins, lançamentos do razão, comissões, reembolsos e
auditoria ficam exatamente como estavam (teste
`tests/integration/zo-event-completion.test.ts`). Não há reembolso, cancelamento
de pedido nem revogação de ingresso por causa do término.

## Pagamentos confirmados depois do término

- **Reserva ainda ativa** (o pagamento começou antes do término e o Mercado Pago
  confirma depois): o pedido é pago e os ingressos são emitidos normalmente.
  Pagamento legítimo nunca é cancelado.
- **Reserva já expirada:** o pagamento tardio só recupera estoque se o evento não
  terminou. Com o evento encerrado (com ou sem o job ter rodado), o pedido vai para
  `REFUND_PENDING` com reembolso `LATE_PAYMENT_NO_INVENTORY` — o mesmo fluxo já usado
  quando não há mais estoque. O dinheiro nunca é ignorado.

## Configurar o cron

O repositório não agenda nada sozinho: configure o agendador da hospedagem (Vercel
Cron, Render Cron Job, GitHub Actions, `cron` do servidor…) para chamar, **a cada
minuto** (precisa ser no máximo a cada 5 minutos; a cada minuto também mantém em dia
a expiração das reservas):

```bash
curl -fsS -X POST "$APP_URL/api/cron/maintenance" -H "x-cron-secret: $CRON_SECRET"
```

- `CRON_SECRET`: valor aleatório (a aplicação recusa iniciar em produção com
  `dev-only…`). Sem o header correto a rota responde 403.
- Cada etapa é idempotente; execuções repetidas ou simultâneas não têm efeito extra
  (o encerramento é um único `UPDATE … WHERE status = 'PUBLISHED' AND "endsAt" <= now`).
- Uma etapa que falha é registrada no log como `[cron] {"step": …, "error": …}`
  (sem headers nem segredos), não impede as demais, e a resposta sai com status 500
  e `failedSteps` para o agendador alertar.

## Testar localmente

```bash
npm run test:unit -- tests/unit/event-lifecycle.test.ts
npm run test:integration -- tests/integration/zo-event-completion.test.ts
```

Manualmente, com `npm run dev` e o banco local (`npm run db:start`):

1. Num evento publicado, coloque `startsAt`/`endsAt` no passado pelo Prisma Studio
   (`npx prisma studio`, só no banco local) ou espere ele terminar. Sem rodar o
   cron (status ainda `PUBLISHED`), o evento some da home e da busca, a página
   mostra "Evento encerrado" e a compra é recusada.
2. Rode o cron com o segredo do `.env`:

   ```bash
   curl -X POST http://localhost:3000/api/cron/maintenance -H "x-cron-secret: dev-only-cron-secret"
   ```

   A resposta traz `completedEvents` (quantos passaram a `COMPLETED`); rodar de
   novo devolve `0`.
