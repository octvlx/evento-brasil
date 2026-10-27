# Check-in — inventário e dependências

Responsável: agente `check-in`. Última revisão: inventário da área e correção do
vazamento de dados de titular em leituras de ingresso de outra organização.

## O que existe

| Funcionalidade | Onde | Estado |
| --- | --- | --- |
| Lista de eventos para check-in (PUBLISHED/COMPLETED até 12h após o término; OWNER/ADMIN/EVENT_MANAGER da organização ou CHECKIN_STAFF atribuído) | `/check-in`, `checkinEvents` em `src/app/check-in/page.tsx` | Pronto |
| Leitor com câmera (`jsqr`, 5 quadros/s, câmera traseira) e entrada manual; resposta verde/âmbar/vermelho, vibração, contadores | `/check-in/[eventId]`, `src/features/checkin/scanner.tsx` | Pronto |
| Server Action com limite de 120 leituras/min por operador e payload truncado em 200 caracteres | `src/features/checkin/actions.ts` | Pronto |
| Validação online atômica, seis resultados, toda leitura registrada em `TicketCheckin` | `checkInTicket` em `src/server/services/checkin.ts` | Pronto |
| Aviso "Meia-entrada — exigir documento comprobatório" ao admitir ou reportar DUPLICATE de ingresso `HALF_PRICE` (faixa preta/amarela, 2,2 s na tela — demais leituras 1,5 s; câmera e entrada manual). `ticketKind` nunca é devolvido para ingresso de outra organização (Decreto 13.108/2026, L7a) | `scanner.tsx`, `ticket.ticketKind` em `checkInTicket` | Pronto |
| Histórico de leituras (equipe vê só as próprias; organizador vê todas) | `checkinHistory`, seção "Últimas leituras" (15 itens) | Pronto |
| Permissões da portaria | `resolveCheckinAccess` em `src/server/auth/permissions.ts`; atribuição em `assignStaffToEvent` (área organizador) | Pronto |
| Formato do QR `EB1:<código 10 Crockford>:<token 256 bits base64url>` e emissão idempotente | `qrPayload`/`parseQrPayload`/`issueTicketsTx` em `src/server/services/tickets.ts` (área financeiro) | Pronto |
| Visualização do ingresso (QR só se VALID; "já utilizado"/"cancelado" nos demais; aviso de pagamento simulado e meia-entrada) | `/ingressos/[code]`, lista em `/meus-ingressos` | Pronto |
| PDF A5 por ingresso com QR (não gera para REVOKED: 410); faixa amarela "Meia-entrada: apresente o documento comprobatório" quando `kind` = HALF_PRICE — no download; o anexo do e-mail só terá o aviso quando `loadPdfTickets` (`notifications.ts`, financeiro) passar `kind` | `src/server/tickets/pdf.ts`, `/api/tickets/[code]/pdf`, anexo do e-mail em `notifications.ts` | Pronto (e-mail pendente) |

### Como as garantias são obtidas

- **Credencial do QR:** o código (10 caracteres, 50 bits) e o token (32 bytes
  aleatórios) são independentes e não sequenciais. A busca é pelo token
  (`validationToken @unique`) e o código precisa bater. O token fica **em claro**
  no banco, porque a página do ingresso, o PDF e o e-mail precisam remontar o QR
  (ver lacuna 2).
- **Atomicidade:** uma única transação `ReadCommitted` trava o evento e o pedido
  com `FOR KEY SHARE`, na mesma ordem usada por cancelamento, reembolso e
  chargeback (Event → Order → ingressos), e só então faz
  `UPDATE … WHERE status = 'VALID'`. A gravação em `TicketCheckin` acontece na
  mesma transação: se ela falhar, o ingresso continua VALID.
- **Idempotência/duplicidade:** uma segunda leitura cai em `count = 0` e reporta
  DUPLICATE com o horário original. Leituras simultâneas admitem exatamente uma.
