"use client";

// Filtro de data da busca: atalhos (hoje, fim de semana…) ou "Escolher período", que
// mostra De/Até (?de=&ate=). Os campos de período só existem no formulário quando
// "período" está escolhido, para não enviar datas antigas junto com um atalho.
import { useState } from "react";
import { Input, Select } from "@/components/ui/primitives";

export const CUSTOM_PERIOD = "periodo";

export function DateFilterField({
  options,
  defaultValue,
  de,
  ate,
}: {
  options: [string, string][];
  defaultValue: string;
  de?: string;
  ate?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [from, setFrom] = useState(de ?? "");
  const custom = value === CUSTOM_PERIOD;
  return (
    // `contents`: o seletor ocupa a sua coluna da grade; o período vira um item próprio,
    // logo abaixo no celular e numa linha inteira no fim do formulário a partir do sm.
    <div className="contents">
      {/* "periodo" não vai na URL: quem define o período são `de` e `ate`. */}
      <Select name={custom ? undefined : "data"} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Data">
        <option value="">Qualquer data</option>
        {options.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
        <option value={CUSTOM_PERIOD}>Escolher período…</option>
      </Select>
      {custom && (
        <div className="grid grid-cols-2 gap-2 sm:order-last sm:col-span-full sm:max-w-md" data-testid="date-range">
          <label className="text-xs text-muted-foreground">
            De
            <Input type="date" name="de" defaultValue={de} onChange={(e) => setFrom(e.target.value)} className="mt-1 h-10" />
          </label>
          <label className="text-xs text-muted-foreground">
            Até
            <Input type="date" name="ate" defaultValue={ate} min={from || undefined} className="mt-1 h-10" />
          </label>
        </div>
      )}
    </div>
  );
}
