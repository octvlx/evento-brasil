# Deploy na Vercel

Complementa o `docs/deploy-producao.md` (variáveis, banco, testes pós-deploy). Projeto
`ticket24` no time **Ticket24** (plano Pro: o Hobby proíbe uso comercial e não roda
agendamento a cada minuto). Banco: Neon, branch `production`, em São Paulo
(`docs/database.md`).

## O que o repositório já configura

- `vercel.json`:
  - `regions: ["gru1"]`: as funções rodam em São Paulo, na mesma região do Neon;
  - `schedules.maintenance`: `POST /api/cron/maintenance` a cada minuto. A Vercel envia
    `Authorization: Bearer <CRON_SECRET>`; a rota aceita esse formato e também o
    `x-cron-secret` dos agendadores externos (`src/server/cron-auth.ts`). Não renomeie
    o agendamento: isso apaga o histórico e cria outro.
- `TRUSTED_PROXY_HOPS=0` (padrão): a Vercel sobrescreve o `x-forwarded-for` com o IP
  real do cliente (`src/server/client-ip.ts`).
- Sem `output: "standalone"`: ele só liga no build do Docker (`NEXT_STANDALONE=1`).

## Passo a passo

1. **Ligar a pasta** (uma vez): `vercel login` e `vercel link` (cria o
   `.vercel/project.json`, ignorado pelo Git).
2. **Ligar o GitHub** no painel: *Settings → Git → Connect Git Repository*, com o
   aplicativo da Vercel autorizado no repositório. Merge na `main` vira deploy de
   produção; cada PR ganha uma prévia.
3. **`.env.production` local**, a partir do `.env.example` (tabela do
   `docs/deploy-producao.md`). Valores próprios deste deploy: `APP_URL`, as duas URLs
   do Neon (`DATABASE_URL` pooled e `DATABASE_URL_UNPOOLED` direta), `EMAIL_FROM` do
   domínio verificado no Resend, `STORAGE_PROVIDER=s3` com o R2. Guarde uma cópia num
   gerenciador de senhas.
4. **Conferir:** `npm run deploy:check -- --env-file=.env.production --sem-banco`.
5. **Migrações no banco de produção**, do computador local e **antes** do primeiro
   deploy (o build consulta o banco):
   ```bash
   npx dotenv run -f .env.production --override -- npm run db:deploy
   npx dotenv run -f .env.production --override -- npm run cities:import
   ```
   Só migrações: nunca `db:seed` nem `db:reset` em produção. Não coloque migrações
   no comando de build da Vercel.
6. **Variáveis na Vercel**, ambiente **Production**: no painel (*Settings →
   Environment Variables*, colar o conteúdo do arquivo) ou pela CLI
   (`vercel env add <NOME> production`). A `DATABASE_URL_UNPOOLED` não é usada pelo
   app; pode ficar fora. Variáveis de Preview devem apontar para um banco que não
   seja o de produção.
7. **Versão do Node**: *Settings → General → Node.js Version*: 22.x ou mais nova.
8. **Deploy**: `vercel deploy --prod` (ou merge na `main` com o GitHub ligado).
9. **Domínio**: *Settings → Domains*, `ticket24.com.br` e `www`. Na Cloudflare, os
   registros que a Vercel indicar, com **DNS only** (nuvem cinza).
10. **Agendamento**: confira em *Schedules* que `maintenance` está ativo em produção
    e rode uma vez com `vercel schedules invoke maintenance`; a resposta da rota
    precisa ser 200. Monitor externo: `GET /api/cron/health` com `x-cron-secret`.
11. **Integrações e primeiro acesso**: itens 3.5 a 3.8, 4 e 5 do
    `docs/deploy-producao.md`. Para o admin:
    `npx dotenv run -f .env.production --override -- npm run admin:promote -- <e-mail>`.

## Nova versão

CI verde e merge na `main`. Se houver migração, rode o passo 5 **antes** do merge
(as migrações do projeto são aditivas).
