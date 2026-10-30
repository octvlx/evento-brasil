# Auditoria local — e-mails transacionais

Data: 30/10/2026. Decisão: **READY FOR HUMAN REVIEW para desenvolvimento local com console**. Sem autorização de merge/deploy.

## Ambiente e isolamento

O chat abriu em C:\Users\octav\.codex\worktrees\transactional-email-auth\evento-brasil, branch codex/transactional-email-auth. A branch solicitada foi localizada em **C:\Users\octav\.codex\worktrees\checkout-address-review\evento-brasil**, feature/transactional-email-system, inicialmente b61f76b. A árvore estava limpa antes desta auditoria. Foram lidas as instruções AGENTS.md aplicáveis, a documentação local Next.js e docs/EMAIL_SYSTEM.md.

O worktree da feature não possuía .env nem DATABASE_URL herdada. O .env do checkout principal aponta para localhost:5433/evento_brasil; isso comprova endereço local, mas não que seja banco descartável/exclusivo de teste. Ele não foi utilizado, conectado, migrado, recriado ou limpo.

Toda execução com escrita utilizou **um cluster PostgreSQL novo em pasta temporária exclusiva e porta livre de loopback**. DATABASE_URL foi injetada somente nos subprocessos, EMAIL_PROVIDER=console foi forçado e RESEND_API_KEY/EMAIL_API_KEY foram esvaziadas. Migrações/fixtures/seed foram aplicados somente nesses bancos novos. Não houve alteração de .env, configuração compartilhada, main ou banco existente.

Dependências já presentes e conferidas: Node 24.20.0, npm 11.19.0, Next 16.4.3, Prisma e @prisma/client 7.10.1, Resend 6.35.0. Não foi necessário reinstalar ou atualizar dependências. A configuração local precisa de DATABASE_URL, AUTH_SECRET, DATA_ENCRYPTION_KEY, CRON_SECRET e APP_URL/APP_BASE_URL coerentes; o sandbox gera valores próprios e temporários. Nenhuma chave real Resend foi utilizada.

## Problemas encontrados e correções

### MEDIUM — comandos operacionais não iniciavam

Arquivos: scripts/email-worker.ts, scripts/email-status.ts e scripts/email-retry.ts.

Reprodução confirmada no Windows com npm run email:worker: tsx produz saída CommonJS para esses .ts e falha com “Top-level await is currently not supported with the cjs output format”. A falha ocorre antes de conectar ao banco. Os três comandos possuíam await no nível superior.

Correção: execução assíncrona encapsulada em main(), mantendo try/finally, desconexão do Prisma e códigos de saída. Não foi alterado o tipo de módulo compartilhado do projeto. Erros de operação são resumidos sem imprimir segredos.

Validação: novo tests/integration/email-worker-cli.test.ts executa os três CLIs em processos reais, confirma status persistidos, retentativa elegível, recusa de retentativa de SENT e ausência de duplicação ao reiniciar o worker.

### MEDIUM — consulta redundante de e-mail em segundo plano nos testes

Arquivo: src/server/services/notifications.ts, notifyOrderPaid.

A suíte completa passou, mas registrou PrismaClientKnownRequestError no aviso assíncrono após pagamento. O hook chamava novamente enqueueOrderEmailsTx fora da transação, embora issueTicketsTx já persistisse as intenções de envio. Essa consulta podia continuar enquanto os testes limpavam suas fixtures.

Correção: o hook apenas inicia o processamento da fila já persistida; testes processam a fila explicitamente. Foram removidas a consulta redundante e a impressão de exceção bruta nesse hook. A intenção de envio continua transacional com o pagamento. Não foi alterada a confirmação financeira nem a emissão do ingresso.

Validação posterior: 34 testes de pagamento, outbox, checkout e CLI passaram; o log dessa execução não contém PrismaClientKnownRequestError/PrismaClientUnknownRequestError. A primeira compra no navegador também passou novamente.

### Aviso remanescente

A suíte completa retornou código 0 e 511 testes aprovados, mas o Vitest avisou “Timeout terminating forks worker” para tests/integration/m-audit-log.test.ts. O mesmo aviso já constava na implementação anterior. Não foi confirmado defeito funcional do sistema de e-mails a partir desse aviso. O encerramento do pool de testes merece investigação separada; não foi mascarado por alteração de timeout/configuração compartilhada.

## Testes realizados e resultados

| Verificação | Resultado |
|---|---|
| Suíte completa Vitest | 66 arquivos, 511 aprovados, 0 reprovados, 0 pendentes |
| Regressões após correção do hook | 4 arquivos, 34 aprovados, sem o erro Prisma observado anteriormente |
| Navegador — confirmação, recuperação e checkout | 5 aprovados no Microsoft Edge |
| Navegador após correção do hook — primeira compra | 1 aprovado novamente |
| npm run typecheck | Aprovado |
| npm run lint | Aprovado |
| prisma validate | Schema válido; sem conexão a banco existente |
| Migrações em cluster novo | 12 migrações aplicadas com sucesso |
| Worker/status/retry em processos reais | Aprovado; 2 SENT e 1 CANCELLED, sem duplicação após reinício |
| Sandbox com aplicação e worker --watch | Iniciou; GET /entrar retornou 200; encerramento dos processos próprios verificado |

