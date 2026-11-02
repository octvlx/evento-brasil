# Integração Mercado Pago — plano e lista de verificação

**Status:** o adaptador de Checkout Pro Preferences está implementado para PIX,
mas ainda precisa de validação ponta a ponta no sandbox. Isso não certifica
elegibilidade comercial, split, webhooks ou reembolsos em produção.

O adaptador anuncia zero métodos se faltarem credenciais OAuth, chave de
criptografia ou segredo de assinatura dos webhooks. Quando configurado, oferece
PIX e cartão de crédito à vista pelo Checkout Pro; o comprador é redirecionado à página hospedada
do Mercado Pago. O provedor permanece selecionado explicitamente por
`PAYMENT_PROVIDER`; o padrão continua sendo `simulated`.

O ID da preferência e a URL de checkout são persistidos antes do redirecionamento.
O ID do pagamento real só é associado após uma consulta autenticada ao provedor,
usando o `external_reference` local. O webhook nunca confirma status ou valor
por conta própria. Preferências sem pagamento só são encerradas pela reconciliação
depois da expiração e de uma janela adicional de consistência eventual.

Falhas ao criar uma cobrança são tratadas como resultado incerto: a tentativa
permanece `PENDING`, sem permitir outra cobrança, até a reconciliação localizar
a referência original ou confirmar que ela não existe. Adaptadores sem consulta
por referência deixam a tentativa para revisão manual. Uma consulta que ainda
não pode confirmar a ausência (por exemplo, por consistência eventual) deve
lançar erro, nunca retornar `null`.

Snapshots de PIX pendente devem devolver as instruções da cobrança existente
(`pixCopyPaste` e/ou `pixQrCodeBase64`, mais `expiresAt` quando disponível),
inclusive na busca por referência. A confirmação persiste essas instruções
após validar o valor; a recuperação não chama `createPayment` de novo.
Sem instruções, o checkout mantém a mensagem de confirmação pendente.

`processingFeeCents` no snapshot é o total conhecido da taxa em centavos;
`null` significa ainda desconhecido. Atualizações `PAID`, inclusive posteriores
à aprovação e na resolução de disputa, reconciliam esse total com o razão.
Correções criam partidas pelo delta, sem editar o histórico. Repetições não
duplicam custos, e `null` nunca apaga um custo já conhecido.

## O que o sistema já espera de qualquer provedor

Contrato em `src/server/payments/types.ts`:

| Método | Uso |
| --- | --- |
| `createPayment` | Cria preferência Checkout Pro somente para PIX, com referência externa = `Payment.id`, valor, prazo, chave de idempotência, conta OAuth do vendedor e `marketplace_fee`. |
| `getPayment` | **Fonte da verdade.** Todo webhook verificado dispara esta consulta antes de qualquer transição. |
| `refundPayment` | Estorno do valor solicitado com chave de idempotência. |
| `verifyWebhook` | Valida a assinatura e extrai id do evento e do pagamento. |

A lógica de negócio (idempotência, emissão, razão, pagamento tardio) já está
pronta e testada com o provedor simulado. As chamadas reais usam a API REST
oficial do Mercado Pago no servidor; nenhum dado de cartão passa pelo projeto.

## Itens a verificar

1. **OAuth de marketplace** — implementado com PKCE, tokens cifrados,
   renovação e revogação; falta validar com a aplicação Marketplace da conta.
2. **Split nativo** — Checkout Pro Preferences usa `marketplace_fee` com o
   access token OAuth do vendedor. Confirmar elegibilidade e valores no sandbox
   e com o time comercial; a tarifa do Mercado Pago é descontada antes da
   comissão do marketplace.
3. **PIX** — preferência PIX-only, expiração alinhada à reserva e checkout
   hospedado implementados; falta validar a criação e o pagamento no sandbox.
4. **Cartão** — tokenização no cliente (SDK/Brick oficial; nunca trafegar PAN
   pelo nosso servidor), parcelamento e tratamento de 3DS/antifraude.
