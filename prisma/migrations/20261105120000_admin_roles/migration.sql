-- Sub-papéis do admin da plataforma (T6). Aditiva: novo enum e coluna com padrão
-- vazio. Os admins que já existem viram SUPER_ADMIN para ninguém perder acesso.
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'FINANCE', 'MODERATION', 'SUPPORT');

ALTER TABLE "User" ADD COLUMN "adminRoles" "AdminRole"[] NOT NULL DEFAULT ARRAY[]::"AdminRole"[];

UPDATE "User" SET "adminRoles" = ARRAY['SUPER_ADMIN']::"AdminRole"[] WHERE "platformRole" = 'ADMIN';

-- Papel de admin só em conta admin.
ALTER TABLE "User" ADD CONSTRAINT "User_admin_roles_only_for_admin"
    CHECK ("platformRole" = 'ADMIN' OR cardinality("adminRoles") = 0);
