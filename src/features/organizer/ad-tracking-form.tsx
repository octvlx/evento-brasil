"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { AdTrackingIds } from "@/lib/ad-tracking";
import { setEventAdTrackingAction } from "./actions";

const FIELDS: { field: keyof AdTrackingIds; label: string; placeholder: string; help: string }[] = [
  { field: "metaPixelId", label: "Meta Pixel (Facebook e Instagram)", placeholder: "123456789012345", help: "Gerenciador de Eventos do Meta → Fontes de dados → ID do pixel." },
  { field: "ga4MeasurementId", label: "Google Analytics 4", placeholder: "G-ABC123XYZ", help: "Administrador → Fluxos de dados → ID da métrica." },
  { field: "googleAdsTag", label: "Google Ads (conversão)", placeholder: "AW-123456789/AbCdEfGhIj", help: "Metas → Conversões → tag do evento: ID (AW-…) e, para contar vendas, o rótulo depois da barra." },
];

/** IDs de medição do organizador. Carregados só para compradores que aceitarem os cookies de medição. */
export function AdTrackingForm({ eventId, initial, locked }: { eventId: string; initial: AdTrackingIds; locked: boolean }) {
  const [values, setValues] = useState({
    metaPixelId: initial.metaPixelId ?? "",
    ga4MeasurementId: initial.ga4MeasurementId ?? "",
    googleAdsTag: initial.googleAdsTag ?? "",
  });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    start(async () => {
      const res = await setEventAdTrackingAction(eventId, values);
      setMessage(res.ok ? { ok: true, text: "IDs salvos." } : { ok: false, text: res.error });
    });
  };
  return (
    <form onSubmit={save} className="space-y-4" data-testid="ad-tracking-form">
      <p className="text-sm text-muted-foreground">
        Meça as vendas que vêm dos seus anúncios. Registramos visita ao evento, início da compra e compra concluída (com o valor do pedido), sem enviar
        nome, e-mail ou CPF. Os códigos só carregam para quem aceitar os cookies de medição no aviso do site.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.field}>
            <label htmlFor={`ad-${f.field}`} className="mb-1 block text-sm font-semibold">
              {f.label}
            </label>
            <input
              id={`ad-${f.field}`}
              value={values[f.field]}
              onChange={(e) => setValues((v) => ({ ...v, [f.field]: e.target.value }))}
              placeholder={f.placeholder}
              disabled={locked || pending}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
              className="h-10 w-full rounded-xl border border-input bg-background px-3 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">{f.help}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={locked || pending}>
          Salvar IDs
        </Button>
        {message && (
          <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
