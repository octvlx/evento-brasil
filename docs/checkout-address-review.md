# Checkout: endereço na primeira compra e revisão

## Fluxo

A seleção de ingressos fica no navegador para sobreviver ao login e em um CheckoutDraft persistido, protegido por token HttpOnly enquanto anônimo e pela conta após a vinculação. O carrinho expira em 24 horas e não representa reserva de estoque.

O cadastro básico aceita nome/e-mail/senha ou Google. Não há verificação por SMS. CPF e nascimento são completados no checkout; o endereço é solicitado quando ainda não existe e reutilizado depois. O CPF é cifrado, indexado por HMAC e mostrado apenas com os dois últimos dígitos. Após salvo, não pode ser trocado pelo formulário; correções exigem atendimento. Nome e nascimento podem ser corrigidos antes de confirmar.

ViaCEP recebe somente o CEP. A consulta tem timeout e respostas validadas; o usuário pode preencher/corrigir os dados manualmente em caso de indisponibilidade. Edições locais invalidam respostas antigas da busca.

A revisão exibe comprador, endereço, evento/local/data, tipos/quantidades/preços unitários e totais calculados pelo serviço financeiro existente. O botão Revisar valores e ingressos cria ou recupera uma reserva com a expiração normal do projeto. GET/prefetch não reserva estoque. Editar ingressos libera a reserva anterior; a nova seleção é validada novamente.

Confirmar e ir para pagamento verifica novamente perfil, estoque, preços, cupom e termos. Mudanças desde a revisão exigem nova confirmação. Pedidos pagos continuam dependendo da resposta autoritativa do provedor. Ingressos gratuitos são emitidos somente após a revisão e o aceite transacional dos termos.

## E-mail e Google

O provedor de e-mail existente é usado para enviar confirmação. Em desenvolvimento EMAIL_PROVIDER=console grava a mensagem em .data/outbox; em produção configure o provedor real, remetente e credenciais. A prova de confirmação é de uso único, expira em uma hora e fica no fragmento do link, fora da URL enviada ao servidor. Confirmar e-mail não autentica uma conta nem troca a sessão conectada. O reenvio tem limites persistidos no banco.

Para habilitar Google, configure apenas no servidor:

```dotenv
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
APP_URL="https://seu-dominio.example"
```

No Google Cloud Console, registre um cliente Web e o callback exato APP_URL/auth/google/callback. Para desenvolvimento, use a origem localhost correspondente. Configure a tela de consentimento e usuários de teste conforme o ambiente. Sem credenciais, o botão fica indisponível; não existe provedor falso na aplicação.

OAuth usa authorization code, PKCE, state/nonce, cookies cifrados temporários e validação de assinatura/claims via JOSE. Novos usuários precisam aceitar termos e ciência de privacidade. Contas existentes com senha não são vinculadas automaticamente pelo e-mail.

## Segurança e operação

- HTTPS é obrigatório em produção; APP_URL precisa usar https também no build de produção.
- Não envie secrets para o chat nem versione arquivos .env. Não há novas credenciais de pagamento nesta tarefa.
- A migração 20261029140000_checkout_buyer_profile é aditiva. Não execute reset para testar esta funcionalidade.
- Contas antigas precisam confirmar e-mail e completar dados antes de uma nova compra. Somente fixtures explicitamente demo recebem dados fictícios/confirmados no seed de testes.
- Os serviços de pagamentos, estoque, razão e webhooks existentes permanecem autoritativos. Nenhum gateway real foi ativado.
- Publicar textos legais revisados e definir retenção/fluxo de atendimento para CPF continuam sendo requisitos operacionais antes do lançamento.

## Verificação

Os testes novos cobrem perfil privado/CPF imutável, endereço reutilizável, ViaCEP válido/inexistente/indisponível, tokens de e-mail, OAuth assinado, isolamento do carrinho, revisão idempotente, preços alterados, cupons/quantidades, estoque, termos em transação, falhas/tentativas de pagamento e emissão somente após confirmação. A suíte de navegador exercita primeira/segunda compra, login, confirmação por e-mail local, edição, atualização da página e fallback de CEP. Os testes isolados substituem apenas o transporte ViaCEP via preload do runner, sem bypass na aplicação.

```powershell
npm run lint
npx next typegen
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e:isolated
```

Use bancos descartáveis das suítes. Não configure TEST_DATABASE_URL para um banco que contenha dados necessários.

Referências técnicas: https://viacep.com.br/ e https://developers.google.com/identity/openid-connect/openid-connect.
