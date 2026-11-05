# Eventos externos (descoberta)

Eventos publicados em outras plataformas aparecem na QQPega como **"Evento externo"**:
só com dados públicos e factuais, com a fonte visível e um botão **"Ver ingressos no site
oficial"**. A compra acontece fora da plataforma.

## Viabilidade das fontes (verificada em 05/11/2026)

| Fonte | Situação | Por quê |
|---|---|---|
| **Duoticket** (duoticket.com.br) | **Viável — adaptador implementado** (começa pausada) | `robots.txt` permite tudo, exceto `/validador/`. Os termos proíbem copiar marcas, logotipos, slogans, interface e software, não dados factuais de eventos. A home lista os eventos em HTML e a página de cada evento traz título, data (sem horário), local e "Cidade \| Estado". Preço e lotes vêm de endpoints internos via JavaScript: **não usamos**. |
| **Sympla** (sympla.com.br) | **Depende de autorização** — sem coleta | A API oficial é licenciada para integrar a aplicação do próprio usuário, com token por conta de produtor, e não serve como catálogo de terceiros. A divulgação de eventos de terceiros é feita pelo **Programa de Afiliados Sympla** (via Buzzlead), com cadastro e campanhas escolhidas pelos produtores. Os termos definem "crawler" e a coleta de páginas não foi adotada. |
| **Q2 Ingressos** (q2ingressos.com.br) | **Depende de autorização** — sem coleta | O site é um app em JavaScript (Expo) com fila de acesso (queue-it). A lista de eventos só existe via API interna do site, e os termos não são acessíveis sem executar o app. Não há API pública nem feed conhecidos. Não contornamos proteções nem usamos endpoints privados. |

Para liberar Sympla ou Q2 é preciso de uma forma autorizada: a API ou o programa de
afiliados da Sympla, ou um acordo ou feed com a Q2. Com isso, cria-se um adaptador novo em
`src/server/external/adapters/` e a fonte passa a ter coleta.

## Como funciona

- **Tabelas próprias** (`ExternalSource`, `ExternalEvent`, `ExternalImportRun`, migração
  `20261106120000_external_events`, só aditiva). Eventos externos não são `Event`: não
  passam por pedidos, estoque, ingressos, check-in, comissão nem razão financeiro.
- **Coleta segura** (`src/server/external/safe-fetch.ts`):
  - só HTTPS e só os hosts da fonte, conferidos também em cada redirecionamento;
  - DNS conferido contra localhost e redes privadas ou reservadas;
  - timeout, limite de tamanho e tentativas com espera progressiva;
  - identificação `QQPegaBot`.
- **Adaptador por fonte** (`src/server/external/adapters/*.ts`). Texto de terceiros vira
  texto puro (`text.ts`), sem HTML.
- **Importação** (`runExternalImport` em `src/server/services/external-events.ts`):
  - **Idempotente:** a chave é a fonte mais o id na fonte, e a URL é única. Evento igual só
    renova `lastSeenAt`.
  - **Mudanças:** data, local, preço e status atualizam o mesmo registro (detecção por
    hash).
  - **Limites:** até 50 eventos por execução manual e 25 no cron, com pausa de 1,2 s entre
    páginas. Uma importação por vez por fonte.
  - **Falhas:** a falha de uma página não para as outras. A falha da listagem não apaga nem
    marca nada.
  - **Ausência:** só é marcada (`MISSING`) com a listagem **inteira** lida e sem erros.
    **Nunca apaga.**
  - **Cancelamento:** só quando a página diz explicitamente.
  - **Preço:** ausente fica `UNKNOWN` e nunca vira gratuito, com um `CHECK` no banco.
  - **Horário:** sem horário, a data vale como dia inteiro (`hasTime = false`), no fuso da UF.
  - **Possível duplicado:** mesmo dia, mesma cidade e título parecido com outra fonte ou com
    um evento nativo. Só sinaliza para revisão, nunca une.
  - Evento novo entra em **revisão** (`PENDING_REVIEW`).
- **Agendamento:** etapa `runExternalSyncIfDue` no cron de manutenção, no máximo a cada 6 h
  por fonte ativa. Nenhuma coleta acontece em requisição de visitante.
- **Administração** (`/admin/eventos-externos`, permissão `events:moderate`):
  - fontes, com ativar ou pausar; fontes que precisam de autorização não podem ser ativadas;
  - importação limitada;
  - últimas execuções, com os erros;
  - revisão: publicar, ocultar, voltar para revisão e link para conferir a página original.
  
  Tudo fica na auditoria.
- **Público:**
  - página `/eventos-externos/[slug]` com texto factual próprio, sem copiar descrição nem
    imagem;
  - seção "Também acontecendo" na busca (sem filtros de categoria, preço ou data) e
    "Também em {cidade}" nas cidades;
  - saída por `/eventos-externos/[slug]/ir`, que só redireciona para a URL original HTTPS
    de host da fonte.
- **SEO:**
  - indexa só eventos publicados, ativos, futuros e com cidade e UF; o canonical é a
    própria página;
  - entram no sitemap;
  - o JSON-LD `Event` vai sem preço, disponibilidade nem avaliações.
- **Métricas:** `viewCount` (beacon do navegador; respeita "Não rastrear") e
  `outboundClicks` são contadores agregados, sem dado pessoal, como em
  `TrackingLink.clicks`. **Clique de saída não é compra.**

## Operação

1. Rodar `npm run db:deploy`. A migração cria as três fontes; a Duoticket começa
   **pausada**.
2. Em `/admin/eventos-externos`, **Ativar** a Duoticket e usar **Importar agora**, que traz
   até 50 eventos para revisão.
3. Revisar cada evento, conferindo a página original, e **Publicar** ou **Ocultar**.
4. A partir daí, o cron atualiza a cada 6 h.

## Limitações conhecidas

- O parser da Duoticket depende do HTML atual da página (rótulos "DATA" e "LOCAL"). Se a
  página mudar, os eventos falham individualmente e aparecem nos erros da execução; nada é
  apagado.
- A Duoticket não publica horário nem preço no HTML. Os eventos aparecem com "horário não
  informado" e "preço no site oficial". Alguns produtores escrevem o horário no nome do
  local, e o texto é mantido como veio.
- A home da Duoticket mostra cerca de 100 próximos eventos e é a única listagem usada.
- O DNS é conferido antes da conexão, sem fixar o IP. A lista de hosts limita o alcance.
- Categorias não são importadas, porque a fonte não informa; os eventos externos não entram
  nos filtros de categoria, preço e data da busca.
