"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSeatMapAction } from "./actions";

export type PickedSeat = { id: string; label: string };
type MapRow = { row: string; seats: { id: string; label: string; number: number; status: "FREE" | "TAKEN" | "BLOCKED" }[] };

/**
 * Escolha de assentos de um tipo de ingresso com lugar marcado. Mostra só livre/ocupado
 * (o servidor nunca diz quem comprou). A escolha é conferida de novo ao reservar: se
 * alguém pegar o mesmo assento antes, a revisão avisa e pede outro.
 */
export function SeatPicker({ ticketTypeId, max, selected, onChange }: { ticketTypeId: string; max: number; selected: PickedSeat[]; onChange: (seats: PickedSeat[]) => void }) {
  const [rows, setRows] = useState<MapRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    getSeatMapAction(ticketTypeId).then((res) => {
      if (!alive) return;
      if (!res.ok || !res.data) return setError(res.ok ? "Mapa de assentos indisponível." : res.error);
      setError(null);
      setRows(res.data.rows);
      // Assento escolhido que ficou ocupado sai da seleção.
      const free = new Set(res.data.rows.flatMap((r) => r.seats.filter((s) => s.status === "FREE").map((s) => s.id)));
      if (selected.some((s) => !free.has(s.id))) onChange(selected.filter((s) => free.has(s.id)));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recarrega só ao trocar o tipo ou ao pedir atualização
  }, [ticketTypeId, version]);

  if (error) return <p className="mt-3 text-sm text-destructive">{error}</p>;
  if (!rows) return <p className="mt-3 text-sm text-muted-foreground">Carregando assentos…</p>;
  const chosen = new Set(selected.map((s) => s.id));
  const toggle = (seat: { id: string; label: string }) => {
    if (chosen.has(seat.id)) return onChange(selected.filter((s) => s.id !== seat.id));
    if (selected.length >= max) return;
    onChange([...selected, { id: seat.id, label: seat.label }]);
  };

  return (
    <div className="mt-3 space-y-2" data-testid="seat-picker">
      <div className="overflow-x-auto rounded-xl border border-border bg-background p-3">
        <p className="mb-2 rounded bg-muted py-1 text-center text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Palco</p>
        <div className="mx-auto w-max space-y-0.5">
          {rows.map((r) => (
            <div key={r.row} className="flex items-center gap-0.5">
              <span className="w-5 shrink-0 text-right text-[10px] font-semibold text-muted-foreground">{r.row}</span>
              {r.seats.map((s) => {
                const isChosen = chosen.has(s.id);
                const free = s.status === "FREE";
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={!free || (!isChosen && selected.length >= max)}
                    onClick={() => toggle(s)}
                    aria-pressed={isChosen}
                    aria-label={`Assento ${s.label}${free ? "" : " (indisponível)"}`}
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded text-[9px] font-semibold transition sm:size-7 sm:text-[10px]",
                      isChosen && "bg-secondary text-white ring-2 ring-secondary ring-offset-1",
                      !isChosen && free && "bg-lime/70 text-night hover:bg-lime disabled:opacity-50",
                      !free && "cursor-not-allowed bg-muted text-muted-foreground/50",
                    )}
                  >
                    {s.number}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block size-3 rounded bg-lime/70" /> Livre</span>
          <span className="flex items-center gap-1"><span className="inline-block size-3 rounded bg-secondary" /> Seu</span>
          <span className="flex items-center gap-1"><span className="inline-block size-3 rounded bg-muted" /> Ocupado</span>
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => setVersion((v) => v + 1)}>
          <RefreshCw aria-hidden /> Atualizar
        </Button>
      </div>
      <p className="text-sm" aria-live="polite">
        {selected.length ? `Assentos: ${selected.map((s) => s.label).join(", ")}` : `Escolha até ${max} ${max === 1 ? "assento" : "assentos"}.`}
      </p>
    </div>
  );
}
