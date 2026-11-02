# Dados pessoais e retenção (inventário + proposta)

Tarefa **L9a** do plano de conformidade com o Decreto nº 13.108/2026
(`docs/conformidade-decreto-13108.md`, requisito R9). Levantamento feito em
2026-10-27 sobre `main` @ `2d46458`, lendo `prisma/schema.prisma` e procurando
cada campo em `src/` (sem `src/generated`).

**Não é parecer jurídico.** Nenhum prazo legal foi decidido aqui: onde a lei
decide, a tabela diz **"a definir (jurídico)"** e lista as referências que o
jurídico deve conferir. Este documento alimenta a decisão **D6** (prazos de
retenção por tipo de dado) e o item "Campos de anonimização/retenção" do lote de
schema da Fase 2. Nenhuma migração foi criada.

## 1. Inventário de campos pessoais

Categorias: **ID** identificação · **CT** contato · **DOC** documento ·
**FIN** financeiro · **COMP** comportamento/registro (log, presença, histórico) ·
**CRED** credencial/segredo.

"Cifrado" = cifrado na aplicação (`encryptPII`, AES-256-GCM, chave
`DATA_ENCRYPTION_KEY`, `src/server/crypto.ts`). "Hash" = HMAC-SHA256 com
`AUTH_SECRET` (`hashToken`) ou hash de senha. O resto fica em claro no banco
(eventual criptografia em repouso do disco/provedor não é controlada pelo app).

### Contas e sessões

| Modelo.campo | Cat. | Finalidade | Quem lê no código | Proteção | Exportado / exibido a terceiros |
| --- | --- | --- | --- | --- | --- |
| `User.name` | ID | identificar o comprador/membro | `users.ts`, `/minha-conta`, admin `/admin/usuarios`, nomes de equipe em `checkin.ts` (`scannedBy.name`) e `organizers.ts` (membros) | claro | membros da organização veem nomes da equipe |
| `User.email` | ID, CT | login, notificações | `users.ts` (`authenticate`, `registerUser`), `/minha-conta`, `/admin/usuarios` (busca), `organizers.ts` (convites: compara com o e-mail do convite) | claro, `@unique` | — |
| `User.phone` | CT | contato opcional | `users.ts` (`updateProfile`), `/minha-conta` | claro | — |
| `User.passwordHash` | CRED | autenticação | `users.ts` (`authenticate`) | hash | — |
| `User.suspendedReason` | COMP | motivo de suspensão (texto livre do admin) | `users.ts` (`setUserSuspended`, também vai ao `AuditLog.metadata.reason`) | claro | — |
| `User.createdAt`/`updatedAt` | COMP | — | `/admin/usuarios` | claro | — |
| `Session.userId`, `lastSeenAt`, `createdAt`, `expiresAt` | COMP | sessão ativa | `src/server/auth/sessions.ts` | claro | — |
| `Session.userAgent` | COMP | identificar a sessão (até 300 caracteres) | gravado em `createSession`; **nenhuma tela lê hoje** | claro | — |
| `Session.tokenHash` | CRED | validar o cookie de sessão | `sessions.ts` | hash | — |

### Organizações e verificação de organizador

