# Integração Mercado Pago — plano e lista de verificação

**Status:** `src/server/payments/mercadopago.ts` é um esqueleto **desabilitado**.
Nenhuma chamada à API foi implementada nem testada. Os pontos abaixo devem ser
confirmados na documentação oficial vigente **e** com o time comercial do
Mercado Pago (elegibilidade da conta de marketplace) antes de implementar.

O adaptador anuncia zero métodos enquanto estiver desabilitado. A seleção de
ingressos e o checkout mostram indisponibilidade, e a ação de criar pedido
recusa pedidos pagos antes de reservar estoque. Pedidos gratuitos continuam
funcionando. Isso não habilita nem certifica a integração real.

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
| `createPayment` | Cria PIX/cartão com referência externa = `Payment.id`, valor em centavos, prazo = fim da reserva, chave de idempotência, conta do vendedor e comissão (`applicationFeeCents`). |
| `getPayment` | **Fonte da verdade.** Todo webhook verificado dispara esta consulta antes de qualquer transição. |
| `refundPayment` | Estorno integral com chave de idempotência. |
| `verifyWebhook` | Valida a assinatura e extrai id do evento e do pagamento. |

A lógica de negócio (idempotência, emissão, razão, pagamento tardio) já está
pronta e testada com o provedor simulado; o adaptador real só precisa mapear
o provedor para esse contrato.

## Itens a verificar

1. **OAuth de marketplace** — fluxo de autorização do vendedor, escopos,
   armazenamento seguro de `access_token`/`refresh_token` (cifrar como o CPF/CNPJ),
   renovação e revogação. Criar tabela própria para credenciais do vendedor.
2. **Split nativo** — se `application_fee` (ou equivalente) está disponível para
   o tipo de conta, para **PIX** e para **cartão**, e como aparece na liquidação.
   Não assumir que todos os métodos suportam o mesmo split.
3. **PIX** — criação via pagamento com QR dinâmico, `date_of_expiration`
   alinhado à reserva (`Order.expiresAt`), campos devolvidos (copia-e-cola e QR
   base64 → `Payment.pixCopyPaste` / `pixQrCodeBase64`).
4. **Cartão** — tokenização no cliente (SDK/Brick oficial; nunca trafegar PAN
   pelo nosso servidor), parcelamento e tratamento de 3DS/antifraude.
5. **Status** — mapear todos os status/`status_detail` para
   `PENDING | PAID | FAILED | EXPIRED | CANCELLED | REFUNDED | DISPUTED | CHARGED_BACK`.
6. **Webhooks** — formato atual das notificações, cabeçalhos de assinatura
   (o esboço usa `x-signature` com `ts`/`v1` e manifesto
   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` em HMAC-SHA256 — confirmar),
   política de reenvio e IPs de origem.
7. **Reembolsos** — estorno total/parcial, prazos, efeito sobre a comissão
   retida e sobre a tarifa do processador.
8. **Tarifas** — onde a tarifa de processamento é informada (para
   `processingFeeCents` e o razão) e quem a absorve em cada método.
9. **Liquidação** — como consultar repasses ao vendedor para preencher
   `OrganizerSettlement`; manter `SETTLEMENT_ENABLED=false` até validar.
10. **Chargebacks/disputas** — notificações e responsabilidade financeira.
11. **Sandbox** — contas de teste de comprador e vendedor; criar testes de
    contrato do adaptador contra o sandbox.
12. **Busca por referência externa** — como localizar um pagamento pela nossa
    chave de idempotência / `external_reference`, para implementar
    `findPaymentByReference` (usado pela reconciliação quando o processo cai
    entre criar a cobrança e salvar o id). Sem isso, esses casos ficam marcados
    `PROVIDER_LINK_MISSING` para revisão manual.

## Passos de habilitação

1. Implementar o adaptador real com base nos itens verificados.
2. Testes de contrato no sandbox (criar → webhook → `getPayment` → reembolso).
3. Configurar `PAYMENT_PROVIDER=mercadopago` e as credenciais apenas no
   gerenciador de segredos do ambiente.
4. Implementar o fluxo OAuth em `/organizador/configuracoes` (hoje só existe a
   conexão simulada).
5. Rodar a suíte de integração com o adaptador apontando para o sandbox.
