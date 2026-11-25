"use server";

// "Usar minha localização" (seção "Perto de você" da home): recebe a posição do
// navegador, acha a cidade com eventos mais próxima e grava a mesma preferência que a
// busca grava (cookie eb_city). A posição não é guardada nem registrada em log.
import { cookies } from "next/headers";
import { z } from "zod";
import { db } from "@/server/db";
import { nearestCity } from "@/server/nearest-city";
import { listCities } from "@/server/services/catalog";
import { CITY_COOKIE, CITY_SOURCE_COOKIE } from "@/lib/city-preference";

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export type NearbyCityResult = { ok: true; name: string; state: string; km: number } | { ok: false; reason: "invalid" | "far" };

export async function nearestCityAction(input: unknown): Promise<NearbyCityResult> {
  const parsed = pointSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const found = nearestCity(await listCities(db), parsed.data);
  if (!found) return { ok: false, reason: "far" };
  const jar = await cookies();
  const opts = { path: "/", maxAge: 31_536_000, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" };
  jar.set(CITY_COOKIE, found.city.slug, opts);
  jar.set(CITY_SOURCE_COOKIE, "localizacao", opts);
  return { ok: true, name: found.city.name, state: found.city.state, km: Math.round(found.km) };
}
