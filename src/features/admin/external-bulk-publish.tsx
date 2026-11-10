"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { featureExternalEventsAction, publishExternalEventsAction, type BulkPublishResult } from "./actions";
import type { BulkFeatureItem } from "@/server/services/external-events";

type Mode = "publish" | "feature";
type Op = "publish" | "feature" | "unfeature";
type Item = { id: string; title: string; status: "published" | "changed" | "already" | "failed"; error?: string; cover?: "set" | "kept" | "none" };

// Ações de cada modo: publicar ("Em revisão"/"Ocultos"); destacar ou remover destaque ("Publicados").
const OPS: Record<Mode, Op[]> = { publish: ["publish"], feature: ["feature", "unfeature"] };

const TEXT: Record<Op, { button: string; verb: string; confirmNote: string; pendingLabel: string; done: (n: number) => string; already: (n: number) => string }> = {
  publish: {
    button: "Publicar selecionados",
    verb: "Publicar",
    confirmNote: "Só estes eventos serão publicados. Os que ainda não têm capa recebem a da página original quando houver.",
    pendingLabel: "Publicando…",
    done: (n) => `${n} ${n === 1 ? "evento publicado" : "eventos publicados"}`,
    already: (n) => `${n} já estava${n === 1 ? "" : "m"} publicado${n === 1 ? "" : "s"}`,
  },
  feature: {
    button: "Destacar selecionados",
    verb: "Destacar",
    confirmNote: "Só estes eventos serão destacados. Os que já estão em destaque continuam como estão.",
    pendingLabel: "Destacando…",
    done: (n) => `${n} ${n === 1 ? "evento destacado" : "eventos destacados"}`,
    already: (n) => `${n} já estava${n === 1 ? "" : "m"} em destaque`,
  },
  unfeature: {
    button: "Remover destaque dos selecionados",
    verb: "Remover destaque de",
    confirmNote: "Só estes eventos saem do destaque. Os que não estão em destaque continuam como estão.",
    pendingLabel: "Removendo…",
    done: (n) => `${n} ${n === 1 ? "evento saiu" : "eventos saíram"} do destaque`,
    already: (n) => `${n} não estava${n === 1 ? "" : "m"} em destaque`,
  },
};

export interface SelectableRow {
  id: string;
  title: string;
  /** Fora da ação (ex.: já publicado, ao publicar): não entra na seleção. */
  selectable: boolean;
  content: React.ReactNode;
}

/**
 * Lista de eventos externos (uma página) com seleção explícita para uma ação em lote:
 * publicar, destacar ou remover destaque. A seleção é só do que o admin marcou (ou
 * "todos desta página" no momento do clique); a página recria este componente ao mudar
 * filtros, aba ou página, e a seleção é limpa ao concluir: nenhum evento entra sozinho.
 */
