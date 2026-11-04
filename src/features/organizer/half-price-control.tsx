import { Alert, Badge } from "@/components/ui/primitives";
import { formatDateTimeShort } from "@/lib/datetime";
import type { halfPriceControl } from "@/server/services/reports";

type Control = Awaited<ReturnType<typeof halfPriceControl>>;

const STATUS: Record<Control["status"], { label: string; tone: "success" | "warning" | "danger" | "default"; text: (c: Control) => string }> = {
  RESERVED: {
    label: "Reserva ativa",
    tone: "warning",
    text: (c) => `A cota legal de meia-entrada está reservada: o saldo de ${c.balance} ${c.balance === 1 ? "ingresso" : "ingressos"} não pode ser vendido como inteira até ${c.releaseAtLabel}.`,
  },
  RELEASED: {
    label: "Reserva liberada",
    tone: "success",
    text: (c) => `O prazo da reserva terminou em ${c.releaseAtLabel}. Os ingressos que sobraram da cota agora podem ser vendidos como inteira.`,
  },
  EXHAUSTED: {
    label: "Cota atingida",
    tone: "default",
    text: () => "As meias vendidas e reservadas já alcançaram a cota legal. Não há mais ingressos reservados para meia-entrada.",
  },
  NOT_APPLICABLE: { label: "Não se aplica", tone: "default", text: () => "A reserva automática não está em vigor para este evento." },
};

const NOT_APPLICABLE_REASON = {
  NOT_SUBJECT: "O evento está em regime não sujeito à cota de meia-entrada, definido pela plataforma.",
  NO_HALF_PRICE_TYPE: "O evento não tem um tipo de ingresso de meia-entrada à venda ao público. Cadastre um tipo \"Meia-entrada\" para ativar a reserva.",
  NO_ELIGIBLE_STOCK: "Não há estoque elegível à venda ao público para calcular a cota.",
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Controle de meia-entrada (L7c) do painel do evento. Somente leitura: todo número
 * vem do estado calculado no servidor (`halfPriceControl`); não há como desligar a reserva.
 */
export function HalfPriceControl({ control: c }: { control: Control }) {
  const st = STATUS[c.status];
  const rows: [string, string, string?][] = [
    ["Estoque elegível", String(c.eligibleStock), "Ingressos à venda ao público (meia, inteira, lotes), descontados os ocultos já comprometidos."],
    ["Cota legal (40%)", String(c.quota), "Mínimo reservado para meia-entrada."],
    [
      "Limite de meia-entrada",
      c.halfLimit === null ? "Sem limite além da cota" : String(c.halfLimit),
      c.configuredLimitPercent === null ? undefined : `Configurado: ${c.configuredLimitPercent.toLocaleString("pt-BR")}%.`,
    ],
    ["Meias vendidas", String(c.halfSold), "Inclui as depois reembolsadas: reembolso não devolve cota."],
    ["Reservas temporárias", String(c.halfReserved), "Meias de pedidos aguardando pagamento."],
    ["Saldo da cota", String(c.balance), "Cota legal menos meias vendidas e reservadas."],
    ["Indisponíveis para inteira", String(c.unavailableForFull), "Retidos pela reserva enquanto ela estiver ativa."],
    ["Prazo da reserva", `${c.deadlineHours} h antes do início`, c.deadlineHours === 72 ? "Local com mais de 10.000 lugares." : "Até 10.000 lugares."],
    ["Liberação da reserva", c.releaseAtLabel, `Horário do evento (${c.timezone}).`],
    ["Capacidade física do local", c.physicalCapacity === null ? "Não informada" : String(c.physicalCapacity), "Define o prazo de 48 h ou 72 h."],
    ["Capacidade do evento", String(c.eventCapacity)],
    ["Estoque à venda", String(c.onSaleStock), "Soma dos tipos de ingresso não ocultos."],
  ];
  return (
    <section aria-labelledby="half-price-control-title">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id="half-price-control-title" className="font-display text-lg font-bold">Controle de meia-entrada</h2>
        <Badge variant={st.tone}>{st.label}</Badge>
      </div>
      <p className="mb-2 text-sm">{st.text(c)}</p>
      {c.notApplicableReason && <p className="mb-2 text-sm text-muted-foreground">{NOT_APPLICABLE_REASON[c.notApplicableReason]}</p>}
      <p className="mb-4 text-xs text-muted-foreground">
        A reserva de 40% dos ingressos para meia-entrada é automática e não pode ser desligada. Valores calculados pela plataforma em {formatDateTimeShort(c.generatedAt, c.timezone)}.
      </p>
      {c.warnings.includes("HALF_STOCK_BELOW_QUOTA") && (
        <Alert variant="warning" className="mb-3">
          O estoque dos tipos de meia-entrada ({plural(c.halfStock, "ingresso", "ingressos")}) é menor que a cota legal ({plural(c.quota, "ingresso", "ingressos")}). Aumente a quantidade da meia para atender a cota.
        </Alert>
      )}
      {c.warnings.includes("CONFIGURED_BPS_BELOW_LEGAL") && (
        <Alert variant="warning" className="mb-3">
          O limite configurado ({c.configuredLimitPercent?.toLocaleString("pt-BR")}%) está abaixo do mínimo legal e é tratado como 40%. Edite o evento para corrigir o valor.
        </Alert>
      )}
      {c.regime === "NOT_SUBJECT" && (
        <Alert variant="info" className="mb-3">
          Evento não sujeito à cota de meia-entrada{c.regimeNote ? `: ${c.regimeNote}` : "."}
        </Alert>
      )}
      <dl className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="bg-card p-3">
            <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
            {hint && <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
