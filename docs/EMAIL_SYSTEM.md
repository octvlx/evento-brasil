# Sistema de e-mails transacionais — Evento Brasil

## Arquitetura e responsabilidade

A aplicação usa Next.js16/React19, autenticação própria com scrypt e sessões PostgreSQL, Prisma7 e um serviço único de envio em `src/server/email/`.

- `index.ts`: contrato `EmailAdapter`, provedor console e SDK oficial Resend. A lógica de pedidos/autenticação não importa o SDK.
- `templates.ts`: HTML com tabelas, estilos inline, identidade Evento Brasil, texto alternativo e conteúdo dinâmico escapado. Não há outro gerador de QR.
- `outbox.ts`: gravação cifrada, deduplicação, reserva de trabalho com lease, tentativas e estados de entrega persistidos.
- `events.ts`: eventos de compra, ingressos, cancelamento e reembolso conectados aos serviços financeiros existentes.
- `services/email-verification.ts` e `services/password-reset.ts`: provas de e-mail de uso único; os tokens não são armazenados em claro nas tabelas de autenticação.

`EmailOutbox` é a fonte operacional: reiniciar o servidor não perde uma mensagem que já foi confirmada no banco. A intenção de comunicação é gravada na mesma transação da operação de domínio. Uma falha no provedor ocorre depois do commit financeiro e não transforma o estado do pagamento.

## Configuração local sem domínio

No arquivo local ignorado pelo Git, mantenha as variáveis existentes e configure:

```dotenv
EMAIL_PROVIDER=console
RESEND_API_KEY=
EMAIL_REPLY_TO=
APP_BASE_URL=http://localhost:3000
EMAIL_VERIFICATION_EXPIRATION_MINUTES=30
PASSWORD_RESET_EXPIRATION_MINUTES=30
```

`APP_BASE_URL` prevalece sobre `APP_URL` quando definido. Use a URL e porta reais da aplicação nos dois valores quando ambos estiverem configurados. Isso também preserva os links e callbacks da autenticação existente. Não altere o `DATA_ENCRYPTION_KEY` de um banco com dados cifrados; ele protege também o conteúdo transitório da fila.

O console não envia mensagens reais nem exige domínio/API Key. Escreve arquivos `.html`, `.txt` e anexos em `.data/outbox/`, diretório local ignorado pelo Git. O terminal informa somente a referência/caminho da mensagem. Abra o HTML local para visualizar o e-mail e copiar seu botão de confirmação ou recuperação. Esses arquivos contêm links de acesso e ingressos: não publique nem compartilhe a pasta, e remova os artefatos locais após os testes. O modo console é recusado em produção.

### Windows/PowerShell

Na pasta da branch de implementação, com `DATABASE_URL` apontando para PostgreSQL de desenvolvimento:

```powershell
npm ci
npm run db:start
```

Mantenha o terminal do banco aberto. Em outro terminal, na mesma pasta:

```powershell
npm run db:status
npm run db:deploy
npm run dev
```

`db:deploy` aplica as migrações incrementais pendentes; não use `db:reset` nem `prisma migrate reset`. Se o status apontar banco remoto, interrompa a preparação local e confira a configuração. Não copie a URL de produção para estes passos.

1. Cadastre uma conta de teste por e-mail/senha. Ela começa com e-mail não confirmado.
2. Abra a mensagem console em `.data/outbox/` e siga o link completo.
3. Confirme explicitamente na página. Abrir a URL não consome o token por GET.
4. Tente reutilizar o link: a operação deve ser recusada.
5. Para recuperação, abra `/esqueci-minha-senha`, informe o endereço e veja a resposta genérica em `/email-enviado`.
6. Abra o novo e-mail local e use `/redefinir-senha#token=...` para definir uma senha de8a200caracteres. A confirmação encerra as sessões existentes e não autentica automaticamente nem confirma o e-mail da conta.
7. Com pagamento simulado no ambiente local, aprove um pedido pelos controles existentes. Somente a confirmação autoritativa no backend produz as mensagens de compra/ingressos. Pedidos grátis seguem o gate existente de revisão/termos antes da emissão.

Novas páginas públicas de autenticação permanecem disponíveis para pessoas não autenticadas ou com e-mail não confirmado. Compras e operações que exigem endereço verificado continuam protegidas no backend.

