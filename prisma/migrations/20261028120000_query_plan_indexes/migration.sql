-- Fase 4: índices justificados por EXPLAIN (ANALYZE, BUFFERS) num volume
-- sintético (scripts/query-plans/). Somente aditiva. Medidas em docs/database.md.

-- Lista de transferências do admin por status, mais recentes primeiro.
-- CreateIndex
CREATE INDEX "TicketTransfer_status_createdAt_idx" ON "TicketTransfer"("status", "createdAt");

-- Pedidos de cancelamento decididos no admin, mais recentes primeiro.
-- CreateIndex
CREATE INDEX "CancellationRequest_status_decidedAt_idx" ON "CancellationRequest"("status", "decidedAt");

-- Auditoria filtrada por prefixo de ação (`action LIKE 'ticket.transfer.%'`,
-- presets do admin). text_pattern_ops faz o LIKE por prefixo usar o índice em
-- qualquer collation (com collation diferente de C, um btree comum não serve).
-- Escrito à mão: o Prisma não expressa operator class em btree e, num índice
-- comum, `migrate diff` propõe derrubá-lo e recriá-lo a cada migração. Como
-- índice parcial o Prisma o ignora (como os únicos parciais da Fase 2). O
-- predicado é sempre verdadeiro (`action` é NOT NULL) e todo `LIKE` o implica.
CREATE INDEX "AuditLog_action_prefix_idx" ON "AuditLog"("action" text_pattern_ops, "createdAt") WHERE "action" IS NOT NULL;
