// Encerramento pelo relógio: término em UTC (convertido do horário local e do fuso
// do evento), status efetivo antes do job e janela operacional da portaria.
import { describe, expect, it } from "vitest";
import { zonedLocalToUtc } from "@/lib/datetime";
import { CHECKIN_GRACE_MS, checkinWindowOpen, effectiveEventStatus, hasEventEnded } from "@/lib/event-lifecycle";

const HOUR = 3_600_000;
const at = (iso: string) => new Date(iso);

describe("hasEventEnded", () => {
  const endsAt = at("2026-11-03T23:00:00.000Z");

  it("evento ainda ativo (um minuto antes do término)", () => {
    expect(hasEventEnded({ endsAt }, at("2026-11-03T22:59:00.000Z"))).toBe(false);
  });

  it("evento que acaba de terminar: o instante do término já conta como encerrado", () => {
    expect(hasEventEnded({ endsAt }, endsAt)).toBe(true);
    expect(hasEventEnded({ endsAt }, new Date(endsAt.getTime() + 1))).toBe(true);
    expect(hasEventEnded({ endsAt }, new Date(endsAt.getTime() - 1))).toBe(false);
  });

  it("evento encerrado há várias horas", () => {
    expect(hasEventEnded({ endsAt }, new Date(endsAt.getTime() + 7 * HOUR))).toBe(true);
  });

  it("evento que atravessa a meia-noite: termina no dia seguinte, no horário local", () => {
    // 22:00 de 31/12 até 04:00 de 01/01 em São Paulo (UTC−3).
    const end = zonedLocalToUtc("2027-01-01T04:00", "America/Sao_Paulo");
    expect(end.toISOString()).toBe("2027-01-01T07:00:00.000Z");
    expect(hasEventEnded({ endsAt: end }, at("2027-01-01T03:00:00.000Z"))).toBe(false); // meia-noite local
    expect(hasEventEnded({ endsAt: end }, at("2027-01-01T06:59:00.000Z"))).toBe(false); // 03:59 local
    expect(hasEventEnded({ endsAt: end }, at("2027-01-01T07:00:00.000Z"))).toBe(true); // 04:00 local
  });

  it("fuso horário diferente: o mesmo horário local termina em instantes distintos", () => {
    const sp = zonedLocalToUtc("2026-11-20T22:00", "America/Sao_Paulo"); // UTC−3
    const manaus = zonedLocalToUtc("2026-11-20T22:00", "America/Manaus"); // UTC−4
    const noronha = zonedLocalToUtc("2026-11-20T22:00", "America/Noronha"); // UTC−2
    expect([noronha, sp, manaus].map((d) => d.toISOString())).toEqual(["2026-11-21T00:00:00.000Z", "2026-11-21T01:00:00.000Z", "2026-11-21T02:00:00.000Z"]);
    // 01:30 UTC = 22:30 em São Paulo e 21:30 em Manaus.
    const now = at("2026-11-21T01:30:00.000Z");
    expect(hasEventEnded({ endsAt: sp }, now)).toBe(true);
    expect(hasEventEnded({ endsAt: manaus }, now)).toBe(false);
    expect(hasEventEnded({ endsAt: noronha }, now)).toBe(true);
  });
});

describe("effectiveEventStatus", () => {
  const endsAt = at("2026-11-03T23:00:00.000Z");
  const after = at("2026-11-04T01:00:00.000Z");
  const before = at("2026-11-03T20:00:00.000Z");

  it("PUBLISHED vencido no banco já é COMPLETED, sem esperar o job", () => {
    expect(effectiveEventStatus({ status: "PUBLISHED", endsAt }, after)).toBe("COMPLETED");
    expect(effectiveEventStatus({ status: "PUBLISHED", endsAt }, before)).toBe("PUBLISHED");
  });

  it("cancelado, rascunho, em análise e arquivado não mudam", () => {
    for (const status of ["CANCELLED", "DRAFT", "PENDING_REVIEW", "ARCHIVED", "COMPLETED"] as const) {
      expect(effectiveEventStatus({ status, endsAt }, after)).toBe(status);
    }
  });
});

describe("checkinWindowOpen — fechamento operacional separado do comercial", () => {
  const endsAt = at("2026-11-03T23:00:00.000Z");

  it("aceita entrada até 12 h depois do término, com o status ainda PUBLISHED (job atrasado) ou já COMPLETED", () => {
    for (const status of ["PUBLISHED", "COMPLETED"] as const) {
      expect(checkinWindowOpen({ status, endsAt }, new Date(endsAt.getTime() + HOUR))).toBe(true);
      expect(checkinWindowOpen({ status, endsAt }, new Date(endsAt.getTime() + CHECKIN_GRACE_MS - 1))).toBe(true);
      expect(checkinWindowOpen({ status, endsAt }, new Date(endsAt.getTime() + CHECKIN_GRACE_MS))).toBe(false);
    }
  });

  it("cancelado ou rascunho nunca abre", () => {
    expect(checkinWindowOpen({ status: "CANCELLED", endsAt }, new Date(endsAt.getTime() - HOUR))).toBe(false);
    expect(checkinWindowOpen({ status: "DRAFT", endsAt }, new Date(endsAt.getTime() - HOUR))).toBe(false);
  });
});
