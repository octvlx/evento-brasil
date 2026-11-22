# Deploy no Google Cloud Run (e mudança depois para a Vercel)

Complementa o `docs/deploy-producao.md`, que continua valendo para variáveis, banco,
cron e testes pós-deploy. Este guia cobre o que muda ao hospedar no Cloud Run em
São Paulo (`southamerica-east1`), passo a passo, e como sair dele para a Vercel sem
migrar dados.

> Os comandos abaixo ainda não foram executados neste projeto. Confira cada passo no
> console do Google Cloud na primeira vez.

## Escolhas que deixam a mudança para a Vercel simples

| Peça | Use | Por quê |
| --- | --- | --- |
| Banco | **Neon**, branch `production` (`docs/database.md`), com `sslmode=require` | Funciona igual no Cloud Run e na Vercel. O Cloud SQL exigiria abrir o banco para a internet quando a Vercel entrar (ela não tem IP fixo nos planos comuns). |
| Imagens | **Cloudflare R2** (`STORAGE_PROVIDER=s3`) | As URLs públicas não mudam com a hospedagem. |
| E-mail | Resend | Igual nos dois. |
| Cron | Cloud Scheduler | Pode continuar chamando o site depois da mudança (ver o fim do guia). |

Confira que o projeto Neon está na região **São Paulo** (`aws-sa-east-1`): cada
consulta atravessa a distância entre o Cloud Run e o banco.

## Arquivos do projeto

- `Dockerfile`: imagem em 3 estágios com `output: "standalone"` (ligado só quando
  `NEXT_STANDALONE=1`, que o próprio Dockerfile define). Roda como usuário `node` na
  porta 8080.
- `.dockerignore`: tira `.env*`, `.data/`, `.git` e artefatos do contexto do build.
- `cloudbuild.yaml`: monta e publica a imagem no Artifact Registry.

O build do Next precisa do banco e das variáveis de produção (o CI faz o mesmo). Elas
entram como **segredo do BuildKit**, montado só durante o `npm run build`. O
`output: "standalone"` copia os arquivos `.env*` para `.next/standalone`; o Dockerfile
os apaga no mesmo passo e falha se sobrar algum, para nenhum segredo ir para a imagem.
Se mudar o Dockerfile, mantenha essa limpeza.

## IP do cliente (`TRUSTED_PROXY_HOPS`)

O limite de tentativas do login, do 2FA, da troca de senha e do checkout usa o IP do
cliente (`src/server/client-ip.ts`). Os proxies do Google **acrescentam** o IP real no
fim do `x-forwarded-for` e mantêm o que o cliente mandou antes; por isso o app lê da
direita para a esquerda.

| Como o tráfego chega | `TRUSTED_PROXY_HOPS` |
| --- | --- |
| Vercel (sobrescreve o cabeçalho) | `0` (padrão) |
| URL `*.run.app` direta | `0` |
| Load Balancer externo do Google → Cloud Run | `1` |

Com o Load Balancer, **feche a URL `*.run.app`**
(`--ingress=internal-and-cloud-load-balancing`). Se ela ficar aberta, quem a chamar
direto escolhe o próprio IP, porque o app pularia uma entrada que não é de proxy. O
passo 11 testa isso depois da publicação.

## Passo a passo

Tudo roda no **Cloud Shell** (o terminal do console, ícone `>_`): já vem com `gcloud`,
Node e Git, e o build é feito pelo Cloud Build, sem Docker na sua máquina.

### 0. Antes de começar

- ☐ Domínio registrado, com o DNS na Cloudflare.
- ☐ Neon: branch `production` e as duas URLs dela, `DATABASE_URL` (pooled, `-pooler`)
  e `DATABASE_URL_UNPOOLED` (direta, usada pelas migrações).
- ☐ Bucket R2 com chaves e URL pública HTTPS.
- ☐ Resend com o domínio verificado.
- ☐ Aplicação do Mercado Pago com OAuth (`docs/payments-mercadopago.md`).

### 1. Conta e projeto (no console)