| Modelo.campo | Cat. | Finalidade | Quem lê no código | Proteção | Exportado / exibido |
| --- | --- | --- | --- | --- | --- |
| `Organization.name` | ID quando `legalType = INDIVIDUAL` (nome de pessoa física) | nome público do organizador | catálogo, página pública `/organizadores/[slug]`, eventos | claro | **público** |
| `Organization.contactEmail` | CT | contato com a plataforma | `organizers.ts`, telas de cadastro/configuração do organizador | claro | não aparece na página pública (`catalog.ts:220` não seleciona) |
| `Organization.contactPhone` | CT | idem | `organizers.ts`, formulário de cadastro | claro | não público |
| `Organization.websiteUrl`, `instagramHandle` | CT/ID (pessoa física) | perfil público | `catalog.ts`, `/organizadores/[slug]` | claro | **público** |
| `Organization.statusReason` | COMP | motivo de rejeição/suspensão (texto livre) | `organizers.ts` | claro | — |
| `Organization.paymentAccountExternalId` | FIN | conta do organizador no provedor de pagamento | `organizers.ts` (`connectPaymentAccount`) | claro | — |
| `OrganizerVerification.legalName` | ID | nome civil / razão social | `organizers.ts`, `/admin/organizadores`, `/organizador/configuracoes` | claro | admin |
| `OrganizerVerification.documentEncrypted` | DOC (CPF/CNPJ) | verificação do organizador | **só gravado** (`organizers.ts:27`); `decryptPII` não é chamado em lugar nenhum | **cifrado** | — |
| `OrganizerVerification.documentLast4` | DOC (parcial) | conferência visual | `/admin/organizadores`, `/organizador/configuracoes` | claro | admin e o próprio organizador |
| `OrganizerVerification.decisionNote` | COMP | justificativa do admin | `organizers.ts` | claro | — |
| `OrganizerVerification.submittedById`/`reviewedById` | COMP | quem enviou/revisou | `organizers.ts` | claro | — |
| `OrganizationMember.userId` + `role` | COMP | vínculo e papel | `organizers.ts`, `src/server/auth/permissions.ts` | claro | membros da organização |
| `OrganizationInvitation.email` | ID, CT (de quem ainda pode não ter conta) | convite de equipe | `organizers.ts` (convidar, listar pendentes, reenviar, aceitar/recusar); **copiado para `AuditLog.metadata.email`** em revogar/reenviar (`organizers.ts:340`, `:362`) | claro | membros com permissão de equipe |
| `OrganizationInvitation.tokenHash` | CRED | link do convite | `organizers.ts` | hash | — |
| `OrganizationInvitation.invitedById`/`acceptedById` | COMP | rastreabilidade | `organizers.ts` | claro | — |
| `EventStaffAssignment.userId`/`assignedById` | COMP | equipe de portaria | `organizers.ts`, `checkin.ts` | claro | — |

`Venue.addressLine`/`postalCode` normalmente são de estabelecimentos; só viram
dado pessoal se um organizador pessoa física usar endereço residencial. Fica
fora do inventário, com essa ressalva.

### Pedidos, ingressos e check-in

| Modelo.campo | Cat. | Finalidade | Quem lê no código | Proteção | Exportado / exibido |
| --- | --- | --- | --- | --- | --- |
| `Order.userId` | COMP | dono do pedido (histórico de compras) | `orders.ts`, `payments.ts`, `refunds.ts`, Meus pedidos | claro | — |
| `Order.buyerName` | ID | identificação do comprador no pedido | `orders.ts`, `payments.ts`, `tickets.ts` (padrão para o titular), `reports.ts` (vendas), `/organizador` (painel) | claro | **organizador** (lista de vendas) |
| `Order.buyerEmail` | ID, CT | e-mail de confirmação e ingressos | `notifications.ts` (`to:`), `tickets.ts`, `reports.ts` (`listAttendees` seleciona), `/admin/pagamentos` | claro | admin; organizador (consulta de participantes) |
| `Order.buyerPhone` | CT | contato opcional | só gravado em `orders.ts:216`; **nenhuma leitura** | claro | — |
| `Order.createdAt`/`paidAt`/`totalCents`… | FIN, COMP | prova da compra | serviços financeiros, relatórios | claro | organizador (valores) |
| `OrderItem.attendees` (JSON `{name, email}[]`) | ID, CT **de terceiros** (participantes que não são o comprador) | nominação de ingressos quando `requiresAttendeeInfo` | `orders.ts` (grava), `tickets.ts` (`attendeeAt`, copia para o ingresso) | claro | via `IssuedTicket` |
| `IssuedTicket.userId` | COMP | dono do ingresso (= comprador hoje) | `tickets.ts`, Meus ingressos | claro | — |
| `IssuedTicket.holderName` | ID | titular impresso no ingresso | `tickets.ts`, `src/server/tickets/pdf.ts`, `notifications.ts`, `checkin.ts` (leitor mostra o nome), `reports.ts`, `/organizador/participantes`, `/ingressos/[code]`, `/pedido/[orderId]` | claro | **CSV de participantes**, PDF, tela do leitor |
| `IssuedTicket.holderEmail` | CT | contato do titular | `tickets.ts`, `reports.ts`, `/organizador/participantes` | claro | **CSV de participantes** |
| `IssuedTicket.validationToken`/`code` | CRED | QR de entrada | `tickets.ts`, `checkin.ts` | claro (é o próprio segredo do QR) | PDF/e-mail |
| `IssuedTicket.checkedInAt`, `status` | COMP | presença no evento | `checkin.ts`, `reports.ts` | claro | **CSV de participantes** (`check_in`) |
| `TicketCheckin.ticketId`, `scannedAt`, `result` | COMP | histórico de leituras (presença do titular) | `checkin.ts` (histórico do leitor) | claro | equipe de portaria |
| `TicketCheckin.scannedById` | COMP (do funcionário) | quem leu | `checkin.ts` | claro | equipe |

