"use client";

import { useState, useTransition } from "react";
import { Archive, Copy, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Input, Label, Select } from "@/components/ui/primitives";
import { createTrackingLinkAction, setTrackingLinkArchivedAction } from "./actions";

export interface ManagedTrackingLink {
  id: string;
  name: string;
  url: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  couponCode: string | null;
  clicks: number;
  paidOrders: number;
  archived: boolean;
}

const empty = { name: "", utmSource: "", utmMedium: "", utmCampaign: "", utmContent: "", utmTerm: "", couponId: "" };

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => (setCopied(true), setTimeout(() => setCopied(false), 1500)),
          () => undefined,
        )
      }
    >
      <Copy aria-hidden /> {copied ? "Copiado" : "Copiar"}
    </Button>
  );
}

export function TrackingLinksManager({
  eventId,
  items,
  coupons,
  locked,
}: {
  eventId: string;
  items: ManagedTrackingLink[];
  coupons: { id: string; code: string }[];
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const res = await createTrackingLinkAction(eventId, f);
      if (!res.ok) return setError(res.error);
      setError(null);
      setCreated(res.data.url);
      setF(empty);
      setOpen(false);
    });

  const field = (key: keyof typeof empty, label: string, placeholder: string) => (
    <div>
      <Label htmlFor={`tl-${key}`}>{label}</Label>
      <Input id={`tl-${key}`} className="mt-1.5" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} placeholder={placeholder} />
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Crie um link para cada canal ou parceiro. Cada venda feita depois de um clique (até 7 dias, vale o último clique) aparece em Vendas por origem. Os UTMs de um link não mudam depois de criado.
      </p>
      {items.length === 0 && <p className="text-sm text-muted-foreground">Nenhum link criado.</p>}
      <ul className="space-y-2">
        {items.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4" data-testid="tracking-link">
            <div className="min-w-0">
              <p className="font-semibold">
                {l.name} {l.archived && <Badge variant="warning">Arquivado</Badge>}
              </p>
              <p className="break-all font-mono text-xs">{l.url}</p>
              <p className="text-xs text-muted-foreground">
                {l.clicks} clique(s) · {l.paidOrders} pedido(s) pago(s)
                {[l.utmSource, l.utmMedium, l.utmCampaign].some(Boolean) ? ` · ${[l.utmSource, l.utmMedium, l.utmCampaign].filter(Boolean).join(" / ")}` : ""}
                {l.couponCode ? ` · aplica o cupom ${l.couponCode}` : ""}
              </p>
            </div>
            <div className="flex gap-1">
              {!l.archived && <CopyButton text={l.url} />}
              {!locked && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const res = await setTrackingLinkArchivedAction(l.id, !l.archived);
                      if (!res.ok) setError(res.error);
                    })
                  }
                >
                  {l.archived ? (
                    <>
                      <RotateCcw aria-hidden /> Restaurar
                    </>
                  ) : (
                    <>
                      <Archive aria-hidden /> Arquivar
                    </>
                  )}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {!locked &&
        (open ? (
          <div className="grid gap-3 rounded-2xl border border-secondary/40 bg-secondary/5 p-4 sm:grid-cols-3">
            <div className="sm:col-span-3">{field("name", "Nome interno", "Ex.: Instagram stories")}</div>
            {field("utmSource", "utm_source (opcional)", "instagram")}
            {field("utmMedium", "utm_medium (opcional)", "social")}
            {field("utmCampaign", "utm_campaign (opcional)", "lancamento")}
            {field("utmContent", "utm_content (opcional)", "stories-1")}
            {field("utmTerm", "utm_term (opcional)", "")}
            <div>
              <Label htmlFor="tl-coupon">Aplicar cupom (opcional)</Label>
              <Select id="tl-coupon" className="mt-1.5" value={f.couponId} onChange={(e) => setF({ ...f, couponId: e.target.value })}>
                <option value="">—</option>
                {coupons.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex gap-2 sm:col-span-3">
              <Button onClick={save} disabled={pending}>
                {pending ? "Criando…" : "Criar link"}
              </Button>
              <Button variant="ghost" onClick={() => (setOpen(false), setF(empty), setError(null))}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={() => (setOpen(true), setCreated(null))}>
            Criar link de divulgação
          </Button>
        ))}
      {created && (
        <Alert variant="success" className="break-all">
          Link criado: {created}
        </Alert>
      )}
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