1. Ative o faturamento em [console.cloud.google.com](https://console.cloud.google.com).
2. Crie o projeto (aqui, `ticket24-prod`).
3. Em **Faturamento → Orçamentos e alertas**, crie um alerta (ex.: US$ 50).
4. Abra o Cloud Shell.

### 2. Cloud Shell e serviços

```bash
gcloud config set project ticket24-prod
PROJECT=ticket24-prod; REGION=southamerica-east1
node -v    # 20.19 ou mais nova; senão: nvm install 24
git clone https://github.com/octvlx/evento-brasil.git && cd evento-brasil
```

Repositório privado: no lugar da senha, use um token do GitHub só de leitura.

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com compute.googleapis.com
gcloud artifacts repositories create ticket24 --repository-format=docker --location=$REGION
```

Os comandos seguintes usam `PROJECT` e `REGION`. Abriu um Cloud Shell novo? Defina as
duas de novo.

### 3. `.env.production`

```bash
cp .env.example .env.production && nano .env.production
```

Preencha pela tabela do `docs/deploy-producao.md`. Para este deploy:

- `APP_URL=https://ticket24.com.br`
- `TRUSTED_PROXY_HOPS=1` (Load Balancer na frente)
- `DATABASE_URL` e `DATABASE_URL_UNPOOLED` da branch `production` do Neon
- `EMAIL_FROM="TICKET24 <nao-responda@ticket24.com.br>"`
- `PAYMENT_PROVIDER=mercadopago`, `EMAIL_PROVIDER=resend`, `STORAGE_PROVIDER=s3`
- `QR_STATIC_ACCEPTED=false`
- Cada segredo gerado separadamente:
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
- Não defina `PORT`: o Cloud Run reserva essa variável.

**Guarde uma cópia do arquivo fora do Google** (gerenciador de senhas). Sem a
`DATA_ENCRYPTION_KEY` e a `MERCADO_PAGO_TOKEN_ENCRYPTION_KEY`, CPF/CNPJ, 2FA e as
credenciais dos vendedores ficam ilegíveis para sempre.

### 4. Banco

```bash
npm ci
npm run deploy:check -- --env-file=.env.production --sem-banco
( set -a; . ./.env.production; set +a; npm run db:deploy )       # só migrações, nunca seed
( set -a; . ./.env.production; set +a; npm run cities:import )
```

O `( set -a; . ./.env.production; set +a; … )` carrega o arquivo só para aquele
comando. As migrações vão pela conexão direta (`prisma.config.ts`).

### 5. Segredos no Secret Manager

```bash
SEGREDOS="DATABASE_URL AUTH_SECRET CRON_SECRET QR_TOKEN_SECRET DATA_ENCRYPTION_KEY \
MERCADO_PAGO_ACCESS_TOKEN MERCADO_PAGO_CLIENT_SECRET MERCADO_PAGO_WEBHOOK_SECRET MERCADO_PAGO_TOKEN_ENCRYPTION_KEY \
RESEND_API_KEY EMAIL_API_KEY OBJECT_STORAGE_ACCESS_KEY OBJECT_STORAGE_SECRET_KEY GOOGLE_CLIENT_SECRET \
GOOGLE_WALLET_PRIVATE_KEY APPLE_WALLET_SIGNER_KEY APPLE_WALLET_SIGNER_KEY_PASSPHRASE"
SO_MIGRACAO="DATABASE_URL_UNPOOLED"   # fica só no segredo do build, fora do site

# 5.1 O arquivo inteiro, para o build
gcloud secrets create ticket24-buildenv --data-file=.env.production

# 5.2 Um segredo por variável sensível, para o site
for k in $SEGREDOS; do
  v=$(grep -E "^$k=" .env.production | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
  [ -z "$v" ] && continue
  printf '%s' "$v" | gcloud secrets create "$k" --data-file=- 2>/dev/null \
    || printf '%s' "$v" | gcloud secrets versions add "$k" --data-file=-
done

# 5.3 O build e o site podem ler os segredos
PN=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
for sa in $PN-compute@developer.gserviceaccount.com $PN@cloudbuild.gserviceaccount.com; do
  gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$sa \
    --role=roles/secretmanager.secretAccessor --condition=None
done
```

### 6. Imagem

```bash
gcloud builds submit --config cloudbuild.yaml --region $REGION
```

O build consulta o banco, por isso o passo 4 vem antes. Erro de permissão: dê também
`roles/artifactregistry.writer` e `roles/logging.logWriter` a
`$PN-compute@developer.gserviceaccount.com`.

### 7. Serviço no Cloud Run

```bash
# Variáveis que não são segredo, num arquivo
grep -E '^[A-Z_]+=' .env.production | while IFS= read -r l; do
  k=${l%%=*}; case " $SEGREDOS $SO_MIGRACAO " in *" $k "*) continue;; esac
  v=${l#*=}; v=${v#\"}; v=${v%\"}; printf '%s: "%s"\n' "$k" "$v"
done > env.yaml
# Segredos que existem no Secret Manager
SET=$(for k in $SEGREDOS; do gcloud secrets describe $k >/dev/null 2>&1 && printf '%s=%s:latest,' $k $k; done)

gcloud run deploy ticket24 \
  --image $REGION-docker.pkg.dev/$PROJECT/ticket24/site:latest --region $REGION \
  --port 8080 --cpu 1 --memory 1Gi --min-instances 1 --max-instances 4 --concurrency 80 \
  --cpu-boost --allow-unauthenticated \
  --ingress internal-and-cloud-load-balancing \
  --env-vars-file env.yaml --set-secrets "${SET%,}"
```

- Confira o `env.yaml` antes: valor com aspas ou barra invertida (certificados das
  carteiras) pode precisar de ajuste manual.
- `--min-instances 1` evita a primeira visita lenta (custa uma instância sempre ligada).
- Várias instâncias são seguras: o limite de tentativas fica no banco e todas rodam a
  mesma imagem (mesma chave das Server Actions).

### 8. Load Balancer e HTTPS

O mapeamento de domínio do Cloud Run **não existe em São Paulo**; o domínio entra por
um Load Balancer de aplicativo externo global (cerca de US$ 18/mês fixos).

```bash
gcloud compute addresses create ticket24-ip --global
gcloud compute network-endpoint-groups create ticket24-neg --region=$REGION \
  --network-endpoint-type=serverless --cloud-run-service=ticket24
gcloud compute backend-services create ticket24-backend --global \
  --load-balancing-scheme=EXTERNAL_MANAGED
gcloud compute backend-services add-backend ticket24-backend --global \
  --network-endpoint-group=ticket24-neg --network-endpoint-group-region=$REGION
gcloud compute url-maps create ticket24-urlmap --default-service=ticket24-backend
gcloud compute ssl-certificates create ticket24-cert --global \
  --domains=ticket24.com.br,www.ticket24.com.br
gcloud compute target-https-proxies create ticket24-https \
  --url-map=ticket24-urlmap --ssl-certificates=ticket24-cert
gcloud compute forwarding-rules create ticket24-443 --global \
  --load-balancing-scheme=EXTERNAL_MANAGED --target-https-proxy=ticket24-https \
  --address=ticket24-ip --ports=443

# http:// → https://
printf 'kind: compute#urlMap\nname: ticket24-redirect\ndefaultUrlRedirect:\n  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT\n  httpsRedirect: true\n' > redirect.yaml
gcloud compute url-maps import ticket24-redirect --global --source=redirect.yaml --quiet
gcloud compute target-http-proxies create ticket24-http --url-map=ticket24-redirect
gcloud compute forwarding-rules create ticket24-80 --global \
  --load-balancing-scheme=EXTERNAL_MANAGED --target-http-proxy=ticket24-http \
  --address=ticket24-ip --ports=80

gcloud compute addresses describe ticket24-ip --global --format='value(address)'
```

### 9. DNS na Cloudflare

- Registros **A** em `@` e `www` para o IP do passo 8, **DNS only** (nuvem cinza).
- O certificado fica pronto de 15 a 60 minutos depois de o DNS apontar:
  `gcloud compute ssl-certificates describe ticket24-cert --global --format='value(managed.status)'`
  até `ACTIVE`.

### 10. Cron, monitor e integrações

```bash
gcloud scheduler jobs create http ticket24-maintenance --location $REGION \
  --schedule "* * * * *" --uri https://ticket24.com.br/api/cron/maintenance \
  --http-method POST \
  --headers x-cron-secret="$(grep ^CRON_SECRET= .env.production | cut -d= -f2- | tr -d '\"')"
```

O valor do cabeçalho fica visível para quem tem acesso ao Cloud Scheduler do projeto.

- Monitor externo (ex.: UptimeRobot): `GET https://ticket24.com.br/api/cron/health`
  com o mesmo cabeçalho, mais o aviso de falha do próprio Scheduler.
- Mercado Pago: OAuth `https://ticket24.com.br/api/mercadopago/callback` e webhooks
  `https://ticket24.com.br/api/webhooks/mercadopago`.
- Google OAuth (se usar): `https://ticket24.com.br/auth/google/callback`.

### 11. Primeiro acesso e conferência

1. Cadastre a conta da pessoa responsável no site e confirme o e-mail.
2. Torne-a superadministradora e ative o 2FA no painel:
   ```bash
   ( set -a; . ./.env.production; set +a; npm run admin:promote -- <e-mail> )
   ```
3. **IP do cliente atrás do Load Balancer.** Com o IP forjado mudando a cada pedido, o
   limite da busca (120 por minuto) ainda tem de valer:
   ```bash
   for i in $(seq 1 125); do curl -s -o /dev/null -w '%{http_code}\n' \
     -H "x-forwarded-for: 10.0.0.$i" "https://ticket24.com.br/api/busca/sugestoes?q=show"; done | sort | uniq -c
   ```
   Esperado: cerca de 120 respostas `200` e 5 `429`. Vieram 125 `200`? O
   `TRUSTED_PROXY_HOPS` está errado: **não abra as vendas** antes de corrigir.
4. `npm run deploy:check -- --env-file=.env.production` completo, sem bloqueios.
5. Testes da seção 5 do `docs/deploy-producao.md`. A compra real com PIX e o
   reembolso só com aprovação de quem responde pelo dinheiro.
6. Apague as cópias do Cloud Shell: `rm .env.production env.yaml redirect.yaml`.

## Nova versão

1. CI verde e merge na `main`; no Cloud Shell, `git pull`.
2. Mudou alguma variável? Atualize o segredo do build
   (`gcloud secrets versions add ticket24-buildenv --data-file=.env.production`) e o
   segredo ou o `env.yaml` da variável.
3. `( set -a; . ./.env.production; set +a; npm run db:deploy )` **antes** do código novo.
4. `gcloud builds submit --config cloudbuild.yaml --region $REGION`
5. `gcloud run deploy ticket24 --image $REGION-docker.pkg.dev/$PROJECT/ticket24/site:latest --region $REGION`
   (mantém as variáveis e os segredos já configurados).

## Custo aproximado

Cloud Run com 1 instância sempre ligada (US$ 10 a 25/mês) + Load Balancer (cerca de
US$ 18) + Neon (grátis a US$ 19). Cloud Build, Scheduler, R2 e Resend ficam no grátis
no começo. Valores de referência: confira na calculadora do Google.

## Mudança para a Vercel

1. Crie o projeto na Vercel ligado ao repositório, com a região das funções em São
   Paulo (`gru1`) e as mesmas variáveis do `.env.production`. Tire
   `TRUSTED_PROXY_HOPS` (ou use `0`): a Vercel sobrescreve o `x-forwarded-for`.
2. Publique e teste pela URL `*.vercel.app` (itens do passo 5 do
   `docs/deploy-producao.md`, sem compra real).
3. Na Cloudflare, baixe o TTL dos registros do domínio um dia antes. Na hora, troque o
   `A` do Load Balancer pelos registros que a Vercel indicar.
4. **Cron:** o Cloud Scheduler pode continuar chamando a mesma URL (nada muda). O Cron
   da Vercel chama com `GET` e `Authorization: Bearer <CRON_SECRET>`, e a rota de
   manutenção hoje só aceita `POST` com `x-cron-secret`; usá-lo exige adaptar a rota.
5. Mercado Pago, Google OAuth e Resend não mudam: o domínio é o mesmo.
6. Com o tráfego estável na Vercel, apague o serviço, o Load Balancer (regras de
   encaminhamento, proxies, mapas de URL, certificado, NEG, back-end e IP), o job do
   Scheduler (se trocou de cron) e o repositório de imagens no Google.