5. **Status** — mapeamento implementado; confrontar `status`/`status_detail`
   com os pagamentos de teste antes de produção.
6. **Webhooks** — validação HMAC de `x-signature` (`ts`/`v1`) e consulta
   autoritativa implementadas; validar entrega e reenvio no sandbox.
7. **Reembolsos** — chamadas com valor e idempotência implementadas; testar
   efeitos no split 1:1, prazos, comissão e tarifa no sandbox.
8. **Tarifas** — leitura de `fee_details` implementada quando o provedor a
   devolve; confirmar valores e responsável financeiro em cada método.
9. **Liquidação** — como consultar repasses ao vendedor para preencher
   `OrganizerSettlement`; manter `SETTLEMENT_ENABLED=false` até validar.
10. **Chargebacks/disputas** — mapeamento implementado; validar notificações e
    responsabilidade financeira com o provedor.
11. **Sandbox** — ainda falta executar contrato real com contas de teste de
    comprador e vendedor; testes unitários locais não substituem sandbox.
12. **Busca por referência externa** — consulta por `external_reference` e
    preferência expirada implementadas; ausência só é confirmada após 24 horas
    do prazo, para não encerrar uma cobrança ainda em propagação.

## OAuth de organizadores implementado (31/10/2026)

O serviço `src/server/payments/mercadopago-oauth.ts` e as rotas
`POST /api/mercadopago/connect` e `GET /api/mercadopago/callback` implementam a
conexão. A página de configurações tem um botão separado para essa autorização,
inclusive quando os pagamentos continuam simulados. A vinculação fica em
`MercadoPagoAccount`; não muda `Organization.paymentAccountStatus`, o provedor,
estoque, pedidos, repasses ou o adaptador de cobrança.

O POST exige Origin igual à origem de APP_URL, usuário ativo, permissão
`org:manage` e organização aprovada. O callback identifica a organização pelo
fluxo original, não pelo cookie de organização ativa, e revalida as permissões.
State aleatório é armazenado somente com HMAC e consumido com update condicional
atômico antes de trocar o código, inclusive quando há recusa do consentimento.
Expira em dez minutos; uma falha exige iniciar outra conexão. Cookie HttpOnly,
Secure em HTTPS, SameSite=Lax e cifrado vincula ator, state, PKCE S256 e callback.
Abrir um fluxo novo no mesmo navegador substitui o cookie do fluxo anterior.

Access e refresh tokens usam AES-256-GCM com chave exclusiva
`MERCADO_PAGO_TOKEN_ENCRYPTION_KEY` (32 bytes aleatórios em base64). A chave foi
gerada no `.env` local, ignorado pelo Git; não copiar para código, logs ou chat.
Não alterar DATA_ENCRYPTION_KEY: ela protege documentos existentes. Fazer backup
seguro da chave OAuth; perdê-la exige reconexão. Migração de chaves não está
implementada. A configuração falha de forma fechada sem credenciais e chave.

`getMercadoPagoAccessToken(db, organizationId)` é capacidade interna do servidor:
resolver organizationId a partir do pedido confiável, nunca de entrada do cliente.
Renova quando faltam 60 segundos, persiste ambos os tokens novos e usa advisory
lock transacional PostgreSQL por organização, compartilhado com a conexão.
`invalid_grant` persiste `revokedAt` e exige reconexão; timeout, 5xx e respostas
inválidas não apagam a conta. Não há renovação em segundo plano: ocorre sob demanda
quando um serviço autorizado chamar a função. O adaptador desabilitado ainda não
a chama. Uma queda após o provedor rotacionar e antes do commit pode exigir
reconectar; o sistema não tenta recuperar repetindo uma autorização consumida.
Mensagens externas são genéricas; o log padrão de requisições do Next ignora esse callback. Não registrar query strings do callback em
proxy/observabilidade porque incluem código e state.

### Contratos oficiais conferidos

