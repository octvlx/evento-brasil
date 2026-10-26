# Como contribuir

## Primeira vez

1. Instale **Node.js LTS** (20.19+) e **Git**.
2. Clone em um caminho curto (no Windows, ex.: `C:\dev`):
   ```bash
   git clone https://github.com/<organizacao>/evento-brasil.git C:\dev\evento-brasil
   ```
3. Dê dois cliques em `INICIAR-EVENTO-BRASIL.bat` (Windows) — instala, prepara o
   banco local com dados de demonstração e abre `http://localhost:3000`.
   Em macOS/Linux, siga o README.

Cada pessoa tem **o seu próprio banco local**. Nunca aponte o `.env` para o banco
de homologação ou de produção.

## Fluxo de trabalho

```bash
git switch main
git pull
git switch -c feat/descricao-curta      # ou fix/…, docs/…, chore/…
# … trabalhe e faça commits pequenos …
npm run lint && npm run typecheck && npm test
git push -u origin feat/descricao-curta
```

Depois abra um **pull request** para `main`. Ele precisa de:

- CI verde (lint, tipos, testes unitários e de integração, build);
- ao menos 1 aprovação (e do CODEOWNER, em áreas sensíveis).

Mescle com **Squash and merge** e apague a branch.

### Nomes de branch

| Prefixo | Uso |
| --- | --- |
| `feat/` | funcionalidade nova |
| `fix/` | correção |
| `docs/` | documentação |
| `chore/` | dependências, configuração |

## Banco de dados

- Mudou `prisma/schema.prisma`? Gere a migração e faça commit junto com o código:
  ```bash
  npm run db:migrate -- --name descricao-da-mudanca
  ```
- **Nunca edite** uma migração já mesclada na `main`; crie outra.
- Depois de `git pull`, rode o `.bat` (ou `npm run db:deploy`) para aplicar as
  migrações dos colegas sem apagar seus dados.
- `npm run db:seed` **apaga todo o banco local** e recria os dados de demonstração.

## Regras do projeto

- Dinheiro sempre em **centavos inteiros**; nunca confie em preço, estoque,
  permissão ou status de pagamento vindo do cliente.
- Regras de negócio ficam em `src/server/services/` e recebem o usuário (`Actor`)
  para checar permissão; telas e actions só chamam os serviços.
- Mudanças em pagamentos, razão, reembolsos, estoque ou permissões exigem testes
  de integração.
- Textos para o usuário em **pt-BR**.
- Segredos só em `.env` (local) ou nas variáveis do ambiente de hospedagem.
  Mantenha `.env.example` atualizado.
- Antes de usar uma API do Next.js 16, consulte `node_modules/next/dist/docs/`
  (há mudanças importantes, ex.: Cache Components).

## Agentes do Claude por área

`.claude/agents/` define um agente especialista para cada área. Eles são
carregados automaticamente pelo Claude Code de quem clonar o repositório.
Cada um sabe quais pastas pode editar, as regras da área e quais testes rodar.

| Agente | Área |
| --- | --- |
| `paginas-publicas` | Home, busca, página do evento, área do comprador, componentes e design |
| `area-organizador` | Painel `/organizador`, eventos, organizações, relatórios, equipe |
| `pagamentos-financeiro` | Pedidos, estoque, pagamentos, comissão, razão, reembolsos (crítica) |
| `check-in` | Leitor de QR, validação atômica, equipe de portaria |
| `admin` | Painel `/admin`, aprovações, moderação, comissões, auditoria |
| `banco-de-dados` | `prisma/` (schema, migrações, seed) e scripts do PostgreSQL local |

Como usar: peça ao Claude, por exemplo, *"use o agente area-organizador para
adicionar um campo de lotação por setor"*, ou deixe o Claude escolher pela
descrição. Uma tarefa que cruza áreas (ex.: nova coluna + tela) passa por mais
de um agente: `banco-de-dados` primeiro, depois a área da tela.

## Ambientes

| Ambiente | Origem | Banco |
| --- | --- | --- |
| Local | sua branch | PostgreSQL local de cada pessoa |
| Homologação (staging) | deploy automático da `main` | PostgreSQL gerenciado, próprio |
| Produção | deploy aprovado manualmente | PostgreSQL gerenciado, isolado |
