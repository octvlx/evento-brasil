# Modo de manutenção

Com `MAINTENANCE_MODE=true`, o site inteiro responde uma tela "Estamos em manutenção"
com status **503** e `Retry-After: 1800` (o Google entende que a parada é temporária e
não tira as páginas do índice). APIs bloqueadas respondem
`{"error":"MAINTENANCE"}` com 503. Implementação: `src/proxy.ts` e
`src/server/maintenance.ts`.

## O que continua funcionando

| Rota | Por quê |
| --- | --- |
| `/api/webhooks/*` | confirmações de pagamento e estornos do Mercado Pago não podem se perder |
| `/api/cron/*` | o agendamento expira reservas, envia a fila de e-mails e os alertas; o monitor de saúde segue |
| `/api/mercadopago/*` | retorno do OAuth de quem estava conectando a conta |
| `/admin`, `/entrar`, `/auth/*`, `/minha-conta/seguranca` | a equipe entra (com 2FA) e confere o painel |
| `/check-in/*` | a portaria de um evento em andamento não para. Para bloquear também: `MAINTENANCE_ALLOW_CHECKIN=false` |

Todo o resto (páginas públicas, checkout, área do comprador e do organizador, outras
APIs) fica parado. Depois do login, a equipe vai direto a `/admin`: a página inicial
também mostra a tela de manutenção.

## Ver o site durante a manutenção (prévia da equipe)

Em `/admin` (página inicial), com a manutenção ligada, aparece o botão **Ver o site
durante a manutenção**. Ele grava no navegador do admin um cookie `eb_preview`,
assinado com `AUTH_SECRET`, e o proxy passa a deixar esse navegador ver o site inteiro
(páginas e APIs) por até 8 horas. O público continua vendo a tela de manutenção.

- Para sair: **Sair da prévia** em `/admin`, ou sair da conta. O cookie também vence sozinho.
- Cada prévia ligada fica na auditoria (`MAINTENANCE_PREVIEW_STARTED`).
- Tudo é real: um pedido feito na prévia cobra de verdade e os e-mails saem.
- O proxy só confere a assinatura e a validade, sem consultar o banco: quem perde o papel
  de admin continua com a prévia até ela vencer ou até `AUTH_SECRET` ser trocado.

## Ligar (Vercel)

```bash
printf 'true' | vercel env add MAINTENANCE_MODE production --force --no-sensitive
vercel redeploy ticket24.com.br --environment production
```

Variáveis de ambiente só valem a partir de um deploy novo: o `redeploy` reaproveita o
código do deploy atual e leva uns 2 minutos.

## Desligar

```bash
printf 'false' | vercel env add MAINTENANCE_MODE production --force --no-sensitive
vercel redeploy ticket24.com.br --environment production
```

## Conferir

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://ticket24.com.br/             # 503 ligado, 200 desligado
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://ticket24.com.br/api/cron/maintenance   # 403 (passa pelo proxy)
```

## Cuidados

- Pedidos com reserva em andamento continuam valendo; o cron libera o estoque das
  reservas que vencerem durante a parada.
- Avise antes os organizadores com evento no dia, se a portaria for bloqueada.
- Para uma correção urgente de código, prefira o **rollback instantâneo** da Vercel
  (`vercel rollback`) à manutenção: ele volta o deploy anterior em segundos.
