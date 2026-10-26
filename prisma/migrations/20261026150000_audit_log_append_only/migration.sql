-- Trilha de auditoria imutável: somente INSERT (mesmo padrão de FinancialLedgerEntry_immutable).
-- Gatilho por linha: TRUNCATE (limpeza do seed e dos testes) não é afetado.
-- Consequência: excluir um User/Organization referenciado em AuditLog falha, porque o
-- ON DELETE SET NULL das FKs vira um UPDATE bloqueado. Desative/anonimize em vez de excluir.
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog é somente inserção (operação % bloqueada)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_immutable"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