## Ativar Resend sem domínio próprio

1. Crie sua conta no [Resend](https://resend.com/) e gere uma API Key com permissão de envio adequada.
2. Guarde a chave exclusivamente no ambiente do servidor ou gerenciador de segredos. Não use `NEXT_PUBLIC_`, não a coloque em commits e não a cole em logs/PRs.
3. Em desenvolvimento, configure:

```dotenv
EMAIL_PROVIDER=resend
RESEND_API_KEY=preencher-no-ambiente-local
EMAIL_FROM="Evento Brasil <onboarding@resend.dev>"
EMAIL_REPLY_TO=
APP_BASE_URL=http://localhost:3000
```

`EMAIL_API_KEY` permanece aceito como nome legado; prefira `RESEND_API_KEY` em novas configurações. Reinicie o servidor após mudar o ambiente.

O remetente `resend.dev` é de testes: ele não autoriza envio irrestrito. A documentação do provedor restringe o destinatário ao e-mail autorizado da própria conta sem domínio verificado. Uma resposta403 é registrada como `RECIPIENT_OR_DOMAIN_UNAUTHORIZED`; confira a conta/destinatário ou verifique um domínio. Não tente contornar a restrição. Ver [restrição do domínio de testes](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

Nenhum teste automatizado dispara e-mail real. A entrega externa e a apresentação em caixas reais Gmail/Outlook precisam de validação controlada com uma conta autorizada antes do lançamento; os testes locais não comprovam entregabilidade.

## Domínio próprio e produção

1. Registre um domínio e adicione o domínio/subdomínio remetente no painel **Domains** do Resend.
2. Publique no provedor DNS os registros exatos indicados para aquele domínio: DKIM e SPF/Return-Path, incluindo MX quando solicitado para o subdomínio de envio. Não copie chaves/valores de outro domínio e não substitua o MX usado para receber e-mails da empresa.
3. Aguarde o painel confirmar a verificação. SPF e DKIM publicados não dispensam a validação pelo provedor.
4. Configure DMARC no domínio com política adequada ao ambiente. Comece pelo monitoramento quando necessário, acompanhe os relatórios e avance para políticas de rejeição somente após verificar alinhamento e todos os remetentes legítimos. Não crie um segundo registro SPF no mesmo nome: coordene o registro existente com o responsável pelo DNS.
5. Configure `EMAIL_FROM` usando endereço do domínio verificado e `EMAIL_REPLY_TO` como uma caixa real de suporte. Reply-To não substitui a autenticação do domínio remetente.
6. Configure `APP_BASE_URL`/`APP_URL` com a URL HTTPS de produção, credenciais reais restritas e execução periódica do processamento da fila.
7. Valide remetente, destinatário autorizado, rastreamento do envio, anexos e fluxos de recuperação com dados controlados. Desative rastreamento de cliques de mensagens de autenticação quando aplicável e revise tratamento/retensão de dados com o responsável jurídico.

A aplicação rejeita console, remetente de testes/placeholder, falta de chave quando Resend está selecionado e URL HTTP em produção. O fato de o endereço ter formato válido não prova que o DNS está correto: o Resend faz a verificação operacional. Referências: [domínios verificados](https://resend.com/docs/dashboard/domains/introduction) e [DKIM/SPF/DMARC no painel](https://resend.com/docs/dashboard/domains/introduction).

## Tokens, sessões e Google

- Verificação e recuperação usam valores aleatórios criptográficos de32bytes, hash HMAC no banco, expiração configurável de30minutos e consumo condicional na mesma transação da alteração de conta.
- Links de autenticação usam o fragmento `#token=...`, para o token não integrar a URL da requisição HTTP/log normal do servidor. A página faz uma ação POST explícita; scanners de e-mail não devem consumir a prova por GET.
- Reenvio invalida as provas anteriores quando aplicável. Mensagens de recuperação ainda enfileiradas são canceladas e seu conteúdo cifrado removido quando substituídas ou quando a senha é redefinida.
- Contas com identidade Google confiável preservam `emailVerifiedAt`, não recebem confirmação desnecessária e não são vinculadas automaticamente por coincidência de e-mail. Recuperação de senha não cria senha em contas exclusivamente Google.
- O fluxo de recuperação responde igualmente para endereço desconhecido, conta suspensa, conta Google ou solicitação limitada. Limites por endereço/origem são persistidos; a confirmação de senha também tem limite no servidor.
- Cabeçalhos de origem como `x-forwarded-for`/`x-real-ip` precisam ser sobrescritos pelo proxy confiável de produção. Não aceite cabeçalhos fornecidos diretamente por clientes como identidade confiável.

## Operação, logs e reprocessamento

A fila registra identificador, destinatário, template, provedor, ID externo, estado, tentativas, datas, código de erro seguro e leases. O corpo necessário à entrega é cifrado com AES-256-GCM; nunca grave senha, chave de API ou token em claro em metadados/auditoria. Remover conteúdo cifrado após sucesso reduz retenção. Conteúdo terminal/abandonado também tem limpeza posterior; isso é uma decisão operacional do sistema, não uma declaração de conformidade legal universal.

Estados:

| Estado | Significado |
|---|---|
| `QUEUED` | Aguardando envio ou próxima tentativa controlada |
| `PROCESSING` | Reservado por um worker com lease temporário |
| `SENT` | Provedor aceitou a mensagem; não comprova leitura ou entrega na caixa |
| `FAILED` | Erro permanente ou tentativas automáticas esgotadas |
| `CANCELLED` | Expiração, substituição ou recurso já inelegível |
| `UNKNOWN` | Situação ambígua que requer conferência humana antes de novo envio |

Workers reaproveitam o mesmo ID de mensagem/chave idempotente nas retentativas; o corpo enviado é preservado entre tentativas. O Resend conserva suas chaves por24horas. O sistema evita retries cegos de entregas antigas ambíguas; não prometa exatamente-uma-entrega ilimitada através de falhas e reinícios. Confira o provedor antes de reenviar um `UNKNOWN` ou de criar uma mensagem substituta. Ver [idempotência oficial](https://resend.com/docs/dashboard/emails/idempotency-keys).

Consulta operacional somente para administrador do banco em ambiente autorizado:

```sql
SELECT id, template, provider, status, "attemptCount", "providerMessageId",
       "createdAt", "sentAt", "failedAt", "errorCode"
FROM "EmailOutbox"
ORDER BY "createdAt" DESC
LIMIT 100;
```

Não devolva a fila nem o conteúdo cifrado por endpoints públicos. A manutenção existente (`POST /api/cron/maintenance`, cabeçalho `x-cron-secret`) pode processar a fila; ela também executa manutenção financeira, então use o banco de teste/desenvolvimento e o provedor simulado ao exercitá-la localmente. Nunca publique `CRON_SECRET` ou crie um endpoint público que aceite remetente/destinatário/corpo arbitrários.

`FAILED` exige investigação do código e da configuração. Erros temporários têm espera crescente e limite de tentativas. Corrija a configuração antes de reprocessar; preserve a chave idempotente quando ainda existir certeza dentro da janela do provedor. Não altere o estado financeiro para forçar entrega de e-mail.

## Trocar de provedor

Implemente `EmailAdapter` no serviço central e selecione-o na fábrica do servidor, mantendo o contrato de idempotência/erros e os templates/outbox. SES, Brevo e Postmark poderão ser conectados dessa forma. Não substitua o serviço por chamadas diretas dentro de cadastro, pedidos ou webhooks.

## Testes

Depois de gerar os tipos e com as variáveis de testes apontando para ambiente descartável:

```powershell
npx next typegen
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
```

A suíte de integração inicia PostgreSQL descartável quando `TEST_DATABASE_URL` não está definido. Se essa variável estiver definida, confira cuidadosamente o banco alvo: nunca utilize produção. A recuperação tem cobertura específica em `tests/integration/password-reset.test.ts`:

```powershell
$env:TEST_DB_PORT="5606"
Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
node node_modules/vitest/vitest.mjs run tests/integration/password-reset.test.ts
```

Asserções cobrem hash/expiração, consumo único concorrente, revogação de sessões, política de senha, respostas genéricas, limites e cancelamento de entregas antigas. Outros testes do serviço central cobrem console, erro Resend, outbox e eventos financeiros. Relate os resultados efetivamente executados na revisão, sem confundir testes com entrega real.