export function ExternalBulkPublishList({ rows, total, max, mode = "publish" }: { rows: SelectableRow[]; total: number; max: number; mode?: Mode }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [op, setOp] = useState<Op>(OPS[mode][0]);
  const [result, setResult] = useState<{ op: Op; items: Item[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dialog = useRef<HTMLDialogElement>(null);
  const t = TEXT[op];

  const selectable = rows.filter((r) => r.selectable);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const chosen = rows.filter((r) => selected.has(r.id));
  const tooMany = chosen.length > max;

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const open = (next: Op) => {
    setOp(next);
    setResult(null);
    setError(null);
    dialog.current?.showModal();
  };

  const confirm = () =>
    start(async () => {
      setError(null);
      const ids = chosen.map((c) => c.id);
      const r: { ok: true; data: BulkPublishResult | BulkFeatureItem[] } | { ok: false; error: string } =
        op === "publish" ? await publishExternalEventsAction(ids) : await featureExternalEventsAction(ids, op === "feature");
      dialog.current?.close();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setResult({ op, items: r.data });
      // Concluída a operação (a lista já veio atualizada pela ação), a seleção recomeça vazia.
      setSelected(new Set());
    });

  const done = result?.items.filter((r) => r.status === "published" || r.status === "changed") ?? [];
  const already = result?.items.filter((r) => r.status === "already") ?? [];
  const failed = result?.items.filter((r) => r.status === "failed") ?? [];
  const covers = done.filter((r) => r.cover === "set").length;

  return (
    <>
      {selectable.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-card sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                className="size-4"
                checked={allSelected}
                onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((r) => r.id)) : new Set())}
              />
              Selecionar todos os eventos desta página ({selectable.length}
              {total > rows.length ? ` de ${total} encontrados` : ""})
            </label>
            <p className="text-xs text-muted-foreground">
              Vale só para os eventos exibidos nesta página, com os filtros atuais. Mudar filtros ou página limpa a seleção; nada é incluído sem estar marcado.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm" aria-live="polite">
              <strong>{chosen.length}</strong> {chosen.length === 1 ? "evento selecionado" : "eventos selecionados"}
            </p>
            {chosen.length > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Limpar seleção
              </Button>
            )}
            {OPS[mode].map((o, i) => (
              <Button key={o} type="button" size="sm" variant={i === 0 ? "secondary" : "outline"} disabled={chosen.length === 0 || tooMany || pending} onClick={() => open(o)}>
                {TEXT[o].button}
              </Button>
            ))}
          </div>
          {tooMany && (
            <p className="text-xs font-semibold text-destructive sm:basis-full" role="alert">
              Selecione no máximo {max} eventos por vez{mode === "publish" ? " (cada um pode buscar a capa na página original)" : ""}.
            </p>
          )}
        </div>
      )}

      {error && (
        <Alert variant="danger" role="alert" className="mb-3">
          {error}
        </Alert>
      )}
      {result && (
        <div role="status" className="mb-3 space-y-2 rounded-2xl border border-border bg-card p-4 text-sm shadow-card">
          <p className="font-semibold">
            {TEXT[result.op].done(done.length)}
            {result.op === "publish" && done.length > 0 && ` (${covers} com capa encontrada automaticamente)`}
            {already.length > 0 && ` · ${TEXT[result.op].already(already.length)}`}
            {failed.length > 0 && ` · ${failed.length} com falha`}
          </p>
          {failed.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-destructive">
              {failed.map((f) => (
                <li key={f.id}>
                  <strong>{f.title}</strong>: {f.error}
                </li>
              ))}
            </ul>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setResult(null)}>
            Fechar resultado
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Nenhum evento com esses filtros.</p>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-3 p-4">
              {selectable.length > 0 && (
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  aria-label={`Selecionar ${r.title}`}
                  disabled={!r.selectable}
                  checked={selected.has(r.id)}
                  onChange={(e) => toggle(r.id, e.target.checked)}
                />
              )}
              <div className="min-w-0 flex-1">{r.content}</div>
            </li>
          ))}
        </ul>
      )}

      <dialog
        ref={dialog}
        aria-labelledby="confirmar-lote"
        className="m-auto w-[min(32rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] rounded-2xl border border-border bg-card p-0 text-foreground shadow-lift backdrop:bg-black/50"
      >
        <div className="space-y-3 p-5">
          <h2 id="confirmar-lote" className="font-display text-lg font-bold">
            {t.verb} {chosen.length} {chosen.length === 1 ? "evento" : "eventos"}?
          </h2>
          <p className="text-sm text-muted-foreground">{t.confirmNote}</p>
          <ol className="max-h-64 list-decimal space-y-1 overflow-y-auto rounded-xl border border-border p-3 pl-8 text-sm">
            {chosen.map((c) => (
              <li key={c.id}>{c.title}</li>
            ))}
          </ol>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => dialog.current?.close()}>
              Cancelar
            </Button>
            <Button type="button" variant="secondary" disabled={pending || chosen.length === 0} onClick={confirm}>
              {pending ? t.pendingLabel : `${t.verb} ${chosen.length}`}
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
