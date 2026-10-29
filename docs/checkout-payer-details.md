# Dados adicionais do pagador no checkout

O cadastro básico do comprador não coleta CPF/CNPJ, endereço ou dados de cartão. O checkout consulta `PaymentProviderAdapter.payerRequirements(method)` no servidor para saber quais dados o provedor exige para iniciar **uma nova tentativa** daquele método. Sem declaração, nenhum campo adicional é solicitado ou encaminhado.

Contrato opcional:

```ts
payerRequirements(method): {
  document?: readonly ("CPF" | "CNPJ")[];
  billingAddress?: boolean;
}
```

As declarações devem corresponder ao contrato oficial verificado do provedor escolhido. Não são uma definição de requisitos fiscais universais. A integração real Mercado Pago permanece desabilitada; o simulado não exige dados adicionais. Requisitos fiscais específicos dependem da entidade operadora, município e arranjo de emissão de notas.

`startPayment` autoriza o comprador e verifica o pedido e tentativas existentes antes de validar os campos necessários. Os dados são validados no servidor **antes** de gravar uma nova tentativa ou chamar o provedor. Uma cobrança PIX existente é reaproveitada sem solicitar novamente os dados. O servidor remove campos não declarados, mesmo quando o cliente contorna a interface.

O contrato aceita documento validado (CPF/CNPJ) e endereço de cobrança brasileiro quando declarados. Campos de endereço são CEP, logradouro, número (aceita S/N), bairro, cidade, UF e país BR. Não há suporte a dados de cartão: PAN/CVV nunca devem ser enviados ao servidor; uma integração futura deve usar tokenização ou checkout hospedado oficial.

Os dados adicionais são transitórios e encaminhados somente na criação da cobrança. Não são adicionados ao perfil do comprador, ao pedido, à trilha de auditoria nem aos logs. O provedor poderá tratá-los de acordo com seu contrato e aviso de privacidade. Isso não substitui o KYC separado de organizadores e contas recebedoras.
