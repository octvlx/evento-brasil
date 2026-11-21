"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Label, Textarea } from "@/components/ui/primitives";
import { reportEventAction } from "./actions";
import { EVENT_REPORT_REASONS, type EventReportReasonKey } from "./labels";

/** "Denunciar este evento": formulário curto; sem login, leva para entrar e voltar. */
export function ReportEventButton({ eventId, loggedIn, loginHref }: { eventId: string; loggedIn: boolean; loginHref: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<EventReportReasonKey | "">("");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();

  if (!loggedIn) {
    return (
      <Link href={loginHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline">
        <Flag className="size-3.5" aria-hidden /> Denunciar este evento
      </Link>
    );
  }
  if (sent) {
    return (
      <p role="status" className="text-sm text-muted-foreground" data-testid="report-sent">
        Recebemos sua denúncia. Obrigado por avisar: nossa equipe vai analisar.
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline">
        <Flag className="size-3.5" aria-hidden /> Denunciar este evento
      </button>
    );
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!reason) return setError("Escolha o motivo.");
    start(async () => {
      const res = await reportEventAction(eventId, { reason, details });
      if (res.ok) setSent(true);
      else setError(res.error);
    });
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-border p-4" aria-labelledby="report-title" data-testid="report-form">
      <p id="report-title" className="font-semibold">
        Denunciar este evento
      </p>
      <fieldset>
        <legend className="mb-2 text-sm text-muted-foreground">Qual é o problema?</legend>
        <div className="space-y-1.5">
          {(Object.keys(EVENT_REPORT_REASONS) as EventReportReasonKey[]).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="report-reason" value={k} checked={reason === k} onChange={() => setReason(k)} /> {EVENT_REPORT_REASONS[k]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Label htmlFor="report-details">Detalhes {reason === "OTHER" ? "" : "(opcional)"}</Label>
        <Textarea id="report-details" className="mt-1.5" maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="O que você viu? Links e datas ajudam a análise." />
      </div>
      {error && <Alert variant="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Enviando…" : "Enviar denúncia"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">A denúncia é analisada pela equipe da plataforma. O organizador não vê quem denunciou.</p>
    </form>
  );
}
