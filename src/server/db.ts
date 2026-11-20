import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

/**
 * Força a sessão do PostgreSQL em UTC. O `@prisma/adapter-pg` envia datas em UTC SEM
 * fuso ("2026-11-20 23:10:00") e, na leitura, troca o fuso devolvido por "+00:00": ele
 * pressupõe sessão em UTC. Num servidor com outro fuso (ex.: initdb local em
 * America/Sao_Paulo) o instante gravado ficava deslocado (23:10Z virava 23:10-03) e
 * `now()`, comparações e agrupamentos por hora em SQL divergiam do que o app lê.
 * Vai no parâmetro `options` da URL (o `pg` dá prioridade à URL sobre a configuração),
 * somado ao que já houver lá; um TimeZone anterior é substituído.
 */
export function withUtcSession(connectionString: string): string {
  const url = new URL(connectionString);
  const current = (url.searchParams.get("options") ?? "").replace(/-c\s*TimeZone=\S+/gi, "").trim();
  url.searchParams.set("options", [current, "-c TimeZone=UTC"].filter(Boolean).join(" "));
  return url.toString();
}

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) throw new Error("DATABASE_URL não definida");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: withUtcSession(connectionString) }) });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

/** Opções padrão para transações críticas (estoque, pagamentos, check-in). */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
