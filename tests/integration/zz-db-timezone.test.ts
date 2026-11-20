// Fuso da sessão do banco: o @prisma/adapter-pg envia datas em UTC sem fuso e lê
// timestamptz trocando o fuso por +00:00, então a sessão precisa estar em UTC
// (createPrismaClient força). Aqui o banco ganha fuso padrão de São Paulo (como um
// initdb local) para o teste valer também na CI, cujo servidor já roda em UTC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPrismaClient, withUtcSession } from "@/server/db";
import { db } from "../support/fixtures";

const url = process.env.DATABASE_URL!;
const dbName = new URL(url).pathname.slice(1);
const ident = `"${dbName.replace(/"/g, '""')}"`;
let client: ReturnType<typeof createPrismaClient>;

beforeAll(async () => {
  await db.$executeRawUnsafe(`ALTER DATABASE ${ident} SET timezone TO 'America/Sao_Paulo'`);
  client = createPrismaClient(url);
});
afterAll(async () => {
  await client?.$disconnect();
  await db.$executeRawUnsafe(`ALTER DATABASE ${ident} RESET timezone`);
});

async function serverDefault() {
  const raw = new pg.Client({ connectionString: url });
  await raw.connect();
  try {
    return (await raw.query<{ TimeZone: string }>("SHOW TimeZone")).rows[0].TimeZone;
  } finally {
    await raw.end();
  }
}

describe("sessão do banco em UTC", () => {
  it("o banco do teste está mesmo em outro fuso por padrão", async () => {
    expect(await serverDefault()).toBe("America/Sao_Paulo");
  });

  it("instante gravado pelo Prisma é o mesmo que o SQL enxerga", async () => {
    const at = new Date("2026-11-20T23:10:00.000Z");
    const [r] = await client.$queryRaw<{ tz: string; epoch: string; local: string }[]>`
      SELECT current_setting('TimeZone') AS tz,
             extract(epoch FROM ${at}::timestamptz)::text AS epoch,
             to_char(${at}::timestamptz AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') AS local`;
    expect(r.tz).toBe("UTC");
    expect(Number(r.epoch)).toBe(at.getTime() / 1000);
    // Agrupamento por hora no fuso do evento (relatórios): 23:10Z = 20:10 em São Paulo.
    expect(r.local).toBe("2026-11-20 20:10");

    const user = await client.user.create({ data: { email: `tz-${Date.now()}@test.local`, name: "Fuso", passwordHash: "x", emailVerifiedAt: at } });
    const [stored] = await client.$queryRaw<{ epoch: string }[]>`SELECT extract(epoch FROM "emailVerifiedAt")::text AS epoch FROM "User" WHERE id = ${user.id}`;
    expect(Number(stored.epoch)).toBe(at.getTime() / 1000);
    expect((await client.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toEqual(at);
  });

  it("now() do banco bate com o relógio do app", async () => {
    const before = Date.now();
    const [r] = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    expect(Math.abs(r.now.getTime() - before)).toBeLessThan(5_000);
  });
});

describe("withUtcSession", () => {
  it("acrescenta TimeZone=UTC preservando outras opções e trocando um fuso anterior", () => {
    const opts = (u: string) => new URL(withUtcSession(u)).searchParams.get("options");
    expect(opts("postgresql://u:p@h:5432/db?sslmode=require")).toBe("-c TimeZone=UTC");
    expect(new URL(withUtcSession("postgresql://u:p@h:5432/db?sslmode=require")).searchParams.get("sslmode")).toBe("require");
    expect(opts("postgresql://u:p@h/db?options=endpoint%3Dabc")).toBe("endpoint=abc -c TimeZone=UTC");
    expect(opts("postgresql://u:p@h/db?options=-c%20TimeZone%3DAmerica%2FSao_Paulo%20-c%20statement_timeout%3D5000")).toBe("-c statement_timeout=5000 -c TimeZone=UTC");
  });
});
