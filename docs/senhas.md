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
