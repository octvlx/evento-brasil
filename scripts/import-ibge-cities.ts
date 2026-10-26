// Importa/atualiza os municípios brasileiros a partir da API oficial do IBGE
// (servicodados.ibge.gov.br). Idempotente: atualiza por código IBGE ou nome+UF.
// Uso: npm run cities:import
//
// Observações:
// - O fuso padrão vem da UF (src/lib/br.ts). Exceções conhecidas (oeste do AM,
//   oeste do PA, Fernando de Noronha) devem ser ajustadas manualmente.
// - Com ~5.570 cidades, os seletores de cidade da UI devem virar busca com
//   autocompletar antes de importar a base completa em produção.
import "dotenv/config";
import { createPrismaClient } from "@/server/db";
import { defaultTimezoneForUF, isUF } from "@/lib/br";
import { slugify } from "@/lib/utils";

interface IbgeMunicipio {
  id: number;
  nome: string;
  microrregiao?: { mesorregiao?: { UF?: { sigla?: string } } } | null;
  "regiao-imediata"?: { "regiao-intermediaria"?: { UF?: { sigla?: string } } } | null;
}

async function main() {
  const res = await fetch("https://servicodados.ibge.gov.br/api/v1/localidades/municipios");
  if (!res.ok) throw new Error(`IBGE respondeu ${res.status}`);
  const data = (await res.json()) as IbgeMunicipio[];
  const db = createPrismaClient();
  let created = 0;
  let updated = 0;
  for (const m of data) {
    const uf = m.microrregiao?.mesorregiao?.UF?.sigla ?? m["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla;
    if (!uf || !isUF(uf)) continue;
    const ibgeCode = String(m.id);
    const existing = (await db.city.findUnique({ where: { ibgeCode } })) ?? (await db.city.findUnique({ where: { name_state: { name: m.nome, state: uf } } }));
    if (existing) {
      await db.city.update({ where: { id: existing.id }, data: { ibgeCode, name: m.nome } });
      updated++;
    } else {
      await db.city.create({ data: { name: m.nome, state: uf, ibgeCode, slug: slugify(`${m.nome}-${uf}`), timezone: defaultTimezoneForUF(uf) } });
      created++;
    }
  }
  console.log(`Municípios: ${created} criados, ${updated} atualizados (total IBGE: ${data.length}).`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
