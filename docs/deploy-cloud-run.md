# Deploy no Google Cloud Run (e mudança depois para a Vercel)

Complementa o `docs/deploy-producao.md`, que continua valendo para variáveis, banco,
cron e testes pós-deploy. Este guia cobre só o que muda ao hospedar no Cloud Run em
São Paulo (`southamerica-east1`) e como sair dele para a Vercel sem migrar dados.

> Os comandos `gcloud` abaixo ainda não foram executados neste projeto. Confira cada
> passo no console do Google Cloud na primeira vez.

## Escolhas que deixam a mudança para a Vercel simples

| Peça | Use | Por quê |
| --- | --- | --- |
| Banco | **Neon** (ou outro Postgres gerenciado) em São Paulo, conexão com `sslmode=require` | Funciona igual no Cloud Run e na Vercel. O Cloud SQL exigiria abrir o banco para a internet quando a Vercel entrar (ela não tem IP fixo nos planos comuns). |
| Imagens | **Cloudflare R2** (`STORAGE_PROVIDER=s3`) | As URLs públicas não mudam com a hospedagem. |
| E-mail | Resend | Igual nos dois. |
| Cron | Cloud Scheduler | Pode continuar chamando o site depois da mudança (ver o fim do guia). |

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
direto escolhe o próprio IP, porque o app pularia uma entrada que não é de proxy.

Na primeira publicação, confira nos logs (ou num endpoint temporário) o
`x-forwarded-for` que chega de verdade e ajuste o valor se for diferente.

## 1. Projeto e serviços (uma vez)

```bash
gcloud config set project <PROJETO>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com compute.googleapis.com
gcloud artifacts repositories create ticket24 \
  --repository-format=docker --location=southamerica-east1
```

Dê à conta de serviço do Cloud Build o papel **Secret Manager Secret Accessor** no
segredo do build (passo 2).

## 2. Segredos

- **Build:** o `.env.production` inteiro num segredo só:
  ```bash
  gcloud secrets create ticket24-buildenv --data-file=.env.production
  ```
  Atualizou o arquivo? `gcloud secrets versions add ticket24-buildenv --data-file=.env.production`.
- **Execução:** um segredo por variável sensível (`AUTH_SECRET`, `DATABASE_URL`,
  `DATA_ENCRYPTION_KEY`, `QR_TOKEN_SECRET`, `CRON_SECRET`, `MERCADO_PAGO_*`,
  `RESEND_API_KEY`, `OBJECT_STORAGE_*_KEY`, …), passados ao serviço com
  `--set-secrets`. As demais vão em `--set-env-vars`.
- A conta de serviço do Cloud Run precisa de **Secret Manager Secret Accessor** nesses
  segredos.

Guarde `DATA_ENCRYPTION_KEY` e `MERCADO_PAGO_TOKEN_ENCRYPTION_KEY` também fora do
Google (ver `docs/deploy-producao.md`).

## 3. Migrações e imagem

```bash
npm run deploy:check -- --env-file=.env.production --sem-banco
npm run db:deploy          # com a DATABASE_URL de produção; nunca seed
gcloud builds submit --config cloudbuild.yaml --region southamerica-east1
```

## 4. Serviço

```bash
gcloud run deploy ticket24 \
  --image southamerica-east1-docker.pkg.dev/<PROJETO>/ticket24/site:latest \
  --region southamerica-east1 \
  --port 8080 --cpu 1 --memory 1Gi \
  --min-instances 1 --max-instances 4 --concurrency 80 \
  --cpu-boost --allow-unauthenticated \
  --ingress internal-and-cloud-load-balancing \
  --set-env-vars NODE_ENV=production,APP_URL=https://ticket24.com.br,TRUSTED_PROXY_HOPS=1,PAYMENT_PROVIDER=mercadopago,EMAIL_PROVIDER=resend,STORAGE_PROVIDER=s3 \
  --set-secrets AUTH_SECRET=AUTH_SECRET:latest,DATABASE_URL=DATABASE_URL:latest
  # …e os demais segredos do passo 2
```

- `--min-instances 1` evita a primeira visita lenta (custa uma instância sempre ligada).
- Várias instâncias são seguras: o limite de tentativas fica no banco e todas as
  instâncias rodam a mesma imagem (mesma chave das Server Actions).

## 5. Domínio

O mapeamento de domínio do Cloud Run **não existe em São Paulo**. Use um **Load
Balancer de aplicativo externo global** com NEG sem servidor apontando para o serviço
e certificado gerenciado pelo Google (custo fixo de cerca de US$ 18/mês pela regra de
encaminhamento). Na Cloudflare: registro `A` de `ticket24.com.br` (e `www`) para o IP
do Load Balancer, **DNS only** (nuvem cinza).

## 6. Cron e monitor

```bash
gcloud scheduler jobs create http ticket24-maintenance \
  --location southamerica-east1 --schedule "* * * * *" \
  --uri https://ticket24.com.br/api/cron/maintenance --http-method POST \
  --headers x-cron-secret=<CRON_SECRET>
```

O valor do cabeçalho fica visível para quem tem acesso ao Cloud Scheduler do projeto.
O monitor (`GET /api/cron/health`) segue o `docs/deploy-producao.md`.

Depois disso, os itens 3.5 a 3.8 e 5 do `docs/deploy-producao.md`.

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
6. Com o tráfego estável na Vercel, apague o serviço, o Load Balancer, o job do
   Scheduler (se trocou de cron) e o repositório de imagens no Google.
