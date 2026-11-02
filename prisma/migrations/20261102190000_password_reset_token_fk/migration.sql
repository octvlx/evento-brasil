-- H3: a migração 20261030120000_transactional_email criou a FK de PasswordResetToken.userId
-- inline (ON UPDATE NO ACTION), diferente do schema (ON UPDATE CASCADE). O `prisma migrate
-- diff` mostrava essa divergência. Recria a FK igual ao schema; nenhum dado muda.
ALTER TABLE "PasswordResetToken" DROP CONSTRAINT "PasswordResetToken_userId_fkey";
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
