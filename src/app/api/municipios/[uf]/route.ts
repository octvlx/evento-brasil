import { UF_CODES } from "@/lib/br";
import { municipalityOptions } from "@/lib/municipalities";

// Municípios de UMA UF para o autocomplete do cadastro de evento, da base local do
// IBGE (nunca da tabela City, nunca do IBGE em runtime). Gerado no build por UF.
export function generateStaticParams() {
  return UF_CODES.map((uf) => ({ uf }));
}

export async function GET(_req: Request, ctx: RouteContext<"/api/municipios/[uf]">) {
  const { uf } = await ctx.params;
  if (!(UF_CODES as readonly string[]).includes(uf)) return Response.json({ error: "UF inválida." }, { status: 404 });
  return Response.json(municipalityOptions(uf), {
    // A base só muda com um novo deploy.
    headers: { "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
  });
}
