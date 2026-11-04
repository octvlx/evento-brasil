# Prontidão para produção e implantação

## Implantação de referência

- **App:** um serviço Node.js (`npm run build && npm start`) atrás de HTTPS.
  Funciona em plataformas com Node 20.19+ (Vercel, Render, Fly.io, Railway,
  container próprio). Processo único é suficiente para o MVP.
- **Banco:** PostgreSQL 15+ gerenciado, com backups automáticos e PITR.
  Aplicar migrações no deploy: `npm run db:deploy` (nunca `migrate dev`).
- **Cron:** chamar `POST /api/cron/maintenance` a cada minuto com o header
  `x-cron-secret: $CRON_SECRET` (expira reservas e encerra eventos; ver
  `docs/encerramento-de-eventos.md`). O término do evento já vale pelo relógio
  mesmo se o cron falhar.
- **Webhooks:** expor `POST /api/webhooks/<provedor>` publicamente.
- **Imagens:** `STORAGE_PROVIDER=s3` + bucket público/CDN (`OBJECT_STORAGE_*`).
- **E-mail:** `EMAIL_PROVIDER=resend` (adaptador implementado, **não verificado**
  neste ambiente) ou outro adaptador com o mesmo contrato.
- **Segredos:** `AUTH_SECRET`, `DATA_ENCRYPTION_KEY` (32 bytes base64),
  `CRON_SECRET` gerados aleatoriamente; a aplicação recusa iniciar em produção
  com valores `dev-only…` ou com `PAYMENT_PROVIDER=simulated`.

## Checklist de segurança

- [x] Senhas com scrypt; sessões aleatórias de 256 bits; banco guarda só HMAC do token.
- [x] Cookies `httpOnly`, `SameSite=Lax`, `Secure` em produção.
- [x] Autorização em todos os serviços (organização/papel/atribuição); testes de acesso cruzado.
- [x] Server Actions com verificação de origem do Next.js; rotas de API com sessão própria.
- [x] Webhooks com assinatura HMAC + consulta ao provedor; corpo limitado a 64 KB.
- [x] Tokens de QR de 256 bits; código público não sequencial.
- [x] Upload valida assinatura do arquivo (JPG/PNG/WebP) e tamanho.
- [x] CSV com neutralização de fórmulas; exportações auditadas.
- [x] Contas demo bloqueadas em produção.
- [ ] Verificação de e-mail no cadastro e recuperação de senha.
- [x] 2FA (TOTP) obrigatório para administradores e donos de organização em produção (`MFA_REQUIRED`), com códigos de recuperação; ver `docs/senhas.md` § "Verificação em duas etapas". Pendente: redefinição do 2FA por outro admin para quem perder celular e códigos.
- [x] Limitação de taxa distribuída: contadores no Postgres (`RateLimitBucket`, `src/server/rate-limit.ts`), valem entre instâncias e reinícios; janelas vencidas saem no expurgo programado.
- [x] Cabeçalhos de segurança (CSP sem nonce, HSTS fora do dev, `frame-ancestors`/`X-Frame-Options`, `Permissions-Policy`) em `next.config.ts`. CSP com nonce exigiria renderização dinâmica e é incompatível com o pré-render parcial.
- [ ] Revisão de dependências (`npm audit`) e varredura de segredos no CI.
- [ ] Observabilidade: logs estruturados, rastreamento de erros, alertas para
      webhooks não processados e reembolsos com falha.

## Pendências funcionais conhecidas

- Integração real de pagamentos, OAuth do vendedor, split e liquidação
  (`docs/payments-mercadopago.md`). Pagamento duplicado do mesmo pedido é
  sinalizado para reembolso manual no admin.
- Reembolso parcial não suportado (somente integral).
- Ingressos reembolsados não voltam ao estoque (decisão de MVP).
- Limite de compra por CPF/usuário por evento além de `maxPerOrder` e
  "um pedido pendente por evento".
- Busca textual sem tratamento de acentos (avaliar `unaccent`/full-text).
- Seletores de cidade carregam todas as cidades — trocar por autocompletar
  antes de importar a base completa do IBGE.
- Modo offline do check-in (fora do escopo do MVP por decisão).
- Push/WhatsApp transacional; reenvio de ingressos por e-mail a pedido.
- Notificar compradores por e-mail em cancelamentos/reembolsos.
- `notFound()` dentro de Suspense responde 200 com `noindex` (comportamento do
  streaming do Next.js); para 404 "duro" seria preciso validar o slug antes do stream.

## Operação

- Rotina diária: revisar `/admin/pagamentos` (webhooks pendentes, reembolsos com
  falha, pagamentos sinalizados) e conciliar o razão com os relatórios do provedor.
- Backups testados com restauração periódica.
