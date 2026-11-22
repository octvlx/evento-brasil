import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Migrações e `prisma migrate` usam a conexão DIRETA do Neon (DATABASE_URL_UNPOOLED, sem
// "-pooler"): o PgBouncer do pooler, em modo transação, quebra Prisma Migrate (ex.:
// "prepared statement already exists"). O app em execução usa DATABASE_URL (pooled) via
// src/server/db.ts. Sem Neon (PostgreSQL local), só existe DATABASE_URL e ela vale para os dois.
const migrationUrl = process.env.DATABASE_URL_UNPOOLED ? env("DATABASE_URL_UNPOOLED") : env("DATABASE_URL");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx --conditions=react-server prisma/seed.ts",
  },
  datasource: {
    url: migrationUrl,
  },
});