### Pagamentos e financeiro

| Modelo.campo | Cat. | Finalidade | Quem lê no código | Proteção | Observação |
| --- | --- | --- | --- | --- | --- |
| `Payment.providerPaymentId` | FIN | liga ao pagamento no provedor (onde ficam os dados do pagador) | `payments.ts`, `refunds.ts`, webhook | claro | nenhum dado de cartão é guardado no schema |
| `Payment.pixCopyPaste`, `pixQrCodeBase64`, `checkoutUrl` | FIN | cobrança em andamento | `payments.ts`, `/checkout/[orderId]` | claro | dado de cobrança (recebedor, valor), útil só até expirar |
| `Payment.failureReason`, `providerRawStatus` | FIN | diagnóstico | `payments.ts`, admin | claro | — |
| `PaymentWebhookEvent.payload` (JSON) | FIN | idempotência e diagnóstico de webhooks | `payments.ts:286` (grava) | claro | Mercado Pago envia notificação com ids (`mercadopago.ts`); **conferir** se algum provedor manda dados do pagador no corpo |
| `Refund.requestedById`, `note` | COMP, FIN | quem pediu e justificativa (texto livre) | `refunds.ts`, admin | claro | `note` também vai ao `AuditLog.metadata` |
| `FinancialLedgerEntry.*` | FIN | razão de conciliação | `ledger.ts`, `reconciliation.ts` | claro, **somente inserção** (trigger) | não guarda dado pessoal direto (descrições fixas, `ledger.ts:80-127`); liga a `Order` → comprador |
| `OrganizerSettlement.providerReference` | FIN | repasse ao organizador | serviços financeiros | claro | organização, não comprador |
| `CommissionRule.createdById` | COMP | quem criou a regra | `commission.ts` | claro | admin |

### Auditoria

| Modelo.campo | Cat. | Finalidade | Quem lê | Proteção | Observação |
| --- | --- | --- | --- | --- | --- |
| `AuditLog.actorUserId` | COMP | quem fez | `/admin/auditoria` | claro, **somente inserção** (trigger `AuditLog_immutable`) | FK para `User` — impede apagar o usuário |
| `AuditLog.metadata` (JSON) | variável | contexto da ação | `/admin/auditoria` | idem | contém **e-mail de convidado** (`invitation.revoked`/`resent`) e **textos livres** (`reason`, `note`) que podem ter dado pessoal; não dá para corrigir depois |

### Fora do banco (para o mapa completo)

- **E-mail transacional:** destinatário, nome do titular e PDF do ingresso vão ao
  provedor de e-mail (adaptador Resend em `src/server/email/index.ts`). Em
  desenvolvimento as mensagens e anexos são gravados em `.data/outbox` e o
  console registra `para=<e-mail>`.
- **Rate limit:** em memória (`src/server/rate-limit.ts`), chaves com IP no
  cadastro (`register:<ip>`, `src/features/auth/actions.ts:15`) e id de usuário
  nas demais; nada persiste.
- **IP:** o banco **não guarda IP** em sessão, pedido nem auditoria. Ver §2,
  "registros de acesso".

## 2. Proposta de retenção por tipo de dado

Regra geral (LGPD art. 16): ao fim da finalidade o dado é eliminado, salvo
conservação para obrigação legal/regulatória ou exercício de direitos. Por isso
a proposta separa **o registro** (que pode precisar sobreviver) **dos
identificadores** (que podem ser anonimizados antes).

