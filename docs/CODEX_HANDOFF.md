# Contexto para o Codex — Evento Brasil

Atualizado em 2026-11-04. Referência auditada: `cb77dc5` (main). Este documento registra o trabalho já integrado do Claude; não substitui AGENTS.md.

## Entregas integradas

| PR | Entrega | Pontos de entrada |
|---|---|---|
| #101 | Carrossel, municípios locais, autocomplete e cidade criada na transação do evento | `src/components/site/event-carousel.tsx`, `src/lib/municipalities.ts`, `src/server/services/cities.ts` |
| #102 | CEP no novo local do assistente | `src/server/services/postal-address.ts`, `src/features/organizer/event-wizard-steps.tsx` |
| #103 | Home compacta e busca contextual compartilhada com o header | `src/lib/search-query.ts`, `src/server/services/search.ts`, `search-ranking.ts`, `src/components/site/smart-event-search.tsx` |
| #104 | Encerramento por horário e cron como segunda camada | `src/lib/event-lifecycle.ts`, `src/app/api/cron/maintenance/route.ts`, `docs/encerramento-de-eventos.md` |
| #105 | Taxa da meia proporcional ao preço da meia | `src/features/fees/`, consultar diff do PR |
| #106 | Reserva de cota de meia-entrada, liberação por horário e auditoria | `src/features/half-price/`, `src/server/services/half-price.ts` |
| #107 | MFA TOTP, recuperação e exigência para admin/dono | `src/server/auth/mfa-policy.ts`, `totp.ts`, `sessions.ts`, `src/server/services/two-factor.ts` |

## Contratos importantes

- City já tinha `ibgeCode` opcional e único. Pesquisa não cria cidade. Autocomplete do cadastro recebe apenas municípios da UF selecionada; busca pública usa City com eventos elegíveis.
- A base IBGE continua provisória: os metadados identificam o espelho kelvins. Não afirmar que o arquivo foi baixado da API oficial.
- ViaCEP é consultado no servidor. CSP mantém `connect-src 'self'`.
- Busca pública: somente PUBLISHED, `endsAt > agora`, organização APPROVED. Selecionar sugestão apenas preenche; confirmar executa a navegação.
- Término comercial não revoga ingressos. Check-in conserva janela operacional de 12 h; pagamentos tardios distinguem reserva ativa de reserva já expirada.
- Cron exige `x-cron-secret` e precisa ser agendado na infraestrutura. O código sozinho não instala agendamento.
- MFA usa segredo cifrado e códigos de recuperação em hash. Sessão pendente não autentica. MFA_REQUIRED tem padrão habilitado em produção.
- Migrações #106 e #107 são aditivas; não editar migrações canônicas.

## Ambiente e cuidados

- Checkout principal contém alterações do usuário em package.json/lock, backups, `.codex/config.toml` e `my-mercadopago-app/`. Preservar inclusive arquivos staged.
- Trabalhar em branch e worktree; sem push na main, sem force-push, merge apenas autorizado explicitamente.
- `rateLimit` é async e persistido no banco.
- Antes de TypeScript numa worktree nova: gerar Prisma e executar `npx next typegen`.
- Não rodar build e e2e em paralelo na mesma worktree: build limpa `.next`, incluindo os arquivos do e2e isolado.
- Integração sobe banco descartável. Preferir porta livre via TEST_DB_PORT. Nunca resetar banco do usuário.
- A auditoria independente e suas limitações estão em `docs/audit-2026-11-04.md`.
- Os cinco achados da auditoria foram corrigidos na branch deste repasse: concorrência MFA, paginação completa da busca, rollback IBGE, HTTP 500 em erros parciais de reconciliação e atualização da proveniência sem alteração de municípios. Consultar os testes de regressão e o relatório antes de reabrir esses itens.
