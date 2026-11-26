"use client";

import { useEffect, useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { disableSeatingAction, getSeatGridAction, saveSeatGridAction } from "@/features/organizer/actions";

type Row = { row: string; seats: number };
type Status = "FREE" | "TAKEN" | "BLOCKED";

const nextRowName = (rows: Row[]) => {
  const used = new Set(rows.map((r) => r.row));
  for (let i = 0; i < 26 * 27; i++) {
    const name = i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
    if (!used.has(name)) return name;
  }
  return "";
};

/**
 * Editor da grade de assentos de um tipo de ingresso: fileiras e quantidade de assentos,
 * e clique no assento para bloquear/desbloquear. Assentos já reservados ou vendidos
 * aparecem ocupados e não podem ser bloqueados nem removidos (o servidor também confere).
 */
export function SeatGridEditor({ ticketTypeId, onClose }: { ticketTypeId: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [seated, setSeated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    getSeatGridAction(ticketTypeId).then((res) => {
      if (!alive) return;
      if (!res.ok) return setError(res.error);
      const g = res.data;
      setSeated(g.seated);
      setRows(g.rows.length ? g.rows.map((r) => ({ row: r.row, seats: Math.max(...r.seats.map((s) => s.number)) })) : [{ row: "A", seats: 10 }]);
      const all = g.rows.flatMap((r) => r.seats);
      setBlocked(new Set(all.filter((s) => s.status === "BLOCKED").map((s) => s.label)));
      setTaken(new Set(all.filter((s) => s.status === "TAKEN").map((s) => s.label)));
    });
    return () => {
      alive = false;
    };
  }, [ticketTypeId]);

  if (!rows) return <p className="text-sm text-muted-foreground">{error ?? "Carregando assentos…"}</p>;

  const total = rows.reduce((s, r) => s + (r.seats || 0), 0);
  const labels = new Set(rows.flatMap((r) => Array.from({ length: r.seats || 0 }, (_, i) => `${r.row}${i + 1}`)));
  const blockedNow = [...blocked].filter((l) => labels.has(l));
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggle = (label: string) => {
    if (taken.has(label)) return;
    const next = new Set(blocked);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    setBlocked(next);
    setSaved(false);
  };
  const save = () =>
    start(async () => {
      const res = await saveSeatGridAction(ticketTypeId, { rows: rows.map((r) => ({ row: r.row, seats: Number(r.seats) })), blocked: blockedNow });
      if (!res.ok) return setError(res.error);
      setError(null);
      setSeated(true);
      setSaved(true);
    });
  const disable = () =>
    start(async () => {
      const res = await disableSeatingAction(ticketTypeId);
      if (!res.ok) return setError(res.error);
      onClose();
    });

  return (
    <div className="mt-3 space-y-4 rounded-2xl border border-secondary/40 bg-secondary/5 p-4" data-testid="seat-grid-editor">
      <div>
        <p className="font-semibold">Lugar marcado</p>
        <p className="text-xs text-muted-foreground">
          Monte as fileiras e toque num assento para bloqueá-lo (corredor, câmera, cortesia). A quantidade à venda passa a ser o número de assentos livres.
        </p>
      </div>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor={`row-${i}`}>Fileira</Label>
              <Input id={`row-${i}`} className="mt-1 w-20 uppercase" maxLength={3} value={r.row} onChange={(e) => setRow(i, { row: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} />
            </div>
            <div>
              <Label htmlFor={`seats-${i}`}>Assentos</Label>
              <Input id={`seats-${i}`} type="number" min={1} max={200} className="mt-1 w-24" value={r.seats} onChange={(e) => setRow(i, { seats: Number(e.target.value) })} />
            </div>
            {rows.length > 1 && (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remover fileira ${r.row}`}>
                <Trash2 aria-hidden />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" onClick={() => setRows([...rows, { row: nextRowName(rows), seats: rows.at(-1)?.seats ?? 10 }])}>
        <Plus aria-hidden /> Adicionar fileira
      </Button>

      <div className="overflow-x-auto rounded-xl border border-border bg-background p-3">
        <p className="mb-2 text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground">Palco</p>
        <div className="space-y-1">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="w-8 shrink-0 text-right text-xs font-semibold text-muted-foreground">{r.row}</span>
              {Array.from({ length: Math.min(r.seats || 0, 200) }, (_, n) => {
                const label = `${r.row}${n + 1}`;
                const status: Status = taken.has(label) ? "TAKEN" : blocked.has(label) ? "BLOCKED" : "FREE";
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggle(label)}
                    disabled={status === "TAKEN"}
                    aria-label={`${label}: ${status === "TAKEN" ? "ocupado" : status === "BLOCKED" ? "bloqueado" : "à venda"}`}
                    aria-pressed={status === "BLOCKED"}
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded text-[9px] font-semibold",
                      status === "FREE" && "bg-lime/70 text-night hover:bg-lime",
                      status === "BLOCKED" && "bg-muted text-muted-foreground line-through",
                      status === "TAKEN" && "cursor-not-allowed bg-night text-white",
                    )}
                  >
                    {n + 1}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {total} assentos · {blockedNow.length} bloqueados · {total - blockedNow.length} à venda{taken.size ? ` · ${taken.size} já reservados ou vendidos` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={pending || total < 1}>
          {pending ? "Salvando…" : "Salvar assentos"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
        {seated && taken.size === 0 && (
          <Button variant="ghost" className="text-destructive" onClick={disable} disabled={pending}>
            Desligar lugar marcado
          </Button>
        )}
      </div>
      {saved && <Alert variant="success">Assentos salvos.</Alert>}
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
