// Capas ilustrativas (SVG) para desenvolvimento. Rotuladas como placeholder.
const PALETTES = [
  ["#1e1b4b", "#7c3aed", "#f43f5e"],
  ["#0f172a", "#2563eb", "#22d3ee"],
  ["#3b0764", "#c026d3", "#fb923c"],
  ["#052e16", "#059669", "#facc15"],
  ["#431407", "#ea580c", "#f472b6"],
  ["#172554", "#4f46e5", "#e879f9"],
];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export async function GET(_req: Request, ctx: RouteContext<"/placeholder/[name]">) {
  const { name } = await ctx.params;
  const seed = name.replace(/\.svg$/, "").slice(0, 120);
  const h = hash(seed);
  const [a, b, c] = PALETTES[h % PALETTES.length];
  const cx = 20 + (h % 60);
  const cy = 15 + ((h >> 8) % 50);
  const r = 140 + ((h >> 16) % 120);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".6" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>
<radialGradient id="l" cx="${cx}%" cy="${cy}%" r="60%"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1600" height="1000" fill="url(#g)"/>
<rect width="1600" height="1000" fill="url(#l)"/>
<g fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="3">
${Array.from({ length: 9 }, (_, i) => `<circle cx="${(cx / 100) * 1600}" cy="${(cy / 100) * 1000}" r="${r + i * 70}"/>`).join("")}
</g>
<g fill="#fff" fill-opacity=".9" font-family="system-ui,sans-serif" font-weight="700">
<text x="60" y="940" font-size="34" letter-spacing="6">IMAGEM ILUSTRATIVA</text>
</g>
</svg>`;
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
  });
}
