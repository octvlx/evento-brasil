# syntax=docker/dockerfile:1.7
# Imagem de produção para o Cloud Run (ou qualquer host de containers).
# Guia: docs/deploy-cloud-run.md. Build (as variáveis de produção entram como segredo,
# nunca numa camada da imagem):
#   docker build --secret id=buildenv,src=.env.production -t ticket24 .

FROM node:24-bookworm-slim AS deps
WORKDIR /app
# O postinstall roda `prisma generate`, que lê o schema e o prisma.config.ts.
# A URL é só para o config carregar: o generate não conecta no banco.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# O build lê o banco e as variáveis de produção, como no CI. O arquivo é montado só
# durante este RUN; o Next carrega .env.production sozinho. O standalone COPIA os .env
# para .next/standalone: apagar no mesmo RUN, senão os segredos vão para a imagem.
RUN --mount=type=secret,id=buildenv,target=/app/.env.production,required=true \
    npm run build \
    && rm -f .next/standalone/.env* \
    && ! ls -A .next/standalone | grep -q '^\.env'

FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 8080
# O Cloud Run envia SIGTERM e espera; o server.js do Next termina as requisições em curso.
CMD ["node", "server.js"]
