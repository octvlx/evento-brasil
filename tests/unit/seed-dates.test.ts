// Data dos eventos de demonstração "deste fim de semana" no seed: nunca num sábado já
// à noite, quando a venda dos eventos de sábado (16h e 18h, venda até 2 h depois) fechou.
import { describe, expect, it } from "vitest";
import { daysToSaturday } from "../../prisma/seed-dates";

const SP = "America/Sao_Paulo";
// Horários em UTC; Brasília = UTC−3.
const at = (iso: string) => new Date(iso);

describe("daysToSaturday (seed)", () => {
  it("dias úteis e domingo apontam para o próximo sábado", () => {
    expect(daysToSaturday(SP, at("2026-11-09T15:00:00Z"))).toBe(5); // segunda
    expect(daysToSaturday(SP, at("2026-11-13T23:00:00Z"))).toBe(1); // sexta 20h
    expect(daysToSaturday(SP, at("2026-11-08T15:00:00Z"))).toBe(6); // domingo
  });

  it("sábado de manhã usa hoje; a partir do meio-dia, o sábado seguinte", () => {
    expect(daysToSaturday(SP, at("2026-11-14T13:00:00Z"))).toBe(0); // sábado 10h
    expect(daysToSaturday(SP, at("2026-11-14T14:59:00Z"))).toBe(0); // sábado 11h59
    expect(daysToSaturday(SP, at("2026-11-14T15:00:00Z"))).toBe(7); // sábado 12h
    expect(daysToSaturday(SP, at("2026-11-14T23:30:00Z"))).toBe(7); // sábado 20h30 (caso que quebrava)
  });

  it("usa o dia de Brasília, não o de UTC", () => {
    // Sábado 22h em Brasília = domingo 01h em UTC: ainda é sábado no fuso.
    expect(daysToSaturday(SP, at("2026-11-15T01:00:00Z"))).toBe(7);
    // Sexta 22h em Brasília = sábado 01h em UTC: ainda é sexta no fuso.
    expect(daysToSaturday(SP, at("2026-11-14T01:00:00Z"))).toBe(1);
  });
});
