import "server-only";
import { defaultTimezoneForUF } from "@/lib/br";
import { findMunicipality, findMunicipalityByName, validateMunicipality, type Municipality } from "@/lib/municipalities";
import { normalizeMunicipalityName } from "@/lib/municipality-search";
import { slugify } from "@/lib/utils";
import type { Tx } from "../db";
import { AppError } from "../errors";

/**
 * Cidade do evento a partir do código IBGE + UF escolhidos no autocomplete.
 * Chamada DENTRO da transação do evento: se o evento falhar, a cidade criada
 * aqui some junto (nada de cidade órfã). Pesquisar no autocomplete nunca cria cidade.
 *
 * 1. Cidade com o mesmo `ibgeCode` → reaproveitada.
 * 2. Cidade antiga sem código com o mesmo nome + UF (seed, cadastros anteriores)
 *    → ganha o código e é reaproveitada.
 * 3. Senão, é criada. `ON CONFLICT DO NOTHING` (createMany/skipDuplicates) faz o
 *    pedido simultâneo esperar o outro e reler a cidade, sem duplicar nem falhar.
 * Homônimos (Bom Jesus – PI × Bom Jesus – RS) têm códigos e slugs distintos.
 */
export async function resolveCityFromIbge(tx: Tx, ibgeCode: unknown, uf: unknown) {
  const m = validateMunicipality(ibgeCode, uf);
  if (!m) throw new AppError("VALIDATION", "Município inválido: escolha a cidade na lista da UF.");
  const code = String(m.id);

  const existing = await tx.city.findUnique({ where: { ibgeCode: code } });
  if (existing) return existing;

  const legacy = await adoptLegacyCity(tx, m);
  if (legacy) return legacy;

  const base = { name: m.nome, state: m.uf, ibgeCode: code, timezone: defaultTimezoneForUF(m.uf) };
  await tx.city.createMany({ data: [{ ...base, slug: slugify(`${m.nome}-${m.uf}`) }], skipDuplicates: true });
  const created = (await tx.city.findUnique({ where: { ibgeCode: code } })) ?? (await adoptLegacyCity(tx, m));
  if (created) return created;
  // O slug já era de outra cidade (nome diferente com o mesmo slug): desempata pelo código.
  await tx.city.createMany({ data: [{ ...base, slug: slugify(`${m.nome}-${m.uf}-${code}`) }], skipDuplicates: true });
  return tx.city.findUniqueOrThrow({ where: { ibgeCode: code } });
}

async function adoptLegacyCity(tx: Tx, m: Municipality) {
  // Nome exato primeiro; senão, cidade antiga da MESMA UF com nome equivalente
  // (maiúsculas, acentos e espaços: "SAO  PAULO" = "São Paulo"). UFs nunca se misturam.
  const legacy =
    (await tx.city.findUnique({ where: { name_state: { name: m.nome, state: m.uf } } })) ??
    (await tx.city.findMany({ where: { state: m.uf, ibgeCode: null } })).find((c) => normalizeMunicipalityName(c.name) === normalizeMunicipalityName(m.nome)) ??
    null;
  if (!legacy) return null;
  if (legacy.ibgeCode === String(m.id)) return legacy;
  if (legacy.ibgeCode) throw new AppError("CONFLICT", `A cidade ${m.nome} – ${m.uf} já está cadastrada com outro código IBGE.`);
  // Só preenche se ainda estiver vazio (outro pedido pode ter preenchido agora).
  await tx.city.updateMany({ where: { id: legacy.id, ibgeCode: null }, data: { ibgeCode: String(m.id) } });
  return tx.city.findUniqueOrThrow({ where: { id: legacy.id } });
}

/** Cidade do novo local: município do IBGE (padrão) ou, por compatibilidade, uma cidade já cadastrada. */
export async function resolveVenueCity(tx: Tx, v: { cityIbgeCode?: string; cityUf?: string; cityId?: string }) {
  if (v.cityIbgeCode || v.cityUf) return resolveCityFromIbge(tx, v.cityIbgeCode, v.cityUf);
  const city = v.cityId ? await tx.city.findUnique({ where: { id: v.cityId } }) : null;
  if (!city) throw new AppError("VALIDATION", "Cidade inválida.");
  return city;
}

/** Valor inicial do autocomplete para uma cidade já gravada (antigas sem código: pelo nome + UF). */
export function cityFormValue(city: { name: string; state: string; ibgeCode: string | null } | null | undefined) {
  if (!city) return { cityUf: "", cityIbgeCode: "", cityName: "" };
  const m = city.ibgeCode ? findMunicipality(city.ibgeCode) : findMunicipalityByName(city.name, city.state);
  return m ? { cityUf: m.uf, cityIbgeCode: String(m.id), cityName: m.nome } : { cityUf: city.state, cityIbgeCode: "", cityName: "" };
}
