"use client";

// Tela final do cadastro de organizador: o que acontece depois do envio.
// Nunca sugere aprovação; a página só a mostra com a organização em análise.
import Link from "next/link";
import { useEffect, useRef } from "react";
import { ArrowRight, Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NEXT_STEPS = [
  { title: "Análise da equipe", text: "Conferimos os dados do cadastro. O status aparece no seu painel." },
  { title: "Enquanto isso", text: "Você já pode montar rascunhos de eventos. Publicar só depois da aprovação." },
  { title: "Depois da aprovação", text: "Conecte sua conta do Mercado Pago para receber os repasses das vendas." },
];

export function ApplicationSubmitted({ name, resubmitted }: { name: string; resubmitted: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Chegou do último passo: o foco vai para o título (leitores de tela anunciam o resultado).
  useEffect(() => headingRef.current?.focus(), []);
  return (
    <div className="mx-auto max-w-2xl rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-card motion-safe:animate-step-in sm:p-8">
      <span className="grid size-12 place-items-center rounded-full bg-success-soft text-success" aria-hidden>
        <Check className="size-6" />
      </span>
      <h2 ref={headingRef} tabIndex={-1} className="mt-4 font-display text-xl font-bold focus:outline-none sm:text-2xl">
        Cadastro enviado para análise
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {resubmitted ? "Recebemos o novo envio" : "Recebemos o cadastro"} de <strong className="text-foreground">{name}</strong>. Ele ainda não está aprovado: veja o que acontece agora.
      </p>
      <ol className="mt-6 space-y-4">
        {NEXT_STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border-2 border-border text-xs font-bold text-muted-foreground" aria-hidden>
              {i + 1}
            </span>
            <span className="text-sm">
              <strong className="block font-semibold">{s.title}</strong>
              <span className="text-muted-foreground">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>
      <Link href="/organizador" className={cn(buttonVariants({ size: "lg" }), "mt-8 w-full sm:w-auto")}>
        Ir para o painel <ArrowRight aria-hidden />
      </Link>
    </div>
  );
}
