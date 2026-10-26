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
| sitemap, robots, `error.tsx`/`global-error.tsx`, imagem OG padrão, canonical em `/eventos` e no perfil do organizador | branch `feat/seo-erros-paginas-publicas` (commit `9040ed4`) | **Feito, mas não incorporado ao `main`** |

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

1. **Incorporar o SEO/erros** do commit `9040ed4` (sitemap, robots, `error.tsx`,
   `global-error.tsx`, OG padrão, canonical). Pronto numa branch; precisa de
   rebase/PR. Sem `error.tsx`, uma falha de banco mostra a tela padrão do Next.
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

## Dependências de outros agentes

| Agente | O que precisamos |
| --- | --- |
| `pagamentos-financeiro` | Cupons/descontos calculados no servidor (`createOrder`) antes de qualquer campo de cupom. Notificação por e-mail de reembolso concluído (outbox) — a UI promete "avisaremos por e-mail". Se a política para reembolso `FAILED` mudar (restaurar ingressos), o texto de `refundView` precisa acompanhar. |
| `banco-de-dados` | `Organization.logoUrl`/`coverUrl` para o perfil público; tabela de tokens de redefinição de senha (com expiração e uso único). |
| Equipe (auth/infra) | Recuperação de senha: `requestPasswordReset(email)` (resposta sempre igual, sem revelar se o e-mail existe; limite de tentativas), `resetPassword(token, novaSenha)` (invalida sessões), e-mail transacional via `EMAIL_PROVIDER`. A UI (`/recuperar-senha`, `/redefinir-senha`) só depois desse contrato. |
| `area-organizador` | Dados públicos do organizador (descrição, site, Instagram) vêm do perfil editado no painel; logo/capa quando existirem. |
| `check-in` | Formato do QR e PDF do ingresso (`qrPayload`, `/api/tickets/[code]/pdf`) — a página do ingresso apenas exibe. |
