# Carteiras digitais (Apple Wallet e Google Wallet)

O código já gera os passes; cada carteira fica **desligada** até as variáveis de
ambiente dela estarem preenchidas. Desligada, nada aparece para o comprador.
Ligada:

- **Página do ingresso** (`/ingressos/[code]`, só ingresso válido): botões
  "Adicionar à Apple Wallet" e/ou "Salvar no Google Wallet".
- **Meus ingressos**: "Apple Wallet" / "Google Wallet" ao lado de cada ingresso
  válido de pedido pago, sem transferência pendente.
- **Página do pedido**: "Adicionar todos à Apple Wallet" (um `.pkpasses`, que o
  iOS 15+ adiciona de uma vez) e "Salvar todos no Google Wallet", com os ingressos
  válidos que ainda estão com o comprador.
- **E-mail da compra**: um `.pkpass` por ingresso anexado (Apple) e um link
  "Salvar os ingressos no Google Wallet" que salva todos os ingressos do pedido.

Só ingressos **válidos** viram passe (usado ou cancelado: a rota responde 410).
O passe traz o mesmo QR do ingresso e do PDF, e a portaria continua validando
online: a carteira é só o reflexo para o comprador.

### Atualização do passe

Cada passe entregue fica registrado (`WalletPass`), **um por versão do QR**:
serial Apple `<código>-v<versão>` e objeto Google `<issuer>.ingresso-<código>-v<versão>`.
A transferência gera uma versão nova; o novo titular salva outro passe e o do
titular anterior nunca recebe o QR novo.

O cron (`/api/cron/maintenance`, etapa `syncWalletPasses`) compara o estado do
ingresso com o do passe e atualiza a carteira:

| Ingresso | Passe |
| --- | --- |
| válido, mesma versão do QR | ACTIVE (QR visível) |
| utilizado (check-in) | COMPLETED |
| reembolsado ou evento cancelado | INACTIVE |
| transferido (versão do QR substituída) | INACTIVE, sem o nome do novo titular |
| reembolso desfeito pelo admin | volta a ACTIVE |

- **Google**: muda o `state` do objeto pela API (`PATCH eventTicketObject`).
- **Apple**: marca o passe como alterado e manda um push vazio (APNs) aos aparelhos
  registrados; o aparelho baixa o passe de novo pelo web service, agora anulado
  (`voided`) e sem QR. Só funciona com `APP_URL` em **HTTPS**: em HTTP o passe sai
  sem `webServiceURL` (como antes, sem atualização).
- Falha na API ou no push: o passe tenta de novo nos próximos ciclos (até 8 vezes;
  o erro fica em `WalletPass.syncError`). Token de push recusado pela Apple (410)
  apaga o registro do aparelho.

Passes do Google salvos antes desta versão usavam o objeto sem versão
(`ingresso-<código>`) e não são acompanhados; como nenhuma carteira estava
configurada, não há passes antigos a migrar.

Código: `src/server/tickets/wallet/` (`passes.ts`: registro, web service e
sincronização; `apple-push.ts`: APNs). Rotas:
- `/api/tickets/[code]/wallet/apple` e `/api/tickets/[code]/wallet/google`
- `/api/orders/[orderId]/wallet/apple` e `/api/orders/[orderId]/wallet/google`
- Web service da Apple (`webServiceURL` = `<APP_URL>/api/wallet/apple`):
  `POST/DELETE /v1/devices/<aparelho>/registrations/<passType>/<serial>`,
  `GET /v1/devices/<aparelho>/registrations/<passType>?passesUpdatedSince=`,
  `GET /v1/passes/<passType>/<serial>` e `POST /v1/log`. Autenticação
  `ApplePass <token>`, com token derivado do serial (HMAC com `AUTH_SECRET`, nada
  guardado).

Testes: `tests/unit/wallet.test.ts` (certificados autoassinados só de teste) e
`tests/integration/zz-wallet-passes.test.ts` (registro, sincronização, web service).

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

Abra o ingresso num Android e toque em "Salvar no Google Wallet". Antes de
redirecionar, o servidor grava pela API REST (`walletobjects.googleapis.com`) a
classe do evento (status `UNDER_REVIEW`; o Google aprova automaticamente as
classes de emissores publicados) e o objeto de cada ingresso; se já existem, são
atualizados com os dados atuais. O link leva só os ids dos objetos: o Google
limita o link de salvar a ~1800 caracteres, e a classe e o objeto completos de
um único ingresso já passam disso. Por isso o servidor precisa de saída HTTPS
para `oauth2.googleapis.com` e `walletobjects.googleapis.com`.

## Segurança

- Chaves e certificados só em variáveis de ambiente ou num cofre de segredos,
  nunca no repositório. `.env` não é versionado.
- O passe contém o mesmo token do QR que o PDF. Por isso as rotas exigem login e
  só entregam ingressos do próprio comprador. O e-mail leva os `.pkpass` (Apple)
  e um link que exige login (Google), sem token na URL do e-mail. O link do
  Google também não leva o token: ele fica no objeto gravado pela API.
- Falha ao gerar os `.pkpass` (certificado vencido, chave errada) não impede o
  e-mail: ele segue só com o PDF e o erro fica no log.
- O web service da Apple só responde a quem apresenta o token do próprio passe.
  Trocar `AUTH_SECRET` invalida esses tokens: os passes Apple já salvos param de
  receber atualização (continuam com o QR, que a portaria valida online).
- Saída de rede necessária: `api.push.apple.com:443` (HTTP/2, certificado do Pass
  Type ID) para os avisos da Apple, além das do Google acima.

## QR rotativo no Google Wallet (opcional)

Com o QR dinâmico, os passes são só comprovante. O Google Wallet aceita um **código rotativo** dentro do passe. Com `GOOGLE_WALLET_ROTATING_QR=true`:
- **No passe:** o objeto ganha `rotatingBarcode` (`walletRotatingBarcode` em `wallet/google.ts`).
  - O Google gera `EB3:<código>:<segundos>:<TOTP>` a cada 30 s (TOTP do RFC 6238, SHA-1, 8 dígitos).
  - O segredo é por ingresso e versão (`deriveWalletTotpKey`) e só o servidor e o Google o têm.
- **Na portaria:** `checkInTicket` confere o TOTP. As regras são as mesmas do QR do celular: passo dentro da tolerância, "QR EXPIRADO" para print antigo e "QR SUBSTITUÍDO" depois de uma transferência.
- **Só online:** o segredo não vai para a lista offline, para que um aparelho perdido não gere códigos. Sem internet, o leitor mostra "QR da carteira do Google precisa de internet".
- **Apple Wallet:** não tem código rotativo, então continua comprovante.

**Para ligar:**
1. **Pedir a aprovação:** os códigos rotativos são um recurso que o Google libera por emissor. Peça a habilitação de *rotating barcodes* para o Issuer ID no Google Pay & Wallet Console / suporte do Google Wallet, conforme a documentação atual do Google. Sem a aprovação, a API pode recusar ou ignorar o campo.
2. **Configurar:** depois da aprovação, defina `GOOGLE_WALLET_ROTATING_QR=true` e reinicie.
3. **Passes antigos:** o cron de passes só muda a situação (ativo/inativo). Para o QR aparecer num passe já salvo, o titular toca de novo em "Salvar no Google Wallet": o objeto é regravado com os dados atuais.
4. **Testar:** salve um passe num Android, confira que o QR muda e leia na portaria com internet.
