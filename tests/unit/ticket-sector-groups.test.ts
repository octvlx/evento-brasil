import { describe, expect, it } from "vitest";
import { groupBySector } from "@/features/orders/ticket-selector";

const t = (id: string, sector?: string | null) => ({ id, sector });

describe("groupBySector", () => {
  it("sem setor: uma seção sem título, na ordem original", () => {
    expect(groupBySector([t("a"), t("b", null)])).toEqual([{ sector: null, tickets: [t("a"), t("b", null)] }]);
  });
  it("agrupa na ordem do primeiro ingresso de cada setor; sem setor vai para o fim", () => {
    const list = [t("1", "Pista"), t("2"), t("3", "Camarote"), t("4", "Pista")];
    expect(groupBySector(list)).toEqual([
      { sector: "Pista", tickets: [t("1", "Pista"), t("4", "Pista")] },
      { sector: "Camarote", tickets: [t("3", "Camarote")] },
      { sector: "Outros ingressos", tickets: [t("2")] },
    ]);
  });
});
