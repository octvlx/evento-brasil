# ADR 0001 — Arquitetura inicial do Evento Brasil

- Status: aceito
- Data: 2026-10-26

## Contexto

Marketplace multi-organizador de descoberta e venda de ingressos para o Brasil
(pt-BR, BRL). Precisa de transações financeiras confiáveis, controle de estoque
sem overselling, autorização por organização e um caminho claro para integrar
um provedor de pagamentos real (Mercado Pago proposto).

## Decisões

1. **Monólito modular em Next.js 16 (App Router) + TypeScript strict.**
   Páginas e Server Actions na mesma aplicação. A regra de negócio fica em
   `src/server/services/*` como funções puras sobre um cliente Prisma
   (`Db`), sem dependência de HTTP — isso permite testá-las em integração
   contra PostgreSQL real.
2. **PostgreSQL + Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`).**
   Integridade crítica também é garantida no banco: `CHECK` de estoque
   (nunca negativo, nunca acima do total), `UNIQUE (orderItemId, sequence)`
   para emissão de ingressos (impede duplicidade mesmo com webhooks
   concorrentes) e trigger que bloqueia `UPDATE/DELETE` no razão financeiro.
3. **Concorrência de estoque:** a reserva ocorre numa transação que trava a
   linha do evento (`SELECT … FOR UPDATE`), verifica janelas, limites, cota de
   meia-entrada e capacidade, e incrementa `quantityReserved`. Serializa
   compras por evento — simples e correto para o MVP; pode evoluir para
   updates condicionais por tipo de ingresso se houver contenção.
4. **Autenticação própria com sessões em banco.** Senha com `scrypt`
   (`node:crypto`), token de sessão aleatório de 256 bits em cookie
   `httpOnly`; o banco guarda apenas o HMAC-SHA256 do token (pepper
   `AUTH_SECRET`). Escolhido em vez do Auth.js porque o provedor de credenciais
   do Auth.js exige sessões JWT e o produto precisa de revogação de sessão e
   suspensão de contas imediatas. Sem dependência extra.
5. **Autorização no servidor, escopada por organização.** `OrganizationMember`
   com papéis (`OWNER`, `ADMIN`, `EVENT_MANAGER`, `FINANCE`, `CHECKIN_STAFF`)
   mapeados para permissões em `src/server/auth/permissions.ts`. Equipe de
   check-in só acessa eventos com `EventStaffAssignment` explícito. Todo
   serviço recebe o ator e verifica permissão — a UI nunca é a barreira.
6. **Pagamentos via adaptador (`PaymentProviderAdapter`).**
   - `simulated`: provedor fictício para desenvolvimento, com estado próprio
     (`SimulatedProviderPayment`) e webhooks assinados (HMAC) que passam pelo
     mesmo endpoint e pela mesma lógica do provedor real. Pedidos e
     pagamentos simulados são marcados `isSimulated` e a UI exibe o aviso.
   - `mercadopago`: esqueleto **desabilitado** até que contratos de API
     (OAuth de marketplace, split, PIX, reembolsos, assinatura de webhook)
     sejam verificados na documentação oficial e com a conta comercial.
     Ver `docs/payments-mercadopago.md`.
   - Webhooks nunca são confiáveis por conteúdo: após verificar a assinatura,
     o sistema **consulta o status no provedor** (`getPayment`) e só então
     aplica a transição. Redirect de checkout nunca confirma pagamento.
7. **Dinheiro em centavos inteiros (`Int`)** e comissão calculada por unidade
   com arredondamento half-up determinístico em pontos-base. Cada pedido
   guarda a versão da política de taxas (`feePolicyVersion`).
8. **Razão financeiro interno (`FinancialLedgerEntry`)** de partidas dobradas,
   somente inserção, para conciliação. Não é custódia nem substitui o
   provedor licenciado; liquidação ao organizador fica desabilitada até o
   provedor real estar configurado.
9. **Ingressos:** emitidos apenas após confirmação verificada (ou pedido
   gratuito), cada um com token de validação aleatório de 256 bits. QR contém
   `EB1:<código>:<token>`; validação 100% online, com check-in atômico via
   `UPDATE … WHERE status = 'VALID'`.
10. **Adaptadores de infraestrutura:** e-mail (`console` em dev, gravando em
    `.data/outbox`; `resend` via HTTP em produção) e armazenamento de imagens
    (`local` em dev; `s3` compatível em produção).
11. **UI:** Tailwind CSS v4 com componentes no padrão shadcn/ui escritos em
    `src/components/ui` (`components.json` permite adicionar mais pelo CLI).
    Formulários com React Hook Form + Zod; o servidor revalida com o mesmo
    schema.
12. **Banco local:** `docker-compose.yml` para quem tem Docker. Neste ambiente
    de desenvolvimento não havia Docker, então `scripts/dev-db.mjs` sobe um
    PostgreSQL real com os binários oficiais distribuídos pelo pacote
    `embedded-postgres` (via `scripts/pg-local.mjs`). Os testes de integração
    sobem uma instância própria e descartável.
13. **Cache Components (Next 16) ativado:** todo acesso a banco/cookies fica
    dentro de `<Suspense>`; componentes públicos chamam `connection()` antes de
    usar a data atual.

## Consequências

- Uma única implantação (Node) + PostgreSQL. Um job agendado
  (`POST /api/cron/maintenance`) libera reservas expiradas; o mesmo
  processo também roda sob demanda antes de cada nova reserva do evento.
- A integração real de pagamentos e a liquidação exigem trabalho adicional
  verificado antes do lançamento comercial (ver `docs/production-readiness.md`).
