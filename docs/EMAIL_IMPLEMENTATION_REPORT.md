# Relatório de implementação — e-mails transacionais

Data: 30/10/2026. Decisão: READY FOR HUMAN REVIEW para revisão local. Não significa autorização de merge nem prontidão de envio real em produção.

## 1. Resumo das implementações

Serviço central com SDK oficial Resend e modo console local; HTML responsivo em português e alternativa textual; confirmação obrigatória de e-mail e recuperação segura de senha; fila PostgreSQL cifrada com deduplicação, leases, retentativas limitadas e reprocessamento operacional. Integrações com compra paga, ingresso/PDF existente, cancelamento, reembolso confirmado, convites de equipe, alterações de evento e transferência de titularidade.

As operações de domínio gravam suas mensagens na mesma transação. Falha de transporte não altera o estado financeiro. A fila revalida pedidos antes de renderizar confirmações/ingressos. Não foi criado um segundo gerador de ingresso/QR. Google, verificação prévia e a proibição de vinculação automática por e-mail foram preservados.

## 2. Arquivos modificados

- `.env.example`
- `.github/workflows/ci.yml`
- `docs/EMAIL_IMPLEMENTATION_REPORT.md`
- `docs/EMAIL_SYSTEM.md`
- `package-lock.json`
- `package.json`
- `prisma/migrations/20261030120000_transactional_email/migration.sql`
- `prisma/schema.prisma`
- `scripts/email-retry.ts`
- `scripts/email-status.ts`
- `scripts/email-worker.ts`
- `scripts/test-e2e.mjs`
- `src/app/api/cron/maintenance/route.ts`
- `src/app/email-enviado/page.tsx`
- `src/app/esqueci-minha-senha/page.tsx`
- `src/app/redefinir-senha/page.tsx`
- `src/features/auth/actions.ts`
- `src/features/auth/login-form.tsx`
- `src/features/auth/password-reset-actions.ts`
- `src/features/auth/password-reset-forms.tsx`
- `src/features/auth/verification-panels.tsx`
- `src/server/email/events.ts`
- `src/server/email/index.ts`
- `src/server/email/outbox.ts`
- `src/server/email/templates.ts`
- `src/server/env.ts`
- `src/server/services/cancellation.ts`
- `src/server/services/email-verification.ts`
- `src/server/services/event-changes.ts`
- `src/server/services/notifications.ts`
- `src/server/services/organizers.ts`
- `src/server/services/password-reset.ts`
- `src/server/services/refunds.ts`
- `src/server/services/tickets.ts`
- `src/server/services/transfers.ts`
- `src/server/services/users.ts`
- `tests/e2e/checkout-review.spec.ts`
- `tests/e2e/email-system.spec.ts`
- `tests/integration/email-outbox.test.ts`
- `tests/integration/password-reset.test.ts`
- `tests/unit/email-providers.test.ts`

## 3. Banco de dados

Migração aditiva: prisma/migrations/20261030120000_transactional_email/migration.sql. Acrescenta PasswordResetToken, EmailOutbox, EmailRateLimit, enum de entrega, índices e constraints. Não remove dados existentes. Aplicada com sucesso somente nos PostgreSQL descartáveis dos testes; não foi aplicada ao banco de desenvolvimento do usuário nem a produção. Não houve reset ou migração destrutiva.

Tokens são aleatórios, possuem hash na tabela de autenticação, expiração padrão de 30 minutos e consumo transacional único. O conteúdo transitório necessário ao envio é cifrado com a chave de dados existente. Sessões são revogadas após redefinição de senha.

## 4. Configuração necessária

Manter DATABASE_URL, AUTH_SECRET, DATA_ENCRYPTION_KEY e CRON_SECRET existentes. Para console: EMAIL_PROVIDER=console e APP_URL/APP_BASE_URL com a origem local correta. EMAIL_VERIFICATION_EXPIRATION_MINUTES=30 e PASSWORD_RESET_EXPIRATION_MINUTES=30 são padrões configuráveis. Para Resend: EMAIL_PROVIDER=resend, RESEND_API_KEY, EMAIL_FROM e, opcionalmente, EMAIL_REPLY_TO. EMAIL_API_KEY continua aceito por compatibilidade. Não use NEXT_PUBLIC_ para segredos e não troque a chave de cifragem de um banco existente.

## 5. Testes e resultados reais

- npm test: 65 arquivos, 507 testes passaram. Essa execução ocorreu antes dos três casos adicionais e da integração final dos avisos de transferência. Vitest retornou código 0, mas registrou aviso de timeout ao encerrar um worker de m-audit-log.test.ts; não houve teste reprovado.
- Verificação focada após as mudanças finais: 7 arquivos, 80 testes passaram, cobrindo provedores, outbox, recuperação, transferências, propriedade do e-mail e alterações relevantes. Inclui cadastro/prova/fila, retentativa manual e avisos de transferência.
- npm run test:e2e:isolated -- tests/e2e/email-system.spec.ts tests/e2e/checkout-review.spec.ts: 5 testes passaram no Edge, com banco descartável e provedor console. Cobriu primeira compra com verificação, endereço/CEP indisponível, atualização de preço, persistência de edição e recuperação com sessão revogada e replay bloqueado.
- npm run typecheck: passou. npm run lint: passou. npm run build: passou após a integração final.
- Migrações: as 12 migrações foram aplicadas ao banco E2E descartável.
- Template real de confirmação renderizado em 1000px e 390px no Edge, sem overflow horizontal; preview mobile inspecionado visualmente. Isso não certifica renderização em todos os clientes de e-mail.
- Resend foi testado com mock do SDK, incluindo anexos, Reply-To, idempotência e erros. Nenhum e-mail externo foi enviado.
- CI remota não executada: branch local sem push/PR. A configuração de CI usa valores fictícios e desativa o simulador somente no passo de build, mantendo as proteções de produção.

