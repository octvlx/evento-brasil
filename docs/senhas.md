# Senhas: política, troca e redefinição

## Política (cadastro, redefinição e troca)

Uma única fonte: `src/lib/password-policy.ts`, usada pelo formulário (lista de
requisitos e força enquanto digita) e revalidada no servidor.

- 8 a 128 caracteres; não pode ser só espaços.
- Pelo menos uma maiúscula, uma minúscula, um número e um caractere especial.
- Recusa senhas óbvias: palavra comum (senha, password, brasil, times de futebol,
  evento…) com números ou símbolos em volta, sequências e repetições.
- Senhas antigas que não seguem a política continuam entrando; a regra vale para
  toda senha **nova**.

O indicador de força (Fraca/Média/Forte) é calculado no navegador, sem enviar a senha
a lugar nenhum. Não basta ter os quatro tipos de caractere: comprimento e variedade
pesam; sequências, anos e repetições derrubam a nota. Optamos por não incluir o
`zxcvbn` (≈ 800 kB no bundle e dependência nova); a estimativa é só orientação, e o que
bloqueia é a política acima mais a checagem de vazamentos.

## Senhas vazadas (Pwned Passwords)

`src/server/auth/breached-password.ts`, só no servidor, nos três fluxos.

- **k-anonimato:** sai do servidor apenas o prefixo de 5 caracteres do SHA-1; o resto
  é comparado localmente. Cabeçalho `Add-Padding: true` esconde o tamanho da resposta.
- Nada da senha nem do hash vai para o log.
- **Falha aberta:** se o serviço não responder em 2,5 s ou der erro, a senha é aceita só
  com a política local e o log registra apenas "consulta indisponível". Uma API
  externa fora do ar não bloqueia cadastro, redefinição nem troca.
- `PASSWORD_BREACH_CHECK`: vazio = ligado (desligado nos testes); `false` desliga.

## Alterar senha em Minha conta

Seção "Segurança da conta" em `/minha-conta` (`changePassword` em
`src/server/services/users.ts`, ação `changePasswordAction`).

- A identidade vem da sessão; nenhum id do navegador é aceito.
- **Senha atual obrigatória**, verificada pelo hash. Errada: nada muda, a sessão
  continua, e 5 erros em 15 min bloqueiam novas tentativas por um tempo (por usuário).
- Nova senha diferente da atual, confirmação igual, política + vazamentos.
- Sob trava do usuário: se outra troca terminou antes, a "senha atual" informada já
  não vale (sem sobrescrever a troca recente).
- Sucesso: grava o novo hash, **mantém a sessão atual e encerra as outras** (sessões
  ficam no banco, a revogação é real), invalida links de redefinição pendentes,
  audita (`user.password_changed`, sem dados da senha) e envia o aviso
  "Evento Brasil — Sua senha foi alterada".
- Conta criada pelo Google não tem senha local: a seção mostra "Você utiliza o Google
  para acessar sua conta." (criar senha local para essas contas está fora do escopo).

## Esqueci minha senha

`src/server/services/password-reset.ts`.

- Token aleatório, guardado só como hash, com validade
  (`PASSWORD_RESET_EXPIRATION_MINUTES`) e uso único (atualização condicional sob trava).
- Senha proposta recusada (política, vazamento, confirmação diferente ou **igual à
  senha atual**, comparada pela verificação do hash) **não consome o token**.
- Sucesso: novo hash, todas as sessões encerradas (é preciso entrar de novo, sem login
  automático), outros links invalidados e aviso "Evento Brasil — Sua senha foi
  redefinida". O e-mail nunca leva senha, hash ou token.

## Verificação em duas etapas (TOTP)

**Quem precisa:** administradores da plataforma e donos de organização. Eles mexem em
repasses, comissões e dados de compradores. Com `MFA_REQUIRED` (vazio = só em
produção), essas contas não usam `/admin` nem a área do dono sem 2FA ativo:
`assertPlatformAdmin`, `assertOrgPermission` e `resolveCheckinAccess` respondem
`MFA_REQUIRED`, e as páginas mandam para `/minha-conta/seguranca?exigido=1`.
Qualquer outra conta pode ativar por conta própria.

**Ativação** (`/minha-conta/seguranca`, `src/server/services/two-factor.ts`):
- QR `otpauth://` (HMAC-SHA1, 6 dígitos, 30 s) ou chave para digitar no aplicativo
  (Google Authenticator, Microsoft Authenticator, 1Password, Authy…);
- o segredo fica cifrado (`encryptPII`) e só vale depois de um código correto, até
  15 min;
- ao ativar, são gerados **10 códigos de recuperação**, mostrados uma única vez (só o
  hash fica no banco), e as outras sessões da conta são encerradas.

**Login:** depois da senha (ou do Google), a sessão nasce **pendente**:
- vale 10 min e não autentica nada (`resolveSession` a ignora); `/entrar/verificacao`
  pede o código do aplicativo ou um de recuperação;
- aceita ±30 s de diferença de relógio;
- um código já usado não vale de novo, nem em dois logins simultâneos (`totpLastStep`
  atualizado de forma condicional);
- 5 códigos errados apagam a sessão pendente (`mfa.login_locked`), e há também um teto
  por IP;
- códigos de recuperação valem uma vez (`mfa.recovery_code_used`, com quantos restam).

**Gerenciar:**
- gerar novos códigos de recuperação exige um código do aplicativo;
- desativar exige código e senha e é **recusado para conta obrigada** (admin ou dono
  com `MFA_REQUIRED`);
- tudo vai para a auditoria (`mfa.enabled`, `mfa.disabled`,
  `mfa.recovery_codes_regenerated`);
- a exclusão da conta (L9b) apaga o segredo e os códigos.

**Pendente:** um admin redefinir o 2FA de quem perdeu o celular e os códigos de
recuperação. Até lá, isso é feito pelo suporte direto no banco, com auditoria manual.
