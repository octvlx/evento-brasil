# Páginas públicas e jornada do comprador — inventário e dependências

Responsável: agente `paginas-publicas`. Última revisão: inventário da área pública
e implementação dos estados de pagamento/reembolso no checkout e no pedido
(contrato novo do financeiro).

## O que existe

| Funcionalidade | Onde | Estado |
| --- | --- | --- |
| Layout, cabeçalho com sessão, menu móvel, rodapé, tokens claro/escuro, PWA (manifest + service worker) | `layout.tsx`, `components/site/header.tsx`, `mobile-nav.tsx`, `footer.tsx`, `globals.css`, `manifest.ts` | Pronto |
| Home: hero com busca, destaques, categorias, cidades, fim de semana, chamada para organizadores | `/`, `featuredEvents`, `weekendEvents`, `listCities` em `catalog.ts` | Pronto (sem "organizadores em destaque" nem recomendações) |
| Busca: texto, cidade, categoria, data (hoje/amanhã/fim de semana/7/30 dias), preço (faixas e grátis), paginação, contagem, filtros na URL, estado vazio | `/eventos`, `searchEvents` | Pronto (sem ordenação; sem intervalo de datas livre) |
| Detalhe do evento: capa, data/fuso, local, descrição, organizador, tipos de ingresso com disponibilidade, compra, política de reembolso, compartilhar no WhatsApp, metadados + OpenGraph + JSON-LD `Event` | `/eventos/[slug]`, `getPublicEvent`, `ticket-selector.tsx` | Pronto (sem eventos relacionados) |
| Página de cidade com filtro por categoria e metadados | `/cidades/[slug]` | Pronto (sem destaques próprios nem busca textual) |
| Perfil público do organizador: nome, descrição, site, Instagram, selo verificado (organização aprovada), próximos eventos | `/organizadores/[slug]`, `getPublicOrganizer` | Pronto (sem logo/capa, sem eventos anteriores) |
| Entrar / Registrar com validação, mensagens acessíveis, `next` seguro (`safeNext`) | `/entrar`, `/registrar`, `features/auth/` | Pronto (sem mostrar/ocultar senha) |
| Checkout: resumo calculado no servidor, contagem da reserva, reserva expirada, PIX (QR + copia e cola), cartão simulado, simulador de webhook só em dev, aviso de pagamento simulado | `/checkout/[orderId]`, `checkout-panel.tsx` | Pronto |
| **Checkout com tentativa de cartão em processamento** (não oferece nova tentativa) e recarga quando `startPaymentAction` devolve `INVALID_STATE` | `checkoutStep` em `features/orders/status-view.ts` | **Novo** |
| Pedido: status, reconsulta ao provedor enquanto pendente (nunca confia no redirect), cancelar pedido pendente, ingressos, resumo, solicitar reembolso | `/pedido/[orderId]`, `order-actions.tsx` | Pronto |
| **Situação do reembolso** (em andamento, em reprocessamento após falha no provedor, concluído, recusado) com valor e data de cada reembolso; motivo do cancelamento em cada ingresso | `refundView`, `revocationText` em `status-view.ts`; `/pedido/[orderId]`, `/ingressos/[code]` | **Novo** |
| Meus ingressos: próximos/anteriores agrupados por evento, status do ingresso, histórico de pedidos (com selo de status) | `/meus-ingressos` | Pronto (o histórico de pedidos fica nesta página; não há `/meus-pedidos`) |
| Ingresso: QR só para ingresso válido, PDF, código, titular, aviso de meia-entrada | `/ingressos/[code]` | Pronto |
| Minha conta (perfil) | `/minha-conta` | Pronto |
| Ajuda, termos, privacidade, 404 em pt-BR; páginas privadas com `noindex` | `/ajuda`, `/termos`, `/privacidade`, `not-found.tsx` | Pronto |
| sitemap (eventos públicos, cidades com evento, organizadores aprovados), robots, `error.tsx`/`global-error.tsx`, imagem OG padrão (também em páginas com `openGraph` próprio), canonical e `noindex` com filtros em `/eventos` | `sitemap.ts`, `robots.ts`, `error.tsx`, `global-error.tsx`, `opengraph-image.tsx`, `lib/site.ts` | Pronto |

Testes: unidade em `tests/unit/order-status-view.test.ts`; E2E em
`tests/e2e/public.spec.ts` (descoberta, busca, cidade, 404, reembolso) e
`purchase-checkin.spec.ts` (compra com PIX simulado até o check-in).

## Contrato novo do financeiro (`docs/areas/financeiro.md`) — como a UI trata

