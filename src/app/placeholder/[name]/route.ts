// Capas ilustrativas (SVG) para desenvolvimento. Rotuladas como placeholder.
// Paletas "noite na cidade" da QQPega: base escura + uma luz de cor (limão, pink,
// laranja, ciano…), para variar entre eventos sem fugir da identidade.
const PALETTES = [
  ["#16121f", "#2a1740", "#ff4f93"],
  ["#16121f", "#1d3a2a", "#c6f432"],
  ["#1a1030", "#5b1a6e", "#ff8a3d"],
  ["#0f1a24", "#164e63", "#5eead4"],
  ["#21101c", "#8c1450", "#ffd166"],
  ["#14122a", "#3730a3", "#ff4f93"],
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
<radialGradient id="l" cx="${cx}%" cy="${cy}%" r="60%"><stop offset="0" stop-color="${c}" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1600" height="1000" fill="url(#g)"/>
<rect width="1600" height="1000" fill="url(#l)"/>
<g fill="none" stroke="${c}" stroke-opacity=".22" stroke-width="3">
${Array.from({ length: 9 }, (_, i) => `<circle cx="${(cx / 100) * 1600}" cy="${(cy / 100) * 1000}" r="${r + i * 70}"/>`).join("")}
</g>
<g fill="#fff" fill-opacity=".9" font-family="system-ui,sans-serif" font-weight="700">
<text x="1540" y="940" font-size="34" letter-spacing="6" text-anchor="end">IMAGEM ILUSTRATIVA</text>
</g>
</svg>`;
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
  });
}