Referências que o jurídico deve conferir — **nenhuma foi adotada como prazo**:
legislação tributária e contábil (guarda de documentos fiscais/contábeis), CDC
(prazos de reclamação e prescrição), Código Civil (prescrição), Marco Civil da
Internet (registros de acesso a aplicações), regras do provedor de pagamento e
das bandeiras (disputas/chargeback), Decreto 13.108/2026 (histórico de
transferência ≥ 2 anos segundo as fontes de `docs/conformidade-decreto-13108.md`;
dados de auditoria do comercializador).

| Tipo de dado | Base legal / obrigação | Prazo proposto | Ao fim do prazo | Sobrevive à exclusão da conta? |
| --- | --- | --- | --- | --- |
| **Pedidos** (`Order`, `OrderItem`) — valores, datas, status | execução de contrato; obrigação fiscal/contábil e defesa em reclamações de consumo — **a definir (jurídico)** | a definir (jurídico), contado do fim do evento ou do último reembolso | **anonimizar** `buyerName`/`buyerEmail`/`buyerPhone`/`attendees`; manter valores, datas, status e ligações financeiras | **sim**, anonimizado (identificadores trocados por marcador) |
| **Pagamentos** (`Payment`) | idem + regras do provedor para disputas — a definir (jurídico) | a definir (jurídico) | manter; apagar `pixCopyPaste`, `pixQrCodeBase64`, `checkoutUrl` assim que o pagamento sai de `PENDING` (proposta técnica: no mesmo processo que expira o pedido) | sim (não contém identificador direto) |
| **Webhooks** (`PaymentWebhookEvent`) | idempotência e diagnóstico; nenhuma obrigação específica conhecida | proposta técnica: curto (ex.: enquanto houver chance de reenvio pelo provedor + janela de suporte) — **a definir com pagamentos-financeiro** | apagar `payload` (manter id externo para idempotência) ou apagar a linha | não depende da conta |
| **Razão** (`FinancialLedgerEntry`) e **repasses** (`OrganizerSettlement`) | obrigação contábil/fiscal — a definir (jurídico) | a definir (jurídico) | **manter** (somente inserção; não há identificador pessoal direto) | **sim** |
| **Reembolsos** (`Refund`) | defesa do consumidor e conciliação — a definir (jurídico) | mesmo prazo dos pedidos | manter; `note` é texto livre — anonimizar junto com o pedido se contiver dado pessoal | sim |
| **Ingressos** (`IssuedTicket`) | execução do contrato; prova de emissão — a definir (jurídico) | até o fim do evento para uso; registro pelo prazo dos pedidos | **anonimizar** `holderName`/`holderEmail` após o fim do evento + prazo de suporte; manter código, status e ligações | sim, anonimizado |
| **Check-ins** (`TicketCheckin`, `IssuedTicket.checkedInAt`) | interesse legítimo (controle de acesso, fraude, disputa "não entrei") — a definir (jurídico) | proposta: curto após o evento, alinhado à janela de disputa do pagamento — a definir | apagar as leituras ou desvincular `ticketId`; manter contagens agregadas por evento | não (comportamental) — salvo disputa aberta |
| **Transferências de titularidade** (futuro `TicketTransfer`) | **Decreto 13.108/2026: histórico ≥ 2 anos** segundo as fontes — confirmar no texto oficial | **≥ 2 anos** (mínimo das fontes) — prazo final a definir (jurídico) | após o prazo: anonimizar nomes/e-mails, manter o encadeamento | **sim** (obrigação do decreto) |
| **Auditoria** (`AuditLog`) | rastreabilidade exigida pelo decreto (auditoria do comercializador) e prestação de contas LGPD — a definir (jurídico) | a definir (jurídico) | manter; hoje **não dá para anonimizar** (trigger bloqueia UPDATE/DELETE) — ver §3.4 | **sim** (com `actorUserId` apontando para usuário anonimizado) |
| **Sessões** (`Session`) | execução do serviço; sem obrigação de guarda | proposta técnica: apagar na expiração (`expiresAt`) | **apagar** | não (apagar na exclusão — já há `onDelete: Cascade`) |
| **Registros de acesso (IP + data/hora)** | Marco Civil da Internet prevê guarda de registros de acesso por provedores de aplicação — **a definir (jurídico)** se e como se aplica | a definir (jurídico) | — | **hoje não são coletados**; decidir antes de lançar |
| **Convites** (`OrganizationInvitation`) | execução (gestão de equipe) | proposta técnica: apagar convites expirados/revogados/aceitos após período curto de suporte | **apagar** a linha (o fato do convite fica no `AuditLog`) | não |
| **Conta** (`User`) | execução do contrato | enquanto ativa; inativa: a definir (produto + jurídico) | **anonimizar** (não apagar: pedidos, ingressos e auditoria apontam para ela) | a linha sobrevive anonimizada |
| **Equipe** (`OrganizationMember`, `EventStaffAssignment`) | execução | enquanto vínculo existir | apagar o vínculo (já em cascata); histórico fica no `AuditLog` e em `TicketCheckin.scannedById` | não |
| **Organização** (`Organization`) | contrato com o organizador; obrigações fiscais dos repasses — a definir (jurídico) | a definir (jurídico) após encerramento | anonimizar contatos de pessoa física; manter nome/razão social ligado aos registros financeiros | sim (eventos e razão dependem dela) |
| **Verificação** (`OrganizerVerification`: CPF/CNPJ, nome civil) | KYC / identificação de quem recebe repasses; obrigação fiscal — a definir (jurídico) | a definir (jurídico) após encerramento da organização | apagar `documentEncrypted` (ou destruir a chave da versão); manter `documentLast4`, tipo e decisão se o jurídico exigir prova | a definir (jurídico) |
| **Reservas** (`TicketInventoryReservation`) | operacional | proposta técnica: junto com o pedido | sem dado pessoal próprio | — |
| **Pagamento simulado** (`SimulatedProviderPayment`) | só desenvolvimento | — | sem dado pessoal | — |