- **Revogados/reembolsados:** o financeiro revoga o ingresso já na solicitação do
  reembolso, sob trava (PR #6). Como o check-in espera essa trava, a leitura vê
  REVOKED ou admite antes, e nunca os dois. O cancelamento do evento resulta em
  EVENT_NOT_ACTIVE.
- **Escopo da equipe:** CHECKIN_STAFF só acessa eventos com
  `EventStaffAssignment`; quem não é membro da organização recebe FORBIDDEN.
- **Evento errado:** se o ingresso é da mesma organização, a leitura é vinculada
  ao ingresso e mostra o titular. Se é de **outra** organização, a leitura é
  registrada sem `ticketId` e não mostra nenhum dado do ingresso.

### Cobertura de testes

- `tests/integration/e-f-checkin.test.ts`: admissão única e duplicidade; 8
  leituras simultâneas; rollback quando a gravação do registro falha;
  cancelamento e chargeback concorrentes com leituras (sem deadlock); evento
  errado, revogado e QR forjado/misturado; evento errado de outra organização;
  escopo da equipe; histórico por papel; evento cancelado.
- `tests/integration/g-h-refund-cancellation.test.ts` e
  `l-financial-integrity.test.ts`: reembolso × check-in (área financeiro).
- `tests/unit/domain-rules.test.ts`: `parseQrPayload`/`qrPayload`.
- `tests/e2e/purchase-checkin.spec.ts`: compra com PIX simulado → QR → entrada
  liberada → leitura duplicada → comprador vê o ingresso como utilizado.
- **Sem teste:** janela de 12h após o término (COMPLETED); listagem
  `/check-in` por papel; renderização do PDF; e2e de REVOKED/WRONG_EVENT; o
  limite de leituras por operador.

## O que falta (por prioridade)

1. ~~**Vazamento entre organizações em WRONG_EVENT.**~~ **Feito.** Ao ler um
   ingresso de outra organização, a portaria recebia o código, o titular e o
   tipo do ingresso, e a leitura ficava vinculada ao ingresso alheio. Assim,
   `checkinHistory` da organização errada expunha o nome do comprador.
2. **Token do QR em claro no banco.** Quem lê o banco (backup, réplica, acesso
   indevido) pode montar QRs válidos de todos os ingressos. Proposta, que exige
   mudança de schema (`banco-de-dados`) e de `tickets.ts` (`pagamentos-financeiro`):
   derivar o token como `HMAC(chave dedicada, ticket.id ‖ versão)`, sem guardá-lo,
   e guardar só `validationTokenHash` (único, para busca), com `tokenVersion` para
   reemitir o QR invalidando o anterior. A página, o PDF e o e-mail recalculam o
   token. `scripts/dev-ticket-qr.mjs` passa a calcular o HMAC.
3. **Permissão verificada fora da transação.** `resolveCheckinAccess` roda antes
   do `$transaction`. Se a atribuição for removida no meio da leitura, a leitura
   ainda pode admitir. A solução é verificar dentro da transação, depois de
   travar o evento. Não exige schema.
4. **Janela de abertura do check-in.** Hoje qualquer ingresso de evento
   PUBLISHED é admitido a qualquer momento, até semanas antes. A proposta é abrir
   N horas antes de `startsAt`: com uma constante não exige schema; por evento,
   exige uma coluna. A decisão é de produto.
5. **Ingressos de pagamento simulado** são admitidos sem aviso no leitor. A
   proposta é retornar `isSimulated` e mostrar "TESTE" no resultado (útil se
   `ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION` estiver ligado).
6. **Histórico:** só as últimas 15 leituras na tela, sem paginação, sem filtro
   por resultado e sem exportação CSV para o organizador. Faltam também um
   contador por resultado e entradas por hora.
7. **Limite de leituras em memória por processo** (`rate-limit.ts`). Com várias
   instâncias, o limite vira N × 120/min. O risco é baixo (o token tem 256 bits),
   mas o limite precisa ir para Redis/Postgres quando houver escala horizontal.
8. **Leitor:** sem som (útil em portaria barulhenta); o overlay fica fixo por
   2,2s; os contadores só atualizam após uma leitura; não há aviso de câmera
   lenta nem botão de lanterna.
9. **Testes:** cobrir a janela de 12h, a listagem `/check-in` por papel, o PDF
   (gera, não gera para REVOKED) e um e2e de ingresso reembolsado → REVOKED.

## Dependências de outros agentes

| Agente | O que precisamos |
| --- | --- |
| `banco-de-dados` | Lacuna 2: `IssuedTicket.validationTokenHash` (único) e `tokenVersion`, migração que preencha o hash dos ingressos existentes e depois remova `validationToken`. Lacuna 4 (opcional): `Event.checkinOpensMinutesBefore`. |
| `pagamentos-financeiro` | Dono de `tickets.ts` (formato e emissão do QR) e de `loadPdfTickets`. A lacuna 2 muda a emissão. A revogação no reembolso precisa continuar sob a trava Event → Order → ingressos, pois o check-in depende dessa ordem. |
| `area-organizador` | Atribui e remove a equipe do evento (`assignStaffToEvent`). A lacuna 3 depende de a remoção não precisar de outra trava. O CSV do histórico (lacuna 6) pode ser exibido no painel do evento. |
| `paginas-publicas` | `/meus-ingressos` e o layout compartilhado; `/ingressos/[code]` é desta área. |
| `admin` | Revogação administrativa (`revocationReason = ADMIN`) aparece como REVOKED no leitor. |