- [OAuth e configuração de marketplace](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/create-configuration): usar Authorization Code do vendedor e callback idêntico ao registrado.
- [PKCE](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/additional-content/security/oauth/creation): esta implementação envia S256; habilitar PKCE na aplicação.
- [Renovação](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/additional-content/security/oauth/renewal): requer offline_access e armazenamento do refresh token rotacionado.
- [Split 1:1](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/integrate-marketplace): Checkout Pro documenta `/checkout/preferences` com `marketplace_fee` e token OAuth do vendedor. Payments usa outro campo, `application_fee`.
- [Migração Payments → Orders](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/resources/migrate-payments-to-orders) exige verificar disponibilidade de métodos e suporte de marketplace antes da migração.
- [Orders Split 1:N](https://www.mercadopago.com.br/developers/en/docs/checkout-api-orders/resources/split-payments-1-n) descreve consentimentos/receivers e habilitação comercial próprios. Não confundir com Pro Preferences 1:1. Não foi habilitado, implementado ou certificado nenhum contrato de cobrança/split neste trabalho.

### Testar localmente sem merge

1. Permanecer em `feature/mercadopago-checkout-pro-split`; manter
   `PAYMENT_PROVIDER=simulated` e `SETTLEMENT_ENABLED=false`.
2. No painel Mercado Pago, confirmar aplicação brasileira com modelo Marketplace,
   Client ID/Secret da mesma aplicação e PKCE S256 habilitado. Confirmar
   elegibilidade de marketplace, conta vendedora e permissões com o provedor.
3. Registrar exatamente:
   `https://radar-county-immunology-dimensions.trycloudflare.com/api/mercadopago/callback`.
   Não é URL de webhook nem URL de retorno de checkout.
4. APP_URL local e allowedDevOrigins já incluem o túnel indicado. Se APP_BASE_URL
   for usado, precisa ter a mesma origem. Reiniciar o servidor de desenvolvimento
   para garantir leitura do `.env`. Neste Windows, iniciar com `npm run dev:oauth`:
   o Node precisa das autoridades de certificado do sistema para acessar o provedor.
   Verificado: HTTPS padrão falha com UNABLE_TO_VERIFY_LEAF_SIGNATURE; usando
   `--use-system-ca`, o endpoint oficial responde HTTP 405 a GET sem credenciais
   (esperado, pois a troca exige POST). Nunca desativar a verificação TLS.
   Manter o cloudflared apontando para porta 3000.
   Túnel rápido precisa estar ativo; se a URL mudar, atualizar os três lugares:
   APP_URL, allowedDevOrigins e Redirect URL no painel. Não usar wildcard genérico.
5. Acessar o site **pelo túnel**, entrar como OWNER/ADMIN de organização aprovada,
   abrir `/organizador/configuracoes` e clicar **Conectar Mercado Pago**.
   Autorizar a conta correta do vendedor. Evitar criar venda real para testar OAuth.
6. O navegador deve voltar com `?mp=connected`; a tela mostra **Autorizado**.
   A recusa retorna `?mp=denied`; falhas retornam `?mp=error`. Acessar o callback
   diretamente, sem sessão/cookie/state válidos, deve retornar erro seguro — isso
   não comprova uma autorização concluída.
7. Repetir o callback antigo não pode trocar outro código nem gravar tokens.
   FINANCE/EVENT_MANAGER/CHECKIN_STAFF não podem conectar; suspensão ou remoção
   de permissão depois do início deve impedir a conclusão. Conferir que provedor
   e status simulado permanecem intactos. Não consultar tokens em claro.

Verificações automatizadas:

```powershell
npm run test:unit
npm exec vitest -- run --config vitest.mercadopago.config.mts
npm run typecheck
npm run lint
npm run build
```

A configuração específica inicia PostgreSQL descartável em localhost:5436 com
credenciais apenas de teste. Recusa de porta ocupada falha antes de usar outro
banco. Reproduz migrações e informa falha, depois verifica somente o schema atual
com `prisma db push` nesse banco descartável. Executa testes de callback único,
permissões e renovação concorrente com HTTP simulado; não chama Mercado Pago.
Não usar esse resultado como validação das migrações nem de sandbox do provedor.

### Histórico de migrações (resolvido no #75)

As migrações duplicadas da fase de desenvolvimento foram substituídas por
`20261031210000_mercadopago_oauth` (contas e state) e
`20261031220000_mercadopago_checkout_preferences`; o replay em banco vazio
funciona. Bancos locais que aplicaram os nomes antigos (`20261031_…`) já têm as
tabelas idênticas: basta `npx prisma migrate resolve --applied
20261031210000_mercadopago_oauth` antes de `npm run db:deploy`.

### Conta do vendedor sem PIX

O comprador escolhe PIX ou cartão no site. Antes de criar a preferência, o adaptador consulta
`/v1/payment_methods` da conta conectada; sem `pix`, a tentativa é recusada
**antes de qualquer cobrança** (`PaymentNotStartedError`, motivo
`PIX_UNAVAILABLE`), o pagamento local vira `FAILED` e o comprador vê que o
organizador ainda não recebe por PIX. O mesmo vale para conta não conectada ou
revogada (`ACCOUNT_NOT_CONNECTED`) e falha nessa consulta (`PRECHECK_FAILED`).
Falhas na criação da preferência continuam "incertas" até a reconciliação.
Em `/organizador/configuracoes`, a tela avisa quando a conta conectada não
oferece PIX: cadastre uma chave PIX na conta Mercado Pago ou conecte outra.

**Cartão de crédito:** com o método `CREDIT_CARD`, a preferência aceita só
cartões de **crédito** à vista (`installments: 1`, para o valor pago ser o total
do pedido); débito, pré-pago e boleto saem por `excluded_payment_types` e PIX
por `excluded_payment_methods`. Sem cartão de crédito na conta, a tentativa é
recusada antes de qualquer cobrança (`CARD_UNAVAILABLE`). Com PIX, a
preferência aceita só PIX. Em ambos, o saldo em conta (`account_money`) não
pode ser excluído e sempre aparece. Uma tentativa pendente com página do
Mercado Pago é reaproveitada se o comprador clicar de novo no mesmo método;
trocar de método exige a tentativa anterior terminar ou expirar.

**Sandbox:** o Mercado Pago só aceita pagamentos de teste quando aplicação,
vendedor e comprador são **usuários de teste**. Criar a aplicação numa conta
real e conectar um vendedor de teste faz o checkout falhar ao enviar o cartão,
sem criar pagamento. Contas de teste normalmente não têm chave PIX: no sandbox,
use o cartão; o PIX ponta a ponta é validado com uma compra real de valor mínimo.

**Formas de pagamento:** PIX → só PIX. Cartão → crédito (à vista), débito e
pré-pago; boleto fica de fora (compensação maior que a reserva). O saldo
Mercado Pago aparece sempre (não pode ser excluído).

**Confirmação na volta do checkout:** as `back_urls` levam a `/pedido/<id>` com
`payment_id`/`collection_id`. Esse id é só uma pista: o servidor consulta
`GET /v1/payments/{id}` com o token do vendedor do pedido e só aplica o
resultado se o `external_reference` for uma tentativa deste pedido (valor
conferido). Isso confirma o pedido na hora mesmo sem webhook — pagamentos com
credenciais de teste não enviam notificações, e o `notification_url` fica preso
ao túnel do momento em que o checkout foi criado.

**Limitações observadas no sandbox (02/11/2026):** com credenciais de teste,
`/v1/payments/search?external_reference=` não encontrou um pagamento aprovado
que `GET /v1/payments/{id}` lia normalmente (a reconciliação por referência fica
cega no sandbox); e o estorno desse pagamento (saldo em conta) respondeu 404
"Payment not found". Investigar com um pagamento de cartão de teste antes de
concluir se é limitação do sandbox.

**Credenciais de sandbox via OAuth:** a documentação de OAuth do Mercado Pago
manda enviar `test_token=true` na troca do código para obter credenciais de
sandbox do vendedor. Com `MERCADO_PAGO_OAUTH_TEST_TOKEN=true` (fora de
produção), a conexão em `/organizador/configuracoes` faz isso; depois de mudar a
variável, autorize o vendedor novamente. Em produção a aplicação não inicia com
essa variável ligada. A compra de teste é feita logado como o **comprador de
teste** da aplicação, numa janela anônima. Nesse modo a preferência sai **sem
`payer.email`**: o e-mail do comprador no Evento Brasil não é de um usuário de teste
do Mercado Pago e diverge da conta logada no checkout. Em produção o e-mail continua
sendo enviado. Em 02/11/2026, um pagamento com
credenciais de teste enviou webhooks `payment.created` assinados para a
`notification_url` da preferência. Mesmo assim, não dependa disso: a página do
pedido reconcilia sozinha (abaixo).

### Confirmação do pagamento (webhook e reconciliação)

Identificadores de uma compra pelo Checkout Pro:

| Onde aparece | Valor | Entidade |
| --- | --- | --- |
| `/pedido/<id>` | `Order.id` | pedido |
| `external_reference`, `items[0].id` | `Payment.id` | tentativa de pagamento (uma preferência) |
| `preference_id` | `Payment.providerPreferenceId` | preferência do Checkout Pro |
| `payment_id` / `collection_id`, `data.id` do webhook | `Payment.providerPaymentId` (gravado ao confirmar) | pagamento no Mercado Pago |
| `merchant_order_id` | não gravado | agrupa os pagamentos de uma preferência |

Um checkout pode ter vários pagamentos, por exemplo um cartão recusado seguido de
saldo aprovado. O pagamento aprovado substitui o recusado na tentativa. Um segundo
pagamento aprovado vira `duplicate_payment`, com auditoria e reembolso manual.

Caminhos de confirmação (todos passam por `applyPaymentSnapshot`, idempotente e sob
trava do pedido; nenhum confia nos parâmetros `status=approved` do redirect):

1. **Webhook** `POST /api/webhooks/mercadopago`: assinatura `x-signature`, consulta de
   `/v1/payments/{id}` com o token do vendedor (`user_id` do aviso). Avisos de
   `merchant_order` são registrados e ignorados.
2. **Página do pedido**: enquanto o pedido aguarda pagamento, a página consulta o
   provedor ao abrir e a cada 12 s, por até 6 min. Também há o botão "Verificar
   pagamento agora", limitado a 10 consultas por minuto por pedido e só para o dono.
   O pagamento é localizado por `/merchant_orders/search?preference_id=` da tentativa
   registrada, e não por ids vindos da URL.
3. **Cron** `POST /api/cron/maintenance`: reprocessa webhooks que falharam e
   tentativas paradas.

`/v1/payments/search` não listou o pagamento aprovado de teste. A merchant order
listou. Por isso a busca usa a merchant order primeiro.

### Compra de teste com cartão (procedimento oficial)

Fonte: documentação do Checkout Pro, páginas "Realizar compras de teste" e "Cartões de teste".

1. Vendedor conectado com `MERCADO_PAGO_OAUTH_TEST_TOKEN=true`: o token começa com
   `TEST-` e pertence a um **usuário de teste vendedor**.
2. Faça o pedido no site e abra o checkout numa **janela anônima**. No Mercado Pago,
   entre como o **usuário de teste comprador** da mesma aplicação, e não com sua conta
   real. Se pedirem código por e-mail, use os 6 dígitos indicados para a conta de teste.
3. Use um cartão de **crédito** de teste: Mastercard `5480 8328 0103 3311` ou Visa
   `4235 6477 2802 5682`, CVV `123`, validade `11/30`. Titular `APRO` aprova, `OTHE`
   recusa, `CONT` fica pendente. CPF `12345678909`.
   Digite o cartão como **cartão novo**: um cartão já salvo na conta de teste usa o
   titular com que foi cadastrado, e qualquer nome diferente de `APRO` não aprova.
   O cartão Elo de teste é pré-pago.
4. Cartão real não funciona no sandbox. Se o checkout mostrar `/congrats/recover/error/`
   e a merchant order da preferência continuar sem pagamentos, o erro foi no checkout
   (conta, cartão ou sessão), sem cobrança. Não foi recusa do emissor.
5. Confira `Payment.status`, `IssuedTicket` e `PaymentWebhookEvent` no banco. A página
   do pedido deve mostrar "Pagamento confirmado!" só depois disso.

Uma preferência que já recebeu pagamento não é reaberta por "Voltar ao pagamento". O
site confere o checkout no provedor antes de reaproveitá-lo.



A `notification_url` e as `back_urls` saem de `APP_URL` **no momento em que a
preferência é criada**. Uma preferência criada com um túnel antigo continua
avisando o endereço antigo.

1. `npm run db:start` e `npm run dev:oauth` (ou `npm run dev`).
2. `cloudflared tunnel --url http://localhost:3000` e anote o endereço `https://….trycloudflare.com`.
3. No `.env`, `APP_URL` = esse endereço (sem barra no final), e reinicie o `next dev`.
4. No painel do Mercado Pago, a URL de redirecionamento do OAuth é
   `<APP_URL>/api/mercadopago/callback`. A URL de webhooks do painel (se usada) é
   `<APP_URL>/api/webhooks/mercadopago`, com a mesma chave secreta de
   `MERCADO_PAGO_WEBHOOK_SECRET`.
5. Entre no site **pelo túnel** e faça um pedido novo. Para conferir a notificação,
   veja `PaymentWebhookEvent`: `processedAt` preenchido e `processingResult` = `paid`.
   Se a coluna `error` estiver preenchida, o aviso chegou, mas a consulta ao
   provedor falhou.

O túnel rápido muda de endereço a cada execução. Para um endereço estável, use um
túnel nomeado do Cloudflare com domínio próprio. Nunca fixe o endereço no código.

## Passos de habilitação

1. Aplicar as migrações, incluindo `providerPreferenceId`, em banco de
   desenvolvimento e homologação.
2. No painel do Mercado Pago, criar/usar uma aplicação **Pagamentos online**,
   **Checkout Pro**, API **Preferences**, modelo **Marketplace / Split 1:1**.
   Ativar PKCE S256 e cadastrar o Redirect URL exatamente igual ao callback.
   Uma aplicação criada sem modelo Marketplace pode exigir nova aplicação.
3. Configurar `MERCADO_PAGO_CLIENT_ID`, `MERCADO_PAGO_CLIENT_SECRET`,
   `MERCADO_PAGO_TOKEN_ENCRYPTION_KEY` e `MERCADO_PAGO_WEBHOOK_SECRET` apenas
   no `.env` local ou gerenciador de segredos. Não compartilhar os valores.
4. Configurar a assinatura secreta dos Webhooks da aplicação no painel; o
   endereço usado pelas preferências é
   `https://<APP_URL>/api/webhooks/mercadopago`.
5. Manter `PAYMENT_PROVIDER=simulated`, reiniciar o servidor e conectar uma
   conta de teste de vendedor aprovada em `/organizador/configuracoes`.
6. Executar no sandbox: criar preferência → pagar PIX de teste → receber
   webhook → verificar consulta autenticada e emissão → testar reembolso e
   reconciliação. Conferir a comissão e a tarifa no painel.
7. Só depois de aprovação comercial, teste ponta a ponta e domínio HTTPS estável,
   configurar os segredos de produção e mudar `PAYMENT_PROVIDER=mercadopago`.
   Não habilitar `SETTLEMENT_ENABLED` sem validar separadamente os repasses.
