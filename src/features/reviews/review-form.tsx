"use client";

import { useState, useTransition } from "react";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { submitReviewAction } from "./actions";

const LABELS = ["", "Ruim", "Fraco", "Bom", "Muito bom", "Excelente"];

/** Formulário de avaliação (nota 1–5 + comentário). Estrelas são radios: teclado e leitor de tela funcionam. */
export function ReviewForm({ eventId, existing, maxLength }: { eventId: string; existing: { rating: number; comment: string | null } | null; maxLength: number }) {
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [comment, setComment] = useState(existing?.comment ?? "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState(!!existing);
  const [pending, start] = useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rating) return setMessage({ ok: false, text: "Escolha uma nota de 1 a 5." });
    setMessage(null);
    start(async () => {
      const res = await submitReviewAction({ eventId, rating, comment: comment || undefined });
      if (res.ok) setSaved(true);
      setMessage(res.ok ? { ok: true, text: "Obrigado! Sua avaliação foi salva." } : { ok: false, text: res.error });
    });
  };
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="review-form">
      <fieldset>
        <legend className="mb-1 text-sm font-semibold">Sua nota</legend>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="cursor-pointer rounded-md p-0.5 focus-within:ring-2 focus-within:ring-ring">
              <input type="radio" name="rating" value={n} checked={rating === n} onChange={() => setRating(n)} className="sr-only" aria-label={`${n} de 5 — ${LABELS[n]}`} />
              <Star aria-hidden className={cn("size-8 transition", n <= rating ? "fill-amber-400 text-amber-500" : "text-muted-foreground")} />
            </label>
          ))}
          {rating > 0 && <span className="ml-2 text-sm text-muted-foreground">{LABELS[rating]}</span>}
        </div>
      </fieldset>
      <div>
        <label htmlFor={`review-comment-${eventId}`} className="mb-1 block text-sm font-semibold">
          Comentário <span className="font-normal text-muted-foreground">(opcional, aparece no perfil do organizador)</span>
        </label>
        <textarea
          id={`review-comment-${eventId}`}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={maxLength}
          rows={4}
          className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="O que você achou do evento?"
        />
        <p className="text-right text-xs text-muted-foreground">
          {comment.length}/{maxLength}
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        {saved ? "Atualizar avaliação" : "Enviar avaliação"}
      </Button>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={cn("text-sm", message.ok ? "text-emerald-700" : "text-destructive")}>
          {message.text}
        </p>
      )}
    </form>
  );
}

/** Estrelas só de leitura (média ou nota). */
export function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center", className)} role="img" aria-label={`${value.toLocaleString("pt-BR")} de 5 estrelas`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} aria-hidden className={cn("size-4", n <= Math.round(value) ? "fill-amber-400 text-amber-500" : "text-muted-foreground/50")} />
      ))}
    </span>
  );
}
