# Deploy de produção: passo a passo

Checklist para colocar o QQPega no ar pela primeira vez e para cada nova versão.
A parte automatizável está no script de verificação; o resto é manual e vem marcado
com ☐. Visão geral da arquitetura e da segurança: `docs/production-readiness.md`.

```bash
npm run deploy:check -- --env-file=.env.production
```

O script confere as variáveis de produção e o banco, **nunca imprime valores**
(só nomes) e sai com código 1 se houver bloqueio. Use `--sem-banco` para conferir só a
configuração antes de o banco existir. Sem `--env-file`, usa as variáveis do ambiente
atual (por exemplo, dentro do provedor de hospedagem). Ele não lê o `.env` de
desenvolvimento por conta própria.

## 1. Contas e serviços (uma vez)

- ☐ **PostgreSQL 15+ gerenciado**, com backup automático, PITR e conexão TLS
  (`?sslmode=require` na `DATABASE_URL`). Banco exclusivo: **nunca** rode `db:seed`,
  `db:reset` nem `prisma migrate reset` nele.
- ☐ **Hospedagem Node 20.19+ com HTTPS** (Vercel, Render, Fly.io, Railway ou
  container próprio). O proxy deve sobrescrever `x-forwarded-for`/`x-real-ip`.
- ☐ **Bucket compatível com S3** com URL pública HTTPS (CDN ou bucket público) para as
  imagens. Disco local não serve: as imagens somem a cada deploy.
- ☐ **Resend** com o domínio do remetente verificado (SPF, DKIM e DMARC no DNS).
- ☐ **Mercado Pago**: aplicação de marketplace com OAuth. Siga
  `docs/payments-mercadopago.md` e o plano de teste com contas reais antes de abrir
  vendas.
- ☐ **Google OAuth** (opcional): callback `<APP_URL>/auth/google/callback`.
- ☐ **Carteiras digitais** (opcional): `docs/wallet.md`.

## 2. Variáveis de ambiente

Partindo de `.env.example`. Gere cada segredo separadamente: o script bloqueia
segredos repetidos.

| Variável | Produção |
| --- | --- |
| `NODE_ENV` | `production` (o provedor costuma definir) |
| `APP_URL` | URL pública HTTPS, sem barra no fim |
| `DATABASE_URL` | banco de produção com `sslmode=require` |
| `AUTH_SECRET` | ≥ 32 caracteres aleatórios: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `CRON_SECRET` | ≥ 24 caracteres aleatórios (mesmo comando) |
| `DATA_ENCRYPTION_KEY` | 32 bytes em base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `PAYMENT_PROVIDER` | `mercadopago` |
| `MERCADO_PAGO_CLIENT_ID` / `_CLIENT_SECRET` | da aplicação no painel |
| `MERCADO_PAGO_WEBHOOK_SECRET` | assinatura secreta dos webhooks no painel |
| `MERCADO_PAGO_TOKEN_ENCRYPTION_KEY` | 32 bytes em base64, **diferente** da `DATA_ENCRYPTION_KEY` |
| `MERCADO_PAGO_OAUTH_TEST_TOKEN`, `ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION` | `false` |
| `SETTLEMENT_ENABLED` | `true` só depois de validar a liquidação; desligado, os repasses são manuais |
| `EMAIL_PROVIDER` / `RESEND_API_KEY` | `resend` e a chave |
| `EMAIL_FROM` | remetente do domínio verificado, ex.: `QQPega <nao-responda@seudominio.com.br>` |
| `STORAGE_PROVIDER` e `OBJECT_STORAGE_*` | `s3`, bucket, chaves e URL pública HTTPS |
| `MFA_REQUIRED` | vazio ou `true` (2FA obrigatório para admins e donos de organização) |
| `PASSWORD_BREACH_CHECK` | vazio (ligado) |
| `ALERT_EMAILS` | e-mail(s) da equipe para alertas operacionais, separados por vírgula |

☐ **Guarde a `DATA_ENCRYPTION_KEY` e a `MERCADO_PAGO_TOKEN_ENCRYPTION_KEY` num cofre
fora da hospedagem.** Sem elas, CPF/CNPJ, segredos de 2FA e as credenciais dos
vendedores ficam ilegíveis, e não há como recuperar.

## 3. Primeira publicação

1. `npm run deploy:check -- --env-file=.env.production --sem-banco`: zero bloqueios.
2. `npm run db:deploy` com a `DATABASE_URL` de produção (só migrações; **nunca** seed).
3. `npm run cities:import` para importar os municípios do IBGE.
4. `npm run build` e `npm start` (ou o fluxo do provedor).
5. ☐ No site, cadastre a conta da pessoa responsável e confirme o e-mail.
6. `npm run admin:promote -- <e-mail>` torna essa conta superadministradora. Só
   funciona enquanto não existir outra e fica registrado na auditoria. Os próximos
   admins são criados pelo painel `/admin/usuarios`.
7. ☐ Entre no painel e ative o 2FA (é exigido no primeiro acesso).
8. `npm run deploy:check -- --env-file=.env.production` completo: zero bloqueios.

## 4. Integrações externas

- ☐ **Cron** a cada minuto: `POST <APP_URL>/api/cron/maintenance` com o header
  `x-cron-secret: <CRON_SECRET>`. Ele expira reservas, encerra eventos, envia a fila
  de e-mails e reprocessa webhooks. Sem o cron, nenhum e-mail sai. Também envia os
  alertas para `ALERT_EMAILS` (webhook parado, reembolso com falha aguardando o admin,
  pagamento para reembolso manual, e-mails com falha), no máximo 1 por problema a cada 6 h.
- ☐ **Monitor externo** (ex.: UptimeRobot) a cada 5 min: `GET <APP_URL>/api/cron/health`
  com o mesmo header. Responde 503 com problema crítico. Configure também o aviso de
  falha do próprio agendador do cron: se o cron parar, ninguém mais recebe alerta.
- ☐ **Mercado Pago**: redirecionamento OAuth `<APP_URL>/api/mercadopago/callback` e
  webhooks `<APP_URL>/api/webhooks/mercadopago`, com a mesma assinatura de
  `MERCADO_PAGO_WEBHOOK_SECRET`.

## 5. Teste depois do deploy

- ☐ Página inicial e busca carregam com HTTPS; imagens vêm do bucket.
- ☐ Cadastro novo recebe o e-mail de confirmação (remetente do domínio próprio, fora
  do spam).
- ☐ Organizador conecta o Mercado Pago, cria e publica um evento de teste.
- ☐ Compra real de valor baixo com PIX → ingresso emitido e e-mail com QR recebido →
  check-in no leitor (online e com a lista offline) → reembolso. Só com aprovação de
  quem responde pelo dinheiro.
- ☐ `/admin/pagamentos` sem webhooks pendentes.

## 6. A cada nova versão

1. CI verde no PR e merge no `main`.
2. `npm run deploy:check` com as variáveis de produção.
3. `npm run db:deploy` **antes** de subir o código novo (as migrações do projeto são
   aditivas, então a versão anterior continua funcionando com o banco migrado).
4. Publicar e repetir o item 5 no que a versão mudou.