A suíte de 511 testes foi executada antes do último ajuste de notifyOrderPaid. As 34 regressões e a repetição da primeira compra foram executadas após esse ajuste. Não foram somados esses números como se fossem casos distintos.

Cobertura observada: confirmação com hash, expiração e consumo único; recuperação com resposta genérica, limites, expiração, concorrência e revogação de sessões; manutenção da política Google; pagamentos autoritativos e geração do PDF existente; convites, cancelamento, reembolso e transferências; conteúdo cifrado; dedupe; retentativas; recuperação de lease; mensagens expiradas/ambíguas e status persistidos. SENT no console significa geração de artefato local, não entrega a uma caixa postal.

Relatórios locais ignorados pelo Git: .data/email-audit-vitest.json, .data/email-audit-regressions.json, .data/email-audit-regressions.log e .data/email-audit-sandbox.log.

Não foi repetido build de produção nesta rodada: a regra foi manter console, e a validação de produção exige provedor real. As proteções não foram flexibilizadas. Next em desenvolvimento, TypeScript e Prisma foram verificados. CI remota não foi executada, pois não houve push.

## Instruções exatas — Windows/PowerShell

As dependências já estão instaladas neste worktree. Abra um terminal e execute:

~~~powershell
Set-Location "C:\Users\octav\.codex\worktrees\checkout-address-review\evento-brasil"
git branch --show-current
node scripts/email-sandbox.mjs --serve
~~~

1. A branch exibida deve ser feature/transactional-email-system. O worktree auxiliar transactional-email-auth não contém a integração final.
2. Abra a URL SANDBOX impressa no terminal. A porta muda a cada execução. Aplicação e worker já estarão ativos; não é necessário iniciar outro banco ou worker.
3. Cadastre uma conta nova em /registrar. Abra o HTML indicado por [email:console] em .data/outbox. Confirme pelo botão da página. Abrir o link sozinho não consome a prova.
4. Confira o bloqueio de compra antes da verificação e o prosseguimento após confirmar. Não modifique emailVerifiedAt diretamente.
5. Em /esqueci-minha-senha, solicite o link, abra o novo HTML, redefina a senha e confirme a exigência de novo login. Reutilize o link e confira a recusa.
6. Explore pedidos com cliente@demo.eventobrasil.test / Demo@2026! ou com sua conta fictícia nova. Use somente os controles de pagamento simulado. Confira HTML/texto e PDF em .data/outbox após confirmação do backend.
7. Ctrl+C encerra os processos iniciados pelo sandbox e remove somente seu cluster temporário. O banco existente em localhost:5433 fica intacto. Cada nova execução do sandbox começa com dados novos. Os artefatos console continuam em .data/outbox, ignorados pelo Git.

Para o teste automático dos comandos operacionais, sem deixar o servidor aberto:

~~~powershell
node scripts/email-sandbox.mjs
~~~

Para verificar também inicialização HTTP e encerrar automaticamente:

~~~powershell
node scripts/email-sandbox.mjs --serve-check
~~~

Para repetir os cinco testes de navegador em banco próprio descartável:

~~~powershell
$env:EMAIL_PROVIDER="console"
$env:RESEND_API_KEY=""
$env:EMAIL_API_KEY=""
Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
npm run test:e2e:isolated -- tests/e2e/email-system.spec.ts tests/e2e/checkout-review.spec.ts
~~~

Nenhum desses passos exige db:reset, migrate reset, migração do banco existente, push ou merge. O sandbox injeta o ambiente nos seus subprocessos, sem criar .env ou exportar credenciais reais.

## Funcionalidades ainda dependentes de teste manual/externo

- Revisão humana da apresentação e dos fluxos no sandbox.
- Entrega real Resend, remetente, DNS/SPF/DKIM/DMARC, spam/bounces e apresentação em Gmail/Outlook: fora desta auditoria, sem credenciais e com console obrigatório.
- Apple/Google Wallet com credenciais reais e aparelhos físicos; o PDF existente e seu contrato foram exercitados pelos testes.
- Carga de eventos com muitos destinatários e supervisão contínua/alertas do worker em produção.

## Arquivos corrigidos/adicionados

- scripts/email-worker.ts
- scripts/email-status.ts
- scripts/email-retry.ts
- src/server/services/notifications.ts
- tests/integration/email-worker-cli.test.ts
- scripts/email-sandbox.mjs
- docs/EMAIL_SYSTEM.md
- docs/EMAIL_LOCAL_AUDIT.md
- docs/EMAIL_IMPLEMENTATION_REPORT.md (referência para este relatório posterior)

As correções permanecem exclusivamente em feature/transactional-email-system. Sem push, merge, deploy ou alteração de main.