| Mudança | Tratamento |
| --- | --- |
| `startPaymentAction` pode devolver `INVALID_STATE` ("cartão em processamento" / "pedido não está aguardando pagamento") | O botão já ficava desabilitado durante a ação. Agora, com `INVALID_STATE`, a mensagem aparece e a página é recarregada: pedido que não está pendente vai para `/pedido/[id]`; tentativa de cartão pendente mostra "Pagamento com cartão em processamento" sem botão de pagar. |
| No máximo uma tentativa ativa por pedido; PIX pendente é reaproveitado | `checkoutStep` deriva a tela da tentativa pendente: PIX → QR existente; cartão → em processamento; nenhuma → escolha do método. |
| Ingressos cancelados assim que o reembolso é solicitado; estorno recusado deixa o pedido em `REFUND_PENDING` com reembolso `FAILED` | O pedido mostra um aviso com a situação ("em andamento" / "em reprocessamento — não é preciso solicitar de novo" / "concluído"), a lista de reembolsos com valor, data e status, e cada ingresso cancelado mostra o motivo (também na página do ingresso). |

## O que falta (por prioridade)

1. ~~**Incorporar o SEO/erros**~~ (sitemap, robots, páginas de erro, OG padrão,
   canonical) — feito.
2. **Ordenação na busca** (data, preço, relevância) em `/eventos` e nas cidades —
   só `catalog.ts` + página.
3. **`/cidades`** (visão geral das cidades) e destaques/busca na página da cidade.
4. **Eventos relacionados** na página do evento (mesma categoria/cidade).
5. **Perfil do organizador:** eventos anteriores; logo e capa quando o banco tiver
   os campos.
6. **Autenticação:** mostrar/ocultar senha; recuperação e redefinição de senha
   (dependem de backend — ver abaixo).
7. **Home:** organizadores em destaque e recomendações.
8. **Meus ingressos:** paginação do histórico (hoje limitado a 30 pedidos) e
   `/meus-pedidos` dedicado se o negócio quiser.
9. **Cupom no checkout** (depende do financeiro).

## Comparação com a Duoticket (duoticket.com.br)

Observação das páginas públicas em 26/10/2026 (home, uma página de evento com o
seletor de ingressos, uma página de produtor). Sem login, sem compra; um evento,
um momento — o app e a área do produtor não foram vistos. Lista apenas
funcionalidades; nada de texto, código ou visual deve ser copiado.

**O que eles têm e nós não**

| Funcionalidade | Situação aqui | Quem |
| --- | --- | --- |
| Transferência de ingresso em "Meus Ingressos" e troca do titular 1× até 48h antes | Titular só na compra | `check-in` + `pagamentos-financeiro` (novo dono, novo QR) |
| Links "Abrir Waze" / "Abrir Maps" com endereço completo | Local sem links de mapa | Esta área (esconder quando não houver endereço) |
| Ingressos agrupados por setor (ex.: Backstage/Frontstage), com lotes e preços por gênero | Lista plana de tipos | `area-organizador` + `banco-de-dados` (campo de setor) |
| "Lote especial": código que libera lote oculto | Tipos ocultos existem, sem código | `pagamentos-financeiro` + `area-organizador` |
| Mapa do evento (imagem clicável) | Não existe | `area-organizador` (upload) + esta área |
| Bloco de orientações gerais (documento, menores, cashless) | Só a política de reembolso | `area-organizador` (campo de regras) |
| App nativo | Web + service worker | Fora do escopo |

**Onde estamos à frente:** busca com categoria, data, preço, paginação e
contagem (eles: texto + cidade e uma lista única); JSON-LD e OpenGraph corretos
(a página de evento deles não tem JSON-LD e aponta `og:url` para a home);
reembolso pela própria página do pedido com status (eles: por e-mail); taxa de
serviço e total visíveis antes do pagamento (eles mostram só "+ Taxa Adm." antes
de finalizar).

**Igual:** preço por lote, meia-entrada, regra de reembolso de 7 dias / 48h,
página do produtor com próximos eventos, aviso de que a plataforma não organiza
o evento.

**Candidatos à lista de lacunas:** (a) links Waze/Maps na página do evento — desta
área, pequeno; (b) transferência de ingresso — maior lacuna de funcionalidade,
depende de `check-in` e `pagamentos-financeiro`; (c) setores e códigos de lote —
dependem de schema (`banco-de-dados`).

## Comparação com o Rausgegangen (rausgegangen.de)

Observação das páginas públicas em 26/10/2026: página da cidade
(`/cologne/`), uma página de evento e a busca (`/eventsearch/`). Sem login; uma
cidade, um evento, um momento — o app não foi visto. Lista apenas
funcionalidades; nada de texto, código ou visual deve ser copiado.

