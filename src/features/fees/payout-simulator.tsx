"use client";

// Simulador de repasse em /publique-seu-evento: a pessoa digita o preço e a quantidade e vê
// quanto o comprador paga e quanto a organização recebe, com a MESMA função do checkout
// (computeFees) e a regra de comissão de plataforma vigente, vinda do servidor.
import { useId, useState } from "react";
import { computeFees, lineWithNegativePayout, type FeeRule } from "./policy";
import { formatBRL, parseBRLToCents } from "@/lib/money";

const MAX_PRICE_CENTS = 100_000_00; // R$ 100.000,00
const MAX_QTY = 100_000;

export type SimulatorRule = Pick<FeeRule, "percentBps" | "fixedCentsPerTicket" | "bearer">;

/** Cálculo do simulador (puro, testável). null para entrada inválida. */
export function simulatePayout(priceCents: number, quantity: number, rule: SimulatorRule, halfPrice = false) {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || priceCents > MAX_PRICE_CENTS) return null;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) return null;
  const fees = computeFees([{ ticketTypeId: "simulador", unitPriceCents: priceCents, quantity, halfPrice }], { ...rule, policyVersion: "simulador" });
  const line = fees.lines[0];
  return {
    buyerPaysPerTicket: line.unitPriceCents + line.serviceFeePerUnitCents,
    commissionPerTicket: line.commissionPerUnitCents,
    /** Partes da comissão: percentual sobre o preço e valor fixo (meia: proporcional). */
    percentPartPerTicket: line.commissionPerUnitCents - line.fixedFeePerUnitCents,
    fixedPartPerTicket: line.fixedFeePerUnitCents,
    organizerPerTicket: line.unitPriceCents - (rule.bearer === "ORGANIZER" ? line.commissionPerUnitCents : 0),
    buyersTotal: fees.totalCents,
    commissionTotal: fees.commissionCents,
    organizerTotal: fees.organizerShareCents,
    negativePayout: !!lineWithNegativePayout(fees, rule.bearer),
  };
}

/** Texto da composição da comissão por ingresso: "7% (R$ 3,50) + R$ 2,00 fixo". */
export function commissionParts(percentBps: number, percentPart: number, fixedPart: number) {
  const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(percentBps / 100);
  const pct = `${percent}% (${formatBRL(percentPart)})`;
  return fixedPart > 0 ? `${pct} + ${formatBRL(fixedPart)} fixo` : pct;
}

export function PayoutSimulator({
  rule,
  processingByOrganizer,
  fixedFeeRetainedNote,
}: {
  rule: SimulatorRule;
  processingByOrganizer: boolean;
  /** Regra com valor fixo não reembolsável: aviso de quando ele não volta ao comprador. */
  fixedFeeRetainedNote?: string;
}) {
  const id = useId();
  const [price, setPrice] = useState("50,00");
  const [qty, setQty] = useState("100");
  const [half, setHalf] = useState(false);
  const priceCents = parseBRLToCents(price);
  const quantity = Number(qty.replace(/\D/g, ""));
  const result = priceCents == null ? null : simulatePayout(priceCents, quantity, rule, half);
  const buyerPays = rule.bearer === "BUYER";

  return (
    <div className="mt-4 rounded-2xl border border-border bg-card p-6 shadow-card" data-testid="payout-simulator">
      <h3 className="font-display text-xl font-extrabold">Simule quanto você recebe</h3>
      <p className="mt-1 text-sm text-muted-foreground">Digite o preço do ingresso e quantos espera vender. A conta usa a comissão padrão atual, a mesma do checkout.</p>
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="space-y-4">
          <div>
            <label htmlFor={`${id}-preco`} className="mb-1 block text-sm font-semibold">
              Preço do ingresso (R$)
            </label>
            <input
              id={`${id}-preco`}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="h-11 w-full rounded-xl border border-input bg-background px-3 text-base tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-invalid={priceCents == null || priceCents > MAX_PRICE_CENTS}
            />
          </div>
          <div>
            <label htmlFor={`${id}-qtd`} className="mb-1 block text-sm font-semibold">
              Ingressos vendidos
            </label>
            <input
              id={`${id}-qtd`}
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="h-11 w-full rounded-xl border border-input bg-background px-3 text-base tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-invalid={!result}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} className="size-4" />
            É meia-entrada (comissão proporcional)
          </label>
        </div>

        <div aria-live="polite">
          {!result ? (
            <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">Digite um preço (até R$ 100.000,00) e uma quantidade entre 1 e 100.000.</p>
          ) : (
            <dl className="grid gap-3 sm:grid-cols-3">
              <Stat label="O comprador paga" value={formatBRL(result.buyerPaysPerTicket)} hint={buyerPays && result.commissionPerTicket ? `ingresso + ${formatBRL(result.commissionPerTicket)} de taxa` : "por ingresso"} />
              <Stat
                label={buyerPays ? "Taxa de serviço" : "Comissão"}
                value={formatBRL(result.commissionPerTicket)}
                hint={`${result.commissionPerTicket ? `${commissionParts(rule.percentBps, result.percentPartPerTicket, result.fixedPartPerTicket)} · ` : ""}${buyerPays ? "paga pelo comprador" : "descontada do repasse"}`}
              />
              <Stat label="Você recebe" value={formatBRL(result.organizerPerTicket)} hint="por ingresso" strong />
              <div className="rounded-xl bg-night p-4 text-white sm:col-span-3" data-testid="simulator-total">
                <dt className="text-sm text-white/75">
                  Total para você com {quantity.toLocaleString("pt-BR")} {quantity === 1 ? "ingresso" : "ingressos"}
                </dt>
                <dd className="mt-1 font-display text-3xl font-extrabold tabular-nums text-lime">{formatBRL(result.organizerTotal)}</dd>
                <dd className="mt-1 text-xs text-white/70">
                  Compradores pagam {formatBRL(result.buyersTotal)} no total · comissão {formatBRL(result.commissionTotal)}
                </dd>
              </div>
              {result.negativePayout && (
                <p role="alert" className="text-sm text-destructive sm:col-span-3">
                  Neste preço a comissão fica maior que o ingresso. Ingressos pagos precisam custar mais que a comissão; para entrada sem custo, use ingresso gratuito.
                </p>
              )}
            </dl>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Simulação com a regra padrão. {fixedFeeRetainedNote ? `${fixedFeeRetainedNote} ` : ""}{processingByOrganizer ? "“Você recebe” é antes da tarifa do Mercado Pago pelo processamento do pagamento." : "A tarifa do Mercado Pago é absorvida pela plataforma."} Condições combinadas para a sua organização aparecem na criação do evento.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, strong }: { label: string; value: string; hint: string; strong?: boolean }) {
  return (
    <div className={`rounded-xl p-4 ${strong ? "bg-lime/20 ring-1 ring-lime" : "bg-muted"}`}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-extrabold tabular-nums">{value}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
    </div>
  );
}
