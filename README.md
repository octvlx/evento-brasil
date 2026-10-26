# Evento Brasil (nome provisório)

Marketplace multi-organizador de descoberta e venda de ingressos para o Brasil —
pt-BR, BRL, web responsiva + PWA.

> **Estado atual:** MVP funcional em ambiente de desenvolvimento. Pagamentos usam
> um **provedor simulado** (claramente sinalizado). A integração real com o
> Mercado Pago está **desabilitada** até a verificação dos contratos de API —
> ver [`docs/payments-mercadopago.md`](docs/payments-mercadopago.md).

## Stack

Next.js 16 (App Router, Cache Components) · React 19 · TypeScript strict ·
Tailwind CSS v4 + componentes no padrão shadcn/ui · PostgreSQL 17 · Prisma 7
(`@prisma/adapter-pg`) · Zod 4 · React Hook Form · Vitest 5 · Playwright.
Decisões em [`docs/adr/0001-architecture.md`](docs/adr/0001-architecture.md).

## Como rodar

Pré-requisitos: Node.js 20.19+ (testado com 24.20) e npm.

```bash
npm install
cp .env.example .env            # valores "dev-only" funcionam localmente
```

Banco de dados — escolha um:

```bash
docker compose up -d            # com Docker
npm run db:start                # sem Docker: PostgreSQL real via embedded-postgres (deixe o terminal aberto)
```

Depois:

```bash
npm run db:deploy               # aplica as migrações
npm run db:seed                 # dados fictícios de demonstração
npm run dev                     # http://localhost:3000
```

> **Windows + caminho longo:** executáveis em caminhos com mais de 260
> caracteres não iniciam. `scripts/pg-local.mjs` contorna isso copiando os
> binários do PostgreSQL para `%TEMP%`; ainda assim, prefira manter o projeto em
> um diretório curto (ex.: `C:\dev\evento-brasil`).

### Contas de demonstração (somente desenvolvimento)

Senha de todas: `Demo@2026!` — domínio `@demo.eventobrasil.test`.
O login dessas contas é **recusado em produção** (`isDemoAccount`), e o seed se
recusa a rodar com `NODE_ENV=production`.

| E-mail | Papel |
| --- | --- |
| `admin@` | Administrador da plataforma |
| `produtora@` | Responsável pela "Sonora Produções (demo)" (aprovada) |
| `coletivo@` | Responsável pelo "Coletivo Ritmo (demo)" (aprovado) |
| `novo.organizador@` | Organização aguardando aprovação |
| `portaria@` | Equipe de check-in (atribuída à "Noite de Samba") |
| `cliente@` | Comprador com pedidos pagos, check-in e reembolso |

### Fluxo de compra em desenvolvimento

1. Entre como `cliente@`, abra um evento e selecione ingressos.
2. No checkout, gere o PIX (código `SIMULADO-NAO-PAGUE-…`).
3. No painel **Simulador de pagamentos**, clique em *Aprovar PIX*. Isso altera o
   estado no provedor fictício e envia um **webhook assinado** que passa pela
   mesma verificação → consulta ao provedor → confirmação usada em produção.
4. O pedido é confirmado, os ingressos são emitidos e o e-mail (com PDF) é
   gravado em `.data/outbox/`.
5. Para testar o leitor de check-in sem câmera:
   `node scripts/dev-ticket-qr.mjs <CÓDIGO>` e cole o conteúdo em
   `/check-in/<evento>`.

## Comandos

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Servidor de desenvolvimento |
| `npm run build` / `start` | Build e servidor de produção |
| `npm run lint` · `npm run typecheck` | ESLint · TypeScript |
| `npm run test:unit` | Testes unitários (sem banco) |
| `npm run test:integration` | Testes de integração — sobem um PostgreSQL próprio e descartável (porta 5434) |
| `npm run test:e2e` | Playwright contra `localhost:3000` com o banco do seed (usa o Microsoft Edge instalado; `PW_CHANNEL=chromium` para Chromium) |
| `npm run db:migrate` · `db:deploy` · `db:seed` · `db:status` · `db:reset` | Migrações, seed e estado do banco (ver `docs/database.md`) |
| `npm run cities:import` | Importa os ~5.570 municípios do IBGE (API oficial) |
| `POST /api/cron/maintenance` (header `x-cron-secret`) | Expira reservas vencidas e encerra eventos — agendar a cada minuto |

## Estrutura

```
prisma/                 schema, migrações (incl. CHECKs e trigger do razão), seed
src/app/                rotas (público, conta, checkout, organizador, check-in, admin, APIs)
src/features/           schemas Zod, Server Actions e componentes por domínio
src/server/services/    regras de negócio testáveis (pedidos, pagamentos, reembolsos, check-in, relatórios…)
src/server/payments/    adaptadores: simulado (dev) e Mercado Pago (desabilitado)
src/server/{auth,email,storage,tickets}/
src/lib/                utilidades puras (dinheiro, datas/fusos, CPF/CNPJ, rótulos pt-BR)
tests/unit|integration|e2e
docs/                   ADR, pagamentos, revisão jurídica, prontidão para produção
```

## Garantias implementadas

- **Sem overselling:** reserva com trava da linha do evento + `CHECK` no banco
  (`reservados + vendidos ≤ total`, nunca negativo). Testado com 40 compras
  simultâneas para 10 ingressos.
- **Emissão única:** `UNIQUE (orderItemId, sequence)` + webhooks idempotentes
  (`PaymentWebhookEvent` único por provedor/evento) + consulta ao provedor antes
  de confirmar. Redirect de checkout nunca confirma pagamento.
- **Preços/estoque/status nunca vêm do cliente.** O schema de pedido não aceita
  preço; o servidor recalcula tudo.
- **Pagamento tardio:** se a reserva expirou e ainda há estoque, o pedido é
  recuperado; senão, reembolso automático.
- **Razão financeiro imutável** (trigger bloqueia UPDATE/DELETE) e balanceado.
- **Check-in atômico:** `UPDATE … WHERE status='VALID'`; leituras repetidas →
  duplicado; outro evento, revogado e QR forjado são recusados.
- **Autorização no servidor** por organização/papel; equipe de check-in só em
  eventos atribuídos.
- **Comissão** em centavos com arredondamento half-up por unidade, versão da
  política gravada em cada pedido; gratuitos sem comissão.

## O que NÃO está pronto para produção

Ver [`docs/production-readiness.md`](docs/production-readiness.md) e
[`docs/legal-review.md`](docs/legal-review.md). Em resumo: integração real de
pagamentos/split/liquidação, verificação de e-mail, recuperação de senha,
limitação de taxa distribuída, nota fiscal/obrigações fiscais e revisão jurídica.