É um guia de cidade com curadoria editorial, não só uma bilheteria: a página da
cidade funciona como um portal, enquanto a nossa `/cidades/[slug]` é uma lista
filtrada. Essa é a maior diferença.

**Página da cidade**

| Funcionalidade | Situação aqui | Quem |
| --- | --- | --- |
| Abas Hoje / Amanhã / Fim de semana, cada uma com URL própria | Só filtro de categoria | Esta área (`catalog.ts`), sem schema |
| Uma faixa horizontal por categoria, cada uma com link para sua página | Uma lista única | Esta área |
| Dicas do dia da redação (com nota do editor), blog da cidade, sorteios, coleções sazonais | Nada editorial | Decisão de produto; conteúdo depende de `admin` |
| "Recomendados para você" e "Mitgegangen" (o que amigos vão), com login | Não existe | Depende de dados de interesse/seguidores (`banco-de-dados`) |
| Seção de locais da cidade com tipo (museu, bar, praça) e botão "Seguir" | Não há páginas de local | `banco-de-dados` + esta área |
| Texto de SEO sobre a cidade, JSON-LD `WebPage` + `ItemList`, canonical, versões de/en | Só metadados; sem `/cidades` | Esta área |

**Página do evento**

| Funcionalidade | Situação aqui | Quem |
| --- | --- | --- |
| Blocos separados: texto da redação e texto do organizador | Só o do organizador | Decisão de produto |
| "Salvar evento", botão de calendário (aparentemente "adicionar à agenda"; não foi clicado) e "Seguir" artista/organizador | Não existe | Calendário (.ics): esta área; salvar/seguir: `banco-de-dados` |
| Seção "Acessibilidade" (vazia neste evento, mas o campo existe) | Não existe | `area-organizador` + `banco-de-dados` |
| Outras datas do mesmo evento/turnê e eventos relacionados | Não existe (relacionados já é a lacuna nº 4) | Esta área |
| Breadcrumb (cidade › categoria) com JSON-LD `BreadcrumbList`, além do `Event` | Temos `Event`, sem breadcrumb | Esta área |
| Preço exibido já com taxas ("inkl. Gebühren") | Mostramos taxa e total separados no checkout | — |
| Ingressos muitas vezes de terceiros (este evento abria a Eventim em nova aba); alguns vendidos por eles | Vendemos todos os ingressos | — |

**Busca:** cidade, intervalo de datas livre ("Von – Bis"), categoria, "entrada
grátis", sorteios e "perto de mim" (por localização). Não vimos filtro de faixa
de preço nem ordenação. Comparado conosco: eles têm intervalo de datas livre e
busca por proximidade; nós temos faixas de preço; nenhum dos dois ordena.

**Candidatos à lista de lacunas:** (a) abas Hoje/Amanhã/Fim de semana com URL
própria e faixas por categoria na página da cidade — desta área, sem schema;
(b) adicionar à agenda (.ics) e outras datas do mesmo evento; (c) breadcrumb com
JSON-LD; (d) intervalo de datas e "perto de mim" na busca — proximidade depende
de coordenadas no banco; (e) salvar/seguir, campo de acessibilidade e páginas de
local — dependem de `banco-de-dados`; (f) curadoria editorial/blog — decisão de
produto.

## Dependências de outros agentes

| Agente | O que precisamos |
| --- | --- |
| `pagamentos-financeiro` | Cupons/descontos calculados no servidor (`createOrder`) antes de qualquer campo de cupom. Notificação por e-mail de reembolso concluído (outbox) — a UI promete "avisaremos por e-mail". Se a política para reembolso `FAILED` mudar (restaurar ingressos), o texto de `refundView` precisa acompanhar. |
| `banco-de-dados` | `Organization.logoUrl`/`coverUrl` para o perfil público; tabela de tokens de redefinição de senha (com expiração e uso único). |
| Equipe (auth/infra) | Recuperação de senha: `requestPasswordReset(email)` (resposta sempre igual, sem revelar se o e-mail existe; limite de tentativas), `resetPassword(token, novaSenha)` (invalida sessões), e-mail transacional via `EMAIL_PROVIDER`. A UI (`/recuperar-senha`, `/redefinir-senha`) só depois desse contrato. |
| `area-organizador` | Dados públicos do organizador (descrição, site, Instagram) vêm do perfil editado no painel; logo/capa quando existirem. |
| `check-in` | Formato do QR e PDF do ingresso (`qrPayload`, `/api/tickets/[code]/pdf`) — a página do ingresso apenas exibe. |
