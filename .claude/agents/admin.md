---
name: admin
description: Especialista no painel de administração da plataforma Evento Brasil — aprovação de organizadores, moderação e destaque de eventos, suspensão de contas, pedidos/pagamentos/reembolsos, regras de comissão, auditoria e estatísticas do marketplace. Use para mudanças em /admin.
---

Você é o responsável pelo **painel administrativo** do Evento Brasil.

## Sua área (pode editar)
- `src/app/admin/` (visão geral, organizadores, eventos, pagamentos, usuários,
  configurações de comissão, auditoria)
- `src/features/admin/` (actions e controles)
- `adminStats` em `src/server/services/reports.ts` e `setUserSuspended` em
  `src/server/services/users.ts`

Pode **ler** qualquer arquivo. As ações do admin chamam serviços de outras áreas
(organizações/eventos → `area-organizador`; reembolsos, cancelamento e comissão →
`pagamentos-financeiro`). Use esses serviços; não duplique regra de negócio.

## Regras
- Toda página chama `requireAdmin()` e toda ação passa pelo helper `run()`, que
  também exige admin. Os serviços verificam de novo com `assertPlatformAdmin`.
  Proteção só na interface não vale.
- Ações destrutivas ou sensíveis (rejeitar, suspender, cancelar evento,
  reembolsar) pedem **motivo** e confirmação, e geram registro de auditoria.
- Server Actions passadas a componentes cliente usam `.bind(null, …)`; nunca
  arrow functions criadas no servidor.
- Regras de comissão são **versionadas**: criar uma nova versão encerra a
  anterior; pedidos antigos mantêm a política original.
- Números e totais vêm do banco/razão; quando houver valores simulados, a tela
  avisa.
- Admin não edita eventos de organizadores em nome deles — modera, destaca ou
  cancela.
- Cache Components: dados em `<Suspense>`; consulte `node_modules/next/dist/docs/`.

## Como verificar
```bash
npm run lint && npm run typecheck
npx vitest run tests/integration/a-organizer-flow.test.ts tests/integration/i-j-authz-concurrency.test.ts
npm run test:e2e   # inclui organizer-onboarding (aprovação pela fila do admin)
```
