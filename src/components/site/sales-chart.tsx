import { formatBRL } from "@/lib/money";

/** Gráfico de barras diário em SVG puro (sem dependências), com tabela acessível. */
export function SalesChart({ data }: { data: { day: string; totalCents: number; orders: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.totalCents));
  const total = data.reduce((s, d) => s + d.totalCents, 0);
  const w = 600;
  const h = 160;
  const bw = w / Math.max(1, data.length);
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h + 20}`} className="h-48 w-full" role="img" aria-label={`Vendas diárias, total ${formatBRL(total)}`}>
        <line x1="0" y1={h} x2={w} y2={h} className="stroke-border" strokeWidth="1" />
        {data.map((d, i) => {
          const bh = (d.totalCents / max) * (h - 8);
          return (
            <g key={d.day}>
              <rect x={i * bw + bw * 0.15} y={h - bh} width={bw * 0.7} height={Math.max(bh, d.totalCents ? 2 : 0)} rx="3" className="fill-secondary">
                <title>{`${d.day.split("-").reverse().join("/")}: ${formatBRL(d.totalCents)} (${d.orders} pedidos)`}</title>
              </rect>
              {i % 5 === 0 && (
                <text x={i * bw + bw / 2} y={h + 14} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {d.day.slice(8, 10)}/{d.day.slice(5, 7)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 text-sm text-muted-foreground">
        Total no período: <strong className="text-foreground">{formatBRL(total)}</strong> em {data.reduce((s, d) => s + d.orders, 0)} pedidos pagos.
      </figcaption>
    </figure>
  );
}
