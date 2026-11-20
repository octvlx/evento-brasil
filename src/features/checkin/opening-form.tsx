"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/primitives";
import { setCheckinOpeningAction } from "./actions";

/** Opções de abertura da portaria (minutos antes do início). */
const OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 0, label: "Na hora do início" },
  { minutes: 30, label: "30 minutos antes" },
  { minutes: 60, label: "1 hora antes" },
  { minutes: 120, label: "2 horas antes" },
  { minutes: 180, label: "3 horas antes" },
  { minutes: 360, label: "6 horas antes (padrão)" },
  { minutes: 720, label: "12 horas antes" },
  { minutes: 1440, label: "1 dia antes" },
  { minutes: 2880, label: "2 dias antes" },
  { minutes: 10080, label: "7 dias antes" },
];

/** Quem edita o evento escolhe quando a portaria começa a aceitar leituras. */
export function CheckinOpeningForm({ eventId, minutes }: { eventId: string; minutes: number }) {
  const [value, setValue] = useState(String(minutes));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  // Valor fora da lista (ex.: dados de demonstração): aparece como opção própria.
  const options = OPTIONS.some((o) => o.minutes === minutes) ? OPTIONS : [...OPTIONS, { minutes, label: `${Math.round(minutes / 60)} horas antes (atual)` }];
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => {
          const r = await setCheckinOpeningAction(eventId, Number(value));
          setMsg(r.ok ? { ok: true, text: "Abertura da portaria salva." } : { ok: false, text: r.error });
        });
      }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor="checkin-opening">Portaria abre</Label>
        <Select id="checkin-opening" value={value} onChange={(e) => setValue(e.target.value)} disabled={pending}>
          {options.map((o) => (
            <option key={o.minutes} value={o.minutes}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={pending || Number(value) === minutes}>
        Salvar
      </Button>
      {msg && (
        <p role="status" className={msg.ok ? "w-full text-xs text-success" : "w-full text-xs text-destructive"}>
          {msg.text}
        </p>
      )}
    </form>
  );
}
