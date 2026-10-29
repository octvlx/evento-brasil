# Cadastro mínimo, SMS e identificação do organizador

## Configuração do Twilio Verify

1. No Twilio Console, abra Verify > Services e crie um serviço chamado Evento Brasil.
2. Habilite SMS e configure códigos de 6 dígitos. O fluxo usa português brasileiro e números móveis brasileiros.
3. Habilite Brasil nas permissões geográficas do Verify, mantenha Fraud Guard ativo e configure alertas de uso/gastos.
4. Em desenvolvimento, contas trial só enviam para destinatários previamente verificados no Twilio. Confirme o cadastro/compliance e saldo necessários antes de produção.
5. Configure no servidor, usando o gerenciador de segredos ou arquivo local ignorado pelo Git:

```dotenv
TWILIO_ACCOUNT_SID="AC..."
TWILIO_AUTH_TOKEN="..."
TWILIO_VERIFY_SERVICE_SID="VA..."
```

Nunca use `NEXT_PUBLIC_`, publique esses valores em PRs ou envie o Auth Token pelo chat. O Account SID não é o Service SID. Não é necessário comprar um número para o fluxo padrão de SMS do Verify; confirme as condições da sua conta e país no Twilio.

O cadastro falha de forma fechada enquanto faltar configuração: não há código universal, provedor simulado de SMS ou ativação sem verificação em produção. Contas existentes continuam podendo entrar. Não enviamos SMS reais durante testes automatizados; o adaptador HTTP é substituído apenas dentro dos testes.

## Fluxo e dados

- Comprador: nome, e-mail, senha, celular e confirmação explícita para receber o SMS de segurança; aceite dos termos e ciência da política de privacidade. Não pedimos CPF, data de nascimento ou endereço no cadastro básico.
- O código só é aceito pelo servidor após aprovação do Twilio, vinculado ao e-mail e telefone informados. A prova expira, só pode ser consumida uma vez e é consumida na mesma transação que cria o usuário e registra os termos.
- Um celular verificado demonstra acesso ao número, não identidade civil, titularidade de CPF ou aprovação de KYC. Alterar o telefone remove seu estado de verificação.
- Solicitações de SMS têm limites persistidos por telefone e origem, intervalo mínimo para reenvio e limite de tentativas. Os cabeçalhos de IP precisam ser definidos/sobrescritos pelo proxy confiável de produção. Configure limites de gastos/permissões no Twilio como proteção adicional.
- Desafios de cadastro são dados transitórios: a manutenção remove registros vencidos com mais de 24 horas. Execute regularmente o endpoint de manutenção autenticado existente. Não são gravados códigos OTP, senhas ou credenciais Twilio em logs.
- Organizador: CPF/CNPJ e nome/razão social ficam no onboarding separado e no registro cifrado de verificação existente. Aprovação administrativa da plataforma não equivale à aprovação de recebedor do provedor de pagamentos.
- Checkout: o provedor informa quais dados adicionais precisa por método; apenas esses dados devem ser solicitados e enviados. O simulador não exige documentos ou endereço. Cartões reais precisam de tokenização do provedor; nunca enviar PAN/CVV para este servidor.

## Pendências de lançamento

- Criar e configurar o serviço Verify e os segredos no ambiente de destino; realizar teste real controlado com número autorizado.
- Confirmar provedor de pagamentos, elegibilidade para ingressos, KYC dos organizadores, split, prazo de repasse, chargebacks e financiamento de reembolsos.
- Definir entidade operadora, município e emissão fiscal antes de determinar campos/documentos fiscais obrigatórios. Não existe nesta implementação uma declaração de conformidade fiscal universal.
- Revisar os textos legais publicados, tratamento de menores, retenção aplicável e contratos/transferência internacional de dados com o responsável jurídico. O consentimento para SMS de segurança não autoriza marketing.

## Referências oficiais

- https://www.twilio.com/docs/verify/quickstarts
- https://www.twilio.com/docs/verify/consent-opt-in
- https://www.twilio.com/docs/verify/developer-best-practices
- https://www.gov.br/anpd/pt-br/acesso-a-informacao/perguntas-frequentes