"Prazo proposto" técnico (sessões, convites, webhooks, PIX) é sugestão de
engenharia, não exigência legal; mesmo assim deve passar pelo jurídico junto
com D6.

## 2.1 Prazos provisórios em uso (L9b, 2026-11-02)

**Provisórios até a decisão D6 (jurídico).** Ficam em `src/server/retention.ts`;
mudar o valor ali muda o expurgo. Onde havia dúvida, o prazo ficou do lado de guardar
mais tempo o que pode servir de prova, e de apagar cedo o que é só operacional.

| Dado | Prazo provisório | O que acontece | Onde |
| --- | --- | --- | --- |
| Comprador do pedido (`buyerName`, `buyerEmail`, `buyerPhone`), participantes (`OrderItem.attendees`) e titular do ingresso (`holderName`, `holderEmail`) | **5 anos após o fim do evento** (prazo usual de guarda fiscal e de reclamação de consumo) | troca por marcador (`Conta excluída`, `excluido+<id>@anonimo.invalid`), marca `piiRedactedAt`; valores, datas e status ficam. Pedidos em `PENDING_PAYMENT`, `REFUND_PENDING` ou `DISPUTED` esperam | expurgo |
| Leituras do check-in (`TicketCheckin`) | **180 dias após o fim do evento** (janela de contestação do pagamento) | apaga as leituras; `IssuedTicket.checkedInAt` e o status ficam | expurgo |
| QR/copia e cola do PIX e link do checkout (`Payment`) | **24 h depois que o pagamento sai de `PENDING`** | apaga os três campos | expurgo |
| Corpo de webhooks (`PaymentWebhookEvent.payload`) | **180 dias** após o recebimento | vira `{}`; id externo fica para a idempotência | expurgo |
| E-mails transacionais encerrados (`EmailOutbox`) | **90 dias** após a criação | apaga a linha | expurgo |
| Convites de equipe aceitos, revogados ou vencidos | **90 dias** | apaga a linha (o fato fica no `AuditLog`) | expurgo |
| Sessões | ao vencer | apaga | expurgo |
| Tokens de senha e de verificação de e-mail, carrinhos sem pedido | **7 dias** após vencer | apaga | expurgo |
| Razão, repasses, auditoria, aceites de termos, histórico de transferências | **sem expurgo** até D6 | ficam como estão (tabelas só de inserção; transferência ≥ 2 anos pelo decreto) | — |

O expurgo roda no cron de manutenção (`/api/cron/maintenance`,
`src/server/services/retention-purge.ts`), em lotes de 200 e de forma idempotente.

### Exclusão pelo titular

