"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { duplicateEventAction } from "./actions";

/** Cria um rascunho igual numa nova data; todas as datas andam o mesmo intervalo. */
export function DuplicateEvent({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [startsAtLocal, setStartsAtLocal] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!open)
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Copy aria-hidden /> Duplicar evento
      </Button>
    );

  return (
    <div className="space-y-3 rounded-2xl border border-border p-4">
      <p className="text-sm text-muted-foreground">
        Cria um rascunho com os mesmos dados, local e tipos de ingresso. Vendas, abertura e encerramento acompanham a nova data. Cupons, links de divulgação e equipe não são copiados.
      </p>
      <div>
        <Label htmlFor="dup-starts">Início do novo evento (horário do evento)</Label>
        <Input id="dup-starts" type="datetime-local" className="mt-1.5 max-w-xs" value={startsAtLocal} onChange={(e) => setStartsAtLocal(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button
          variant="accent"
          disabled={pending || !startsAtLocal}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await duplicateEventAction(eventId, startsAtLocal);
              if (r.ok) router.push(`/organizador/eventos/${r.data.id}/editar`);
              else setError(r.error);
            })
          }
        >
          {pending ? "Duplicando…" : "Criar cópia"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Voltar
        </Button>
      </div>
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
