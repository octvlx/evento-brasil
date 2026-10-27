"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Abre a impressão do navegador (também serve para "Salvar como PDF"). */
export function PrintButton({ label = "Imprimir" }: { label?: string }) {
  return (
    <Button type="button" variant="outline" onClick={() => window.print()}>
      <Printer aria-hidden /> {label}
    </Button>
  );
}