## 6. Problemas encontrados, correções e limites

Corrigidos durante a implementação: uso de chamada SQL incompatível com retorno void no advisory lock; parada indevida do worker atrás de mensagens expiradas; falta de conferência da posse do lease após renderização; mensagens de recuperação substituídas ainda pendentes; persistência da confirmação somente após criar a conta; falhas de enfileiramento de alterações de evento que poderiam ser ocultadas.

Revisão independente adicional: nenhum novo defeito confirmado em provider/outbox, cadastro/verificação, transferências, notificações/alterações e CI. A revisão não incluiu teste de carga da criação de um job por destinatário em eventos grandes.

Limites: não houve validação de entrega real, domínio/DNS, reputação, Gmail ou Outlook. A fila exige worker/cron supervisionado. SENT significa aceitação pelo provedor. A idempotência do Resend tem janela de 24 horas; o sistema interrompe novas tentativas automáticas após 23 horas em situações ambíguas e exige conferência operacional. Não há promessa de exatamente uma entrega ilimitada. Conteúdo cifrado terminal é removido após sete dias pelo worker; metadados e arquivos console precisam de política operacional de retenção.

O modo console gera arquivos locais que contêm links de acesso e anexos: estão ignorados pelo Git, são vedados em produção e devem ser protegidos/removidos após os testes. Cabeçalhos de IP precisam ser sobrescritos por um proxy confiável. A instalação inicial do SDK encontrou erro de certificado local; foi concluída usando a cadeia de certificados do sistema, sem desativar TLS.

## 7. Como testar localmente no Windows

1. Use este worktree ou a branch feature/transactional-email-system; não é preciso fazer merge em main.
2. Configure o arquivo .env local, ignorado pelo Git. Confira DATABASE_URL e execute npm run db:status antes de migrar; use exclusivamente seu PostgreSQL local de teste.
3. Se precisar, inicie npm run db:start em outro terminal. Execute npm ci, npm run db:deploy e npm run dev. db:deploy aplica a migração aditiva; não use reset.
4. Mantenha EMAIL_PROVIDER=console. Em outro terminal, execute npm run email:worker -- --watch.
5. Cadastre um e-mail novo, abra o HTML indicado pelo console em .data/outbox e confirme o endereço pelo botão. Antes da confirmação, confira o bloqueio de compra.
6. Abra /esqueci-minha-senha, solicite recuperação, abra o HTML local, defina uma senha nova e confirme que precisa autenticar novamente. Reutilize o link para conferir a recusa.
7. Faça uma compra com o provedor simulado local; confira confirmação, mensagem de ingressos e PDF. Exercite convite de equipe, transferência, cancelamento e reembolso com dados fictícios.
8. Consulte npm run email:status. Após corrigir uma falha elegível, use npm run email:retry -- ID_DA_MENSAGEM e execute o worker. Não reenvie UNKNOWN sem conferir o provedor.

Comandos detalhados, variáveis e diagnóstico: docs/EMAIL_SYSTEM.md. Se npm ci encontrar EPERM, encerre o servidor deste checkout antes de repetir a instalação.

## 8. Como ativar o Resend

Crie uma chave no painel Resend e coloque-a somente no ambiente do servidor. Em desenvolvimento sem domínio próprio, use EMAIL_FROM="Evento Brasil <onboarding@resend.dev>" e o destinatário permitido da própria conta, conforme as regras do provedor. Configure EMAIL_PROVIDER=resend, RESEND_API_KEY e a URL correta da aplicação; reinicie servidor e worker. Não há envio livre para usuários reais usando o domínio de teste. Faça o primeiro teste externo de forma controlada e confira o painel do provedor.

## 9. Status do Git

Branch: feature/transactional-email-system, baseada em main 40d9684. Commits locais anteriores: f0600f3 (infraestrutura), 013aed7 (recuperação), 4c8492d (falhas de rede), e6acd18 (cancelamento de entregas antigas), 0e8749d e 138716b (documentação). O fechamento acrescenta a integração final, testes, comandos operacionais e este relatório; consulte git log main..HEAD --oneline para os hashes finais. Sem push, PR, merge ou deploy desta feature.

## 10. Próximos passos para produção

Revisar e testar a branch local; autorizar publicação quando desejado. Com domínio próprio, verificar o domínio/subdomínio no Resend, publicar os registros DKIM/SPF/Return-Path solicitados sem prejudicar recebimento existente, configurar DMARC e usar remetente próprio. Definir HTTPS, segredos reais, proxy confiável, worker supervisionado, alertas sobre FAILED/UNKNOWN, retenção de dados e procedimento de suporte. Executar teste controlado de entrega e anexos em clientes reais e conferir CI após eventual push. Fazer backup e aplicar migrações de forma supervisionada no ambiente aprovado. Nenhum merge ou deploy foi realizado.
