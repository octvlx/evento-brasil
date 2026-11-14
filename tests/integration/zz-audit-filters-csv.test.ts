// Auditoria: filtros por período, ator, entidade e ID; exportação CSV autorizada e registrada.
import { beforeEach, describe, expect, it } from "vitest";
import { auditEntityTypes, auditFilterParams, auditLogsToCsv, exportAuditLogs, listAuditLogs, parseAuditFilters } from "@/server/services/admin-oversight";
import { db, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function seed() {
  const admin = await makeUser({ admin: true });
  const alice = await makeUser({ email: "alice.ops@exemplo.test" });
  const bob = await makeUser({ email: "bob@exemplo.test" });
  const at = (iso: string) => new Date(iso);
  const rows = [
    // 01/11 23:30 em São Paulo = 02/11 02:30 UTC: conta como dia 01 no filtro.
    { actorUserId: alice.id, action: "refund.requested", entityType: "Order", entityId: "ord_aaaaaaaa11111111", createdAt: at("2026-11-02T02:30:00Z") },
    { actorUserId: bob.id, action: "event.featured", entityType: "Event", entityId: "evt_bbbbbbbb22222222", createdAt: at("2026-11-05T15:00:00Z") },
    { actorUserId: null, action: "refund.succeeded", entityType: "Order", entityId: "ord_cccccccc33333333", createdAt: at("2026-11-10T15:00:00Z"), metadata: { note: "=HYPERLINK(\"x\")" } },
  ];
  await db.auditLog.createMany({ data: rows });
  return { admin, alice, bob };
}

const actions = (r: { items: { action: string }[] }) => r.items.map((l) => l.action).sort();

describe("auditoria: filtros", () => {
  it("período em dias de São Paulo (fim inclusivo), ator, sistema, entidade e final do ID", async () => {
    const { admin } = await seed();
    const list = (sp: Record<string, string>) => listAuditLogs(db, admin, parseAuditFilters(sp));

    expect(actions(await list({ de: "2026-11-01", ate: "2026-11-01" }))).toEqual(["refund.requested"]);
    expect(actions(await list({ de: "2026-11-02", ate: "2026-11-10" }))).toEqual(["event.featured", "refund.succeeded"]);
    // Datas invertidas são trocadas; data inválida é ignorada.
    expect(actions(await list({ de: "2026-11-10", ate: "2026-11-05" }))).toEqual(["event.featured", "refund.succeeded"]);
    expect((await list({ de: "ontem" })).total).toBe(3);

    expect(actions(await list({ ator: "ALICE.OPS" }))).toEqual(["refund.requested"]);
    expect(actions(await list({ ator: "sistema" }))).toEqual(["refund.succeeded"]);
    expect(actions(await list({ entidade: "Order" }))).toEqual(["refund.requested", "refund.succeeded"]);
    expect(actions(await list({ id: "22222222" }))).toEqual(["event.featured"]);
    expect(actions(await list({ grupo: "refund", ator: "sistema" }))).toEqual(["refund.succeeded"]);
    expect(actions(await list({ acao: "event." }))).toEqual(["event.featured"]);
    expect(await auditEntityTypes(db, admin)).toEqual(["Event", "Order"]);
  });

  it("os parâmetros de URL voltam aos mesmos filtros (paginação e CSV)", () => {
    const sp = { grupo: "refund", acao: "refund.", ator: "sistema", entidade: "Order", id: "3333", de: "2026-11-01", ate: "2026-11-30" };
    expect(auditFilterParams(parseAuditFilters(sp))).toEqual(sp);
    expect(auditFilterParams(parseAuditFilters({ grupo: "inexistente", de: "x" }))).toEqual({
      grupo: undefined, acao: undefined, ator: undefined, entidade: undefined, id: undefined, de: undefined, ate: undefined,
    });
  });
});

describe("auditoria: exportação CSV", () => {
  it("exporta com os filtros, escapa os detalhes e registra a exportação", async () => {
    const { admin } = await seed();
    const filters = parseAuditFilters({ entidade: "Order", de: "2026-11-01" });
    const { items, truncated } = await exportAuditLogs(db, admin, filters);
    expect(truncated).toBe(false);
    const csv = auditLogsToCsv(items, truncated);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe('"Quando (São Paulo)","Ação","Ator","ID do ator","Organização","Entidade","ID da entidade","Detalhes"');
    expect(lines).toHaveLength(3);
    // Mais recente primeiro; ID completo; ator sistema; JSON escapado.
    expect(lines[1]).toContain('"refund.succeeded","sistema",""');
    expect(lines[1]).toContain('"ord_cccccccc33333333"');
    expect(lines[1]).toContain('"{""note"":""=HYPERLINK(\\""x\\"")""}"');
    expect(lines[2]).toContain('"alice.ops@exemplo.test"');

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "audit.exported" } });
    expect(log).toMatchObject({ actorUserId: admin.id, entityType: "AuditLog", metadata: { filters: { entidade: "Order", de: "2026-11-01" }, rows: 2, truncated: false } });
  });

  it("sem a permissão audit:read não lista nem exporta, e nada é registrado", async () => {
    await seed();
    const finance = await makeUser({ admin: true });
    await db.user.update({ where: { id: finance.id }, data: { adminRoles: ["FINANCE"] } });
    const actor = { ...finance, adminRoles: ["FINANCE" as const] };
    await expect(exportAuditLogs(db, actor, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listAuditLogs(db, actor, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const customer = await makeUser();
    await expect(exportAuditLogs(db, customer, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.auditLog.count({ where: { action: "audit.exported" } })).toBe(0);
  });

  it("acima do limite o CSV sai cortado e avisa", async () => {
    const { admin } = await seed();
    const { AUDIT_EXPORT_LIMIT } = await import("@/server/services/admin-oversight");
    await db.auditLog.createMany({
      data: Array.from({ length: AUDIT_EXPORT_LIMIT + 1 }, (_, i) => ({ action: "bulk.test", entityType: "Bulk", entityId: `b${i}` })),
    });
    const { items, truncated } = await exportAuditLogs(db, admin, parseAuditFilters({ acao: "bulk." }));
    expect(items).toHaveLength(AUDIT_EXPORT_LIMIT);
    expect(truncated).toBe(true);
    expect(auditLogsToCsv(items, truncated).trimEnd().split("\r\n").at(-1)).toContain("Exportação limitada a 10000 registros");
  });
});