`/minha-conta` → "Excluir minha conta" (`src/server/services/account-deletion.ts`).
Confirma com a senha, ou com o e-mail digitado em conta criada pelo Google. Fica
bloqueada enquanto houver: papel de admin da plataforma; propriedade de organização;
pedido aguardando pagamento, com reembolso em andamento ou em contestação; ingresso
válido para evento que ainda não terminou; transferência pendente; pedido de
cancelamento aberto. Na exclusão, numa transação:

- `User`: nome e e-mail viram marcador; celular, CPF, data de nascimento, vínculo
  com o Google e verificação de e-mail saem; senha aleatória; `status = SUSPENDED`;
  `anonymizedAt` preenchido. A linha fica (nunca `DELETE`).
- Pedidos do titular e ingressos de que ele é titular: anonimizados na hora, sem
  esperar os 5 anos. Ingresso comprado por ele mas transferido a outra pessoa
  mantém os dados do novo titular.
- Apagados: endereço, sessões, tokens, carrinhos sem pedido, vínculos de equipe,
  e-mails da fila para o endereço e convites abertos para o endereço.
- Ficam: histórico de transferências (só inserção), aceites de termos, auditoria
  (`user.anonymized` sem dado pessoal no `metadata`) e textos livres já gravados em
  pedidos de cancelamento e reembolsos.

## 3. O que falta para os direitos do titular e o expurgo (proposta para a Fase 2)

Proposta original (2026-10-27). A exclusão, o expurgo e os campos `anonymizedAt`/
`piiRedactedAt` foram feitos em L9b (§2.1). Continuam pendentes: `DataSubjectRequest`
(protocolo de pedidos do titular), expurgo de `OrganizerVerification` e de
organizações encerradas, anonimização do histórico de transferências e da auditoria
após o prazo legal (exige mudar os gatilhos) e a correção de e-mail verificada.

### 3.1 Bloqueios atuais no schema

- `Order.userId`, `IssuedTicket.userId`, `TicketCheckin.scannedById` e
  `AuditLog.actorUserId` referenciam `User` sem cascata: apagar um usuário com
  histórico falha. Além disso, o trigger `AuditLog_immutable` transforma o
  `SET NULL` em erro. **Conclusão: exclusão de conta = anonimização da linha
  `User`, nunca `DELETE`.**
- Os dados pessoais do pedido estão **copiados** (`buyerName`, `buyerEmail`,
  `holderName`, `holderEmail`, `attendees`): anonimizar o `User` sozinho não
  basta.
- `AuditLog.metadata` é imutável e já recebe e-mails e textos livres.
- Sessões expiradas só são apagadas quando o cookie volta
  (`sessions.ts:23`); não há rotina periódica.
- Nenhum campo registra quando/por que um registro foi anonimizado.

### 3.2 Campos propostos

| Modelo | Campo proposto | Uso |
| --- | --- | --- |
| `User` | `anonymizedAt DateTime?`, `deletionRequestedAt DateTime?` | estado da exclusão; login bloqueado quando preenchido; e-mail trocado por marcador único (ex.: `anon+<id>@invalid`) para manter o `@unique` |
| `Order` | `piiRedactedAt DateTime?` | marca pedidos já anonimizados (comprador e `attendees`) |
| `IssuedTicket` | `piiRedactedAt DateTime?` | idem para titular |
| `OrganizationInvitation` | — (expurgo apaga a linha) | — |
| `OrganizerVerification` | `documentPurgedAt DateTime?` | CPF/CNPJ apagado ao fim do prazo |
| `PaymentWebhookEvent` | `payloadPurgedAt DateTime?` (ou tornar `payload` opcional) | expurgo do corpo mantendo a idempotência |
| novo `DataSubjectRequest` | `id`, `userId`, `type` (EXPORT/CORRECTION/DELETION), `status`, `protocol`, `requestedAt`, `dueAt`, `completedAt`, `handledById`, `note` | protocolo e prazo de atendimento (LGPD art. 18 / art. 19), auditável |
| novo `RetentionRun` (opcional) | `id`, `job`, `startedAt`, `finishedAt`, `counts Json`, `error` | prova de que o expurgo rodou; alternativa: só `AuditLog` |

