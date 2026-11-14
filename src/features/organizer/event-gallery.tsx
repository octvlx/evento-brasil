"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { addEventImageAction, moveEventImageAction, removeEventImageAction, updateEventImageAltAction } from "./actions";

export interface GalleryImage {
  id: string;
  url: string;
  alt: string;
}

/** Fotos extras do evento (além da capa), com ordem, descrição e remoção. */
export function EventGallery({ eventId, images, max, minSide, locked }: { eventId: string; images: GalleryImage[]; max: number; minSide: number; locked?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Não foi possível salvar.");
    });
  const full = images.length >= max;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Até {max} fotos, que aparecem na página do evento depois da descrição. JPG, PNG ou WebP, até 5 MB, com pelo menos {minSide} px no lado menor. A descrição é lida por leitores de tela.
      </p>
      {images.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma foto na galeria.</p>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {images.map((img, i) => (
          <li key={img.id} className="space-y-2 rounded-2xl border border-border p-3" data-testid="gallery-image">
            <div className="aspect-[4/3] overflow-hidden rounded-xl bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.alt} className="h-full w-full object-cover" loading="lazy" />
            </div>
            <Input
              defaultValue={img.alt}
              aria-label={`Descrição da foto ${i + 1}`}
              disabled={locked || pending}
              maxLength={200}
              onBlur={(e) => e.target.value.trim() !== img.alt && run(() => updateEventImageAltAction(img.id, e.target.value))}
            />
            {!locked && (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" disabled={pending || i === 0} aria-label={`Mover a foto ${i + 1} para antes`} onClick={() => run(() => moveEventImageAction(img.id, "up"))}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button variant="ghost" size="sm" disabled={pending || i === images.length - 1} aria-label={`Mover a foto ${i + 1} para depois`} onClick={() => run(() => moveEventImageAction(img.id, "down"))}>
                  <ArrowDown aria-hidden />
                </Button>
                <Button variant="ghost" size="sm" className="ml-auto text-destructive" disabled={pending} onClick={() => run(() => removeEventImageAction(img.id))}>
                  <Trash2 aria-hidden /> Remover
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!locked && !full && (
        <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-dashed border-border p-4">
          <div className="min-w-0 basis-full sm:basis-64">
            <Label htmlFor="gallery-alt">Descrição da nova foto (opcional)</Label>
            <Input id="gallery-alt" className="mt-1.5" value={alt} maxLength={200} onChange={(e) => setAlt(e.target.value)} placeholder="Ex.: palco principal à noite" />
          </div>
          <div>
            <Label htmlFor="gallery-file">Foto</Label>
            <Input
              id="gallery-file"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="mt-1.5 w-auto max-w-full"
              disabled={pending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const fd = new FormData();
                fd.set("file", file);
                fd.set("alt", alt);
                run(async () => {
                  const r = await addEventImageAction(eventId, fd);
                  if (r.ok) setAlt("");
                  return r;
                });
              }}
            />
          </div>
          {pending && <span className="text-sm text-muted-foreground">Enviando…</span>}
        </div>
      )}
      {full && !locked && <p className="text-sm text-muted-foreground">A galeria está cheia. Remova uma foto para enviar outra.</p>}
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
