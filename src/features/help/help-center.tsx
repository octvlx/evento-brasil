"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BadgePercent, ChevronDown, CreditCard, Megaphone, QrCode, Receipt, Search, Send, UserRound, Undo2, type LucideIcon } from "lucide-react";
import type { HelpQuestion, HelpTopic, HelpTopicId } from "@/content/help";

const TOPIC_ICONS: Record<HelpTopicId, LucideIcon> = {
  comprar: CreditCard,
  ingressos: QrCode,
  transferencia: Send,
  cancelamento: Undo2,
  "meia-entrada": BadgePercent,
  taxas: Receipt,
  conta: UserRound,
  organizadores: Megaphone,
};

/** Minúsculas e sem acentos, para "reembolso" achar "Reembolso" e "transferencia" achar "transferência". */
const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function matches(q: HelpQuestion, terms: string[]) {
  const text = normalize([q.question, ...q.answer].join(" "));
  return terms.every((t) => text.includes(t));
}

function Question({ q, open }: { q: HelpQuestion; open?: boolean }) {
  return (
    <details id={q.id} open={open} className="group scroll-mt-24 border-b border-border last:border-b-0">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 py-4 font-semibold marker:hidden [&::-webkit-details-marker]:hidden">
        <span>{q.question}</span>
        <ChevronDown aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 pb-5 text-[15px] leading-relaxed text-muted-foreground">
        {q.answer.map((p) => (
          <p key={p}>{p}</p>
        ))}
        {q.links && (
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            {q.links.map((l) => (
              <Link key={l.href} href={l.href} className="font-semibold text-secondary hover:underline">
                {l.label} →
              </Link>
            ))}
          </p>
        )}
      </div>
    </details>
  );
}

/** Busca e lista de temas da Central de ajuda. Sem JavaScript, mostra todas as perguntas. */
export function HelpCenter({ topics }: { topics: HelpTopic[] }) {
  const [query, setQuery] = useState("");
  const terms = useMemo(() => normalize(query).split(/\s+/).filter(Boolean), [query]);
  const results = useMemo(
    () => (terms.length ? topics.flatMap((t) => t.questions.filter((q) => matches(q, terms)).map((q) => ({ topic: t, q }))) : []),
    [topics, terms],
  );

  return (
    <div className="space-y-10">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Busque por reembolso, transferência, QR code…"
          aria-label="Buscar na Central de ajuda"
          className="h-14 w-full rounded-2xl border border-border bg-card pl-12 pr-4 text-base shadow-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {terms.length > 0 ? (
        <section aria-live="polite" aria-label="Resultados da busca">
          <p className="mb-2 text-sm text-muted-foreground">
            {results.length === 0 ? "Nenhuma pergunta encontrada." : `${results.length} ${results.length === 1 ? "pergunta encontrada" : "perguntas encontradas"}.`}
          </p>
          {results.length > 0 ? (
            <div className="rounded-2xl border border-border bg-card px-5 shadow-card">
              {results.map(({ topic, q }) => (
                <div key={q.id}>
                  <p className="pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{topic.title}</p>
                  <Question q={q} open={results.length <= 3} />
                </div>
              ))}
            </div>
          ) : (
            <p>
              Não achou o que procurava?{" "}
              <a href="#contato" className="font-semibold text-secondary hover:underline">
                Fale com a gente
              </a>
              .
            </p>
          )}
        </section>
      ) : (
        <>
          <nav aria-label="Temas da ajuda" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {topics.map((t) => {
              const Icon = TOPIC_ICONS[t.id];
              return (
                <a key={t.id} href={`#${t.id}`} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-card transition-colors hover:border-secondary">
                  <Icon aria-hidden className="size-6 text-secondary" />
                  <span className="font-semibold leading-tight">{t.title}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{t.summary}</span>
                </a>
              );
            })}
          </nav>

          {topics.map((t) => {
            const Icon = TOPIC_ICONS[t.id];
            return (
              <section key={t.id} id={t.id} className="scroll-mt-24">
                <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                  <Icon aria-hidden className="size-5 text-secondary" />
                  {t.title}
                </h2>
                <div className="mt-3 rounded-2xl border border-border bg-card px-5 shadow-card">
                  {t.questions.map((q) => (
                    <Question key={q.id} q={q} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
