# Carteiras digitais (Apple Wallet e Google Wallet)

O código já gera os passes; cada carteira fica **desligada** até as variáveis de
ambiente dela estarem preenchidas. Desligada, nada aparece para o comprador.
Ligada:

- **Página do ingresso** (`/ingressos/[code]`, só ingresso válido): botões
  "Adicionar à Apple Wallet" e/ou "Salvar no Google Wallet".
- **E-mail da compra**: um `.pkpass` por ingresso anexado (Apple) e um link
  "Salvar os ingressos no Google Wallet" que salva todos os ingressos do pedido.

O passe traz o mesmo QR do ingresso e do PDF. A portaria valida online, então um
ingresso cancelado ou reembolsado depois de salvo continua aparecendo na
carteira, mas é recusado na entrada. Atualizar ou remover o passe automaticamente
é uma etapa futura: web service de passes da Apple e API do Google Wallet.

Código: `src/server/tickets/wallet/`. Rotas:
- `/api/tickets/[code]/wallet/apple`
- `/api/tickets/[code]/wallet/google`
- `/api/orders/[orderId]/wallet/google`

Testes: `tests/unit/wallet.test.ts`, com certificados autoassinados só de teste.

## Apple Wallet

### O que criar

1. **Apple Developer Program** (conta de empresa, US$ 99/ano) em
   <https://developer.apple.com/programs/>. Para uma empresa é preciso um
   número D-U-N-S; a Apple ajuda a obter, sem custo.
2. Em *Certificates, Identifiers & Profiles → Identifiers*, crie um
   **Pass Type ID**, por exemplo `pass.br.com.eventobrasil.ingresso`.
3. No mesmo Pass Type ID, crie o **certificado** (*Create Certificate*):
   - Gere um CSR no computador. No Mac: Acesso às Chaves → Assistente de
     Certificado. Ou com o OpenSSL:
     `openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr -subj "/CN=Evento Brasil/O=Evento Brasil"`.
   - Envie o CSR e baixe o certificado `pass.cer`.
4. Baixe o **certificado intermediário WWDR G4** em
   <https://www.apple.com/certificateauthority/> ("Worldwide Developer Relations
   - G4").
5. Anote o **Team ID** (10 caracteres), em *Membership details*.

### Converter para PEM

```bash
openssl x509 -inform der -in pass.cer -out signerCert.pem
openssl x509 -inform der -in AppleWWDRCAG4.cer -out wwdr.pem
# pass.key (gerada com o CSR) já está em PEM.
# Se exportou um .p12 do Acesso às Chaves:
openssl pkcs12 -in pass.p12 -clcerts -nokeys -out signerCert.pem -legacy
openssl pkcs12 -in pass.p12 -nocerts -out pass.key -legacy
```

### Variáveis

| Variável | Valor |
| --- | --- |
| `APPLE_WALLET_PASS_TYPE_ID` | O Pass Type ID (`pass.br.com.eventobrasil.ingresso`) |
| `APPLE_WALLET_TEAM_ID` | Team ID |
| `APPLE_WALLET_SIGNER_CERT` | Conteúdo de `signerCert.pem` |
| `APPLE_WALLET_SIGNER_KEY` | Conteúdo de `pass.key` |
| `APPLE_WALLET_SIGNER_KEY_PASSPHRASE` | Senha da chave, se tiver |
| `APPLE_WALLET_WWDR_CERT` | Conteúdo de `wwdr.pem` |

PEM em uma linha só: troque as quebras por `\n`, ou use o arquivo inteiro em
base64 (`base64 -w0 signerCert.pem` no Linux; `[Convert]::ToBase64String([IO.File]::ReadAllBytes("signerCert.pem"))`
no PowerShell). O certificado do Pass Type ID **vence em 1 ano**: renove antes.

### Conferir

Abra o ingresso num iPhone (Safari) e toque em "Adicionar à Apple Wallet". Se o
iPhone recusar o passe, o problema costuma ser: Pass Type ID ou Team ID diferente
do certificado, WWDR errado (precisa ser o G4) ou certificado vencido.

## Google Wallet

### O que criar

1. **Conta de emissor** no Google Pay & Wallet Console:
   <https://pay.google.com/business/console> → *Google Wallet API*. Anote o
   **Issuer ID**. É gratuito.
2. Um projeto no **Google Cloud** (<https://console.cloud.google.com>) com a
   **Google Wallet API** ativada (*APIs e serviços → Biblioteca*).
3. Nesse projeto, uma **conta de serviço** (*IAM → Contas de serviço*) e uma
   **chave JSON** dela. Do arquivo JSON, use `client_email` e `private_key`.
4. No Wallet Console, em *Usuários*, adicione o e-mail da conta de serviço com
   acesso de **Desenvolvedor**.
5. Para sair do modo de demonstração, peça a **publicação** no Wallet Console
   (*Google Wallet API → Solicitar acesso de publicação*). Antes disso, só as
   contas de teste cadastradas no console conseguem salvar os passes.

### Variáveis

| Variável | Valor |
| --- | --- |
| `GOOGLE_WALLET_ISSUER_ID` | Issuer ID (só números) |
| `GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL` | `client_email` do JSON |
| `GOOGLE_WALLET_PRIVATE_KEY` | `private_key` do JSON (já vem com `\n`) |

`APP_URL` precisa ser o endereço público do site: ele vai como `origins` no JWT.

### Conferir

Abra o ingresso num Android e toque em "Salvar no Google Wallet". A classe do
evento é criada no primeiro salvamento com o status `UNDER_REVIEW`; o Google
aprova automaticamente as classes de emissores publicados.

## Segurança

- Chaves e certificados só em variáveis de ambiente ou num cofre de segredos,
  nunca no repositório. `.env` não é versionado.
- O passe contém o mesmo token do QR que o PDF. Por isso as rotas exigem login e
  só entregam ingressos do próprio comprador. O e-mail leva os `.pkpass` (Apple)
  e um link que exige login (Google), sem token na URL do e-mail.