Índices para o expurgo achar candidatos sem varrer tudo: por exemplo
`Session(expiresAt)` (já existe), `Order(piiRedactedAt, …)` ou índice parcial
`WHERE "piiRedactedAt" IS NULL` combinado com a data do evento. Definir com
`EXPLAIN` sobre volume real antes de criar.

### 3.3 Serviços (L9b)

- **Exportar meus dados** (acesso/portabilidade): `User` + pedidos
  (comprador, itens, valores, status), ingressos (titular, status, check-in),
  reembolsos, vínculos de organização, convites recebidos, transferências
  (futuro). JSON legível por máquina; ação registrada no `AuditLog` sem o
  conteúdo.
- **Corrigir**: `name`/`phone` já existem em `updateProfile`; falta troca de
  e-mail verificada e correção de `holderName` de ingresso ainda não usado
  (cuidado: interage com a transferência, T-TRANSF).
- **Excluir/anonimizar**: bloquear se houver pedido `PENDING_PAYMENT`,
  `REFUND_PENDING`, `DISPUTED` ou ingresso válido para evento futuro (oferecer
  transferir ou reembolsar antes); depois, numa transação: anonimizar `User`,
  apagar `Session`, `OrganizationMember` e `EventStaffAssignment`, anonimizar
  `buyer*`/`attendees`/`holder*` dos pedidos e ingressos, gravar
  `AuditLog` (`user.anonymized`, sem dado pessoal no `metadata`). Membro único
  `OWNER` de organização precisa passar a propriedade antes.
- **Expurgo programado** (cron diário, idempotente, em lotes, só em produção
  com flag, registrando contagens): sessões expiradas; convites vencidos após
  o período de suporte; dados de cobrança PIX de pagamentos encerrados; payload
  de webhooks antigos; titular/comprador de eventos encerrados há mais que o
  prazo; check-ins antigos; CPF/CNPJ de organizações encerradas — cada prazo
  vindo de D6 por configuração, nunca fixo no código antes da decisão.

### 3.4 Auditoria imutável × LGPD

O trigger `AuditLog_immutable` deve continuar (é o que dá valor de prova). Para
não acumular dado pessoal impossível de corrigir:

1. **Agora (código, sem schema):** parar de gravar e-mail e texto livre no
   `metadata` — usar ids (`invitationId`, `refundId`) e manter o texto na
   tabela de origem, que pode ser anonimizada. Pedido para `area-organizador`
   (`organizers.ts:340`, `:362`) e `admin`/`pagamentos-financeiro` (`reason`,
   `note`).
2. **Fase 2, se D6 exigir apagar auditoria antiga:** permitir no trigger apenas
   `DELETE` de linhas com `createdAt` além do prazo legal, executado por um papel
   de banco próprio do expurgo; nunca `UPDATE`.

### 3.5 Exportações a terceiros

O CSV de participantes (`attendeesToCsv`, `src/server/services/reports.ts:216`;
rota `/api/organizador/eventos/[id]/participantes`) entrega código, nome,
e-mail, tipo, status, horário de check-in e pedido. A exportação é auditada
(`attendees.exported`). A política de privacidade e o contrato com o organizador
(D8) precisam dizer que o organizador vira controlador dessa cópia e por quanto
tempo pode mantê-la — **a definir (jurídico)**. Depois da anonimização, o CSV
deixa de trazer nome/e-mail dos ingressos anonimizados.

## 4. Achados para outros agentes (sem mudança neste PR)

- `Order.buyerPhone` é gravado e nunca lido — avaliar parar de coletar
  (minimização) — `pagamentos-financeiro` + `paginas-publicas`.
- `Session.userAgent` é gravado e nunca exibido — ou mostrar em "sessões
  ativas" em `/minha-conta`, ou parar de coletar.
- E-mail de convidado em `AuditLog.metadata` (§3.4) — `area-organizador`.
- O e-mail de desenvolvimento grava destinatário e PDFs em `.data/outbox`
  (`/.data` já está no `.gitignore`); garantir que esse adaptador nunca seja o
  ativo em produção.
- Registros de acesso com IP: hoje inexistentes; decidir com o jurídico se o
  Marco Civil exige e, se sim, onde guardar (tabela própria com prazo, não no
  `AuditLog` imutável).
