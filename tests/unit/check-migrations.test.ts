import path from "node:path";
import { describe, expect, it } from "vitest";
import { localMigrations, migrationGaps } from "../../scripts/check-migrations.mjs";

const at = new Date("2026-11-24T10:00:00Z");

describe("migrationGaps (bloqueio do deploy de produção)", () => {
  it("em dia: nenhuma pendente nem com falha", () => {
    expect(migrationGaps(["a", "b"], [
      { migration_name: "a", finished_at: at, rolled_back_at: null },
      { migration_name: "b", finished_at: at, rolled_back_at: null },
    ])).toEqual({ pending: [], failed: [] });
  });

  it("acusa a migração do código que o banco não tem (caso de 24/11)", () => {
    expect(migrationGaps(["a", "20261124120000_organizer_review_area"], [
      { migration_name: "a", finished_at: at, rolled_back_at: null },
    ]).pending).toEqual(["20261124120000_organizer_review_area"]);
  });

  it("migração que falhou no meio conta como pendente e com falha", () => {
    expect(migrationGaps(["a"], [{ migration_name: "a", finished_at: null, rolled_back_at: null }]))
      .toEqual({ pending: ["a"], failed: ["a"] });
  });

  it("migração revertida (rolled back) volta a ser pendente, sem falha", () => {
    expect(migrationGaps(["a"], [{ migration_name: "a", finished_at: at, rolled_back_at: at }]))
      .toEqual({ pending: ["a"], failed: [] });
  });

  it("lê as pastas reais do projeto, em ordem e sem o migration_lock.toml", () => {
    const names: string[] = localMigrations(path.join(import.meta.dirname, "../../prisma/migrations"));
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...names].sort());
    expect(names.every((n) => /^\d{14}_/.test(n))).toBe(true);
  });
});
