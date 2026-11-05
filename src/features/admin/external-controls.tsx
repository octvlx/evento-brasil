"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import type { CoverPreview } from "@/server/external/cover";
import {
  deleteExternalEventAction,
  importExternalByUrlAction,
  previewExternalCoverAction,
  removeExternalCoverAction,
  saveExternalCoverAction,
  uploadExternalCoverAction,
} from "./actions";

/** Cadastro manual pelo link da página do evento numa fonte autorizada; abre a edição. */
export function ImportExternalByUrlForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await importExternalByUrlAction(url);
          if (!r.ok) setError(r.error);
          else router.push(`/admin/eventos-externos/${r.data.id}`);
        });
      }}
    >
      <div className="flex-1 space-y-1">
        <Label htmlFor="external-url">Link da página do evento</Label>
        <Input id="external-url" type="url" required placeholder="https://duoticket.com.br/evento/…" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={error ? "external-url-error" : undefined} />
      </div>
      <Button disabled={pending || !url.trim()}>{pending ? "Lendo a página…" : "Cadastrar por link"}</Button>
      {error && (
        <p id="external-url-error" role="alert" className="text-sm text-destructive sm:basis-full">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Capa: cola a URL direta da imagem (com ou sem extensão) ou o link da página do evento,
 * vê a prévia e confirma. A imagem confirmada é copiada para o armazenamento da plataforma.
 * Sem imagem válida, dá para colar outra URL ou enviar o arquivo.
 */
export function ExternalCoverTool({ eventId, current, sourceUrl }: { eventId: string; current: string | null; sourceUrl: string }) {
  const [pending, start] = useTransition();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<CoverPreview | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const done = (r: { ok: boolean; error?: string }, okMessage: string) => {
    if (!r.ok) setError(r.error ?? "Erro inesperado.");
    else {
      setError(null);
      setPreview(null);
      setUrl("");
      setMessage(okMessage);
    }
  };

  return (
    <div className="space-y-4">
      {current ? (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- imagem já no armazenamento próprio, prévia simples */}
          <img src={current} alt="Capa atual" className="aspect-[2/1] w-full max-w-md rounded-xl border border-border object-cover" />
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => done(await removeExternalCoverAction(eventId), "Capa removida."))}>
            Remover capa
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Sem capa: o card usa o visual padrão de evento externo.</p>
      )}

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setMessage(null);
          setPreview(null);
          start(async () => {
            const r = await previewExternalCoverAction(eventId, url);
            if (!r.ok) setError(r.error);
            else {
              setPreview(r.data);
              setSelected(0);
            }
          });
        }}
      >
        <div className="flex-1 space-y-1">
          <Label htmlFor="cover-url">URL da imagem ou link da página do evento</Label>
          <Input id="cover-url" type="url" required placeholder={sourceUrl} value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" disabled={pending || !url.trim()}>
            {pending && !preview ? "Buscando…" : "Buscar capa"}
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setUrl(sourceUrl)}>
            Usar a página original
          </Button>
        </div>
      </form>

      {preview && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">
            {preview.kind === "direct" ? "Prévia da imagem" : `Imagens encontradas na página (${preview.candidates.length}). A mais provável vem primeiro:`}
          </legend>
          <ul className="grid gap-3 sm:grid-cols-2">
            {preview.candidates.map((c, i) => (
              <li key={c.url}>
                <label className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-2 text-xs ${i === selected ? "border-secondary ring-2 ring-secondary" : "border-border"}`}>
                  <span className="flex items-center gap-2">
                    <input type="radio" name="cover-candidate" checked={i === selected} onChange={() => setSelected(i)} />
                    <strong>
                      {c.width}×{c.height}
                    </strong>{" "}
                    · {c.type.replace("image/", "").toUpperCase()}
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- prévia remota antes de copiar */}
                  <img src={c.url} alt={`Candidata ${i + 1}`} referrerPolicy="no-referrer" className="aspect-[2/1] w-full rounded-lg bg-muted object-contain" />
                  <span className="text-muted-foreground">{c.hint}</span>
                  <span className="break-all text-muted-foreground">{c.url}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() => start(async () => done(await saveExternalCoverAction(eventId, preview.candidates[selected].url), "Capa salva e copiada para a plataforma."))}
            >
              {pending ? "Salvando…" : "Usar esta capa"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPreview(null)}>
              Cancelar
            </Button>
          </div>
        </fieldset>
      )}

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          setError(null);
          setMessage(null);
          start(async () => {
            done(await uploadExternalCoverAction(eventId, fd), "Capa enviada.");
            if (fileRef.current) fileRef.current.value = "";
          });
        }}
      >
        <div className="flex-1 space-y-1">
          <Label htmlFor="cover-file">Ou envie o arquivo (JPG, PNG ou WebP, até 5 MB)</Label>
          <Input ref={fileRef} id="cover-file" name="file" type="file" accept="image/jpeg,image/png,image/webp" required />
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          Enviar arquivo
        </Button>
      </form>

      {error && (
        <Alert variant="danger" role="alert">
          {error}
        </Alert>
      )}
      {message && (
        <Alert variant="success" role="status">
          {message}
        </Alert>
      )}
    </div>
  );
}

/** Exclusão definitiva do anúncio (com confirmação); volta para a lista. */
export function DeleteExternalEventButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Excluir
      </Button>
    );
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border p-2">
      <p className="text-xs">Exclui o anúncio: some da busca, das cidades e dos destaques. Uma nova coleta pode trazê-lo de volta em revisão; para não voltar, prefira &quot;Ocultar&quot;.</p>
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await deleteExternalEventAction(eventId);
              if (!r.ok) setError(r.error);
              else router.push("/admin/eventos-externos");
            })
          }
        >
          {pending ? "…" : "Confirmar exclusão"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Voltar
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
