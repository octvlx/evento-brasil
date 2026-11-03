"use client";

// UF + município (combobox ARIA) para o endereço do evento. A lista vem da base
// local do IBGE, uma UF por vez (/api/municipios/[uf]); a tabela City não é
// consultada e pesquisar não cria cidade (ela só nasce quando o evento é salvo).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Input, Select } from "@/components/ui/primitives";
import { UFS } from "@/lib/br";
import { filterMunicipalities, type MunicipalityOption } from "@/lib/municipality-search";
import { cn } from "@/lib/utils";

export interface MunicipalityValue {
  uf: string;
  ibgeCode: string;
  name: string;
}

const cache = new Map<string, Promise<MunicipalityOption[]>>();

function loadUf(uf: string): Promise<MunicipalityOption[]> {
  let p = cache.get(uf);
  if (!p) {
    p = fetch(`/api/municipios/${uf}`).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<MunicipalityOption[]>;
    });
    // Falha de rede não fica no cache: a próxima tentativa baixa de novo.
    p.catch(() => cache.delete(uf));
    cache.set(uf, p);
  }
  return p;
}

export const municipalityLabel = (name: string, uf: string) => `${name} — ${uf}`;

const MAX_OPTIONS = 50;

export function MunicipalityCombobox({
  value,
  onChange,
  idPrefix,
  ufError,
  cityError,
  disabled,
  className,
}: {
  value: MunicipalityValue;
  onChange: (v: MunicipalityValue) => void;
  idPrefix: string;
  ufError?: string;
  cityError?: string;
  disabled?: boolean;
  className?: string;
}) {
  const ufId = `${idPrefix}-uf`;
  const inputId = `${idPrefix}-city`;
  const listId = `${useId()}-municipios`;
  const [list, setList] = useState<{ uf: string; items: MunicipalityOption[] } | null>(null);
  const [failedUf, setFailedUf] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!value.uf) return;
    let alive = true;
    loadUf(value.uf).then(
      (items) => alive && setList({ uf: value.uf, items }),
      () => alive && setFailedUf(value.uf),
    );
    return () => {
      alive = false;
    };
  }, [value.uf, retry]);

  const items = list?.uf === value.uf ? list.items : null;
  const loading = !!value.uf && !items && failedUf !== value.uf;
  const shown = text ?? (value.ibgeCode && value.name ? municipalityLabel(value.name, value.uf) : "");
  const options = useMemo(() => (items ? filterMunicipalities(items, text ?? "", MAX_OPTIONS) : []), [items, text]);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const expanded = open && !!value.uf && (loading || !!items);

  useEffect(() => {
    if (!expanded) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, expanded]);

  const choose = (m: MunicipalityOption) => {
    onChange({ uf: value.uf, ibgeCode: String(m.id), name: m.nome });
    setText(null);
    setOpen(false);
  };

  const describedCity = [cityError && `${inputId}-error`, `${inputId}-help`].filter(Boolean).join(" ");

  return (
    <div className={cn("grid gap-4 sm:grid-cols-6", className)}>
      <div className="sm:col-span-2">
        <label htmlFor={ufId} className="text-sm font-medium">
          Estado (UF)
        </label>
        <Select
          id={ufId}
          className="mt-1.5"
          value={value.uf}
          disabled={disabled}
          aria-invalid={!!ufError}
          aria-describedby={ufError ? `${ufId}-error` : undefined}
          data-field="newVenue.cityUf"
          onChange={(e) => {
            setText(null);
            setFailedUf(null);
            onChange({ uf: e.target.value, ibgeCode: "", name: "" });
          }}
        >
          <option value="">Selecione</option>
          {UFS.map((u) => (
            <option key={u.uf} value={u.uf}>
              {u.uf} — {u.name}
            </option>
          ))}
        </Select>
        {ufError && (
          <p id={`${ufId}-error`} className="mt-1.5 text-xs font-medium text-destructive">
            <span aria-hidden>⚠ </span>
            {ufError}
          </p>
        )}
      </div>
      <div className="relative sm:col-span-4">
        <label htmlFor={inputId} className="text-sm font-medium">
          Cidade
        </label>
        <div className="relative mt-1.5">
          <Input
            id={inputId}
            role="combobox"
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-activedescendant={expanded && options.length ? `${listId}-${activeIndex}` : undefined}
            aria-invalid={!!cityError}
            aria-describedby={describedCity}
            aria-busy={loading}
            data-field="newVenue.cityIbgeCode"
            disabled={disabled || !value.uf}
            placeholder={value.uf ? "Digite o nome da cidade" : "Escolha a UF primeiro"}
            value={shown}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
              setOpen(true);
              // Texto editado: a cidade escolhida antes deixa de valer até escolher de novo.
              if (value.ibgeCode) onChange({ uf: value.uf, ibgeCode: "", name: "" });
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onBlur={() => {
              setOpen(false);
              if (value.ibgeCode) setText(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!open) return setOpen(true);
                if (!options.length) return;
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setActive((activeIndex + delta + options.length) % options.length);
              } else if (e.key === "Enter") {
                if (expanded && options[activeIndex]) {
                  e.preventDefault();
                  choose(options[activeIndex]);
                }
              } else if (e.key === "Escape") {
                if (open) {
                  e.preventDefault();
                  setOpen(false);
                  if (value.ibgeCode) setText(null);
                }
              }
            }}
            className="pr-9"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
        </div>
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Municípios"
          hidden={!expanded}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg"
        >
          {loading ? (
            <li role="presentation" className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Carregando municípios…
            </li>
          ) : options.length ? (
            options.map((m, i) => (
              <li
                key={m.id}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === activeIndex}
                // mousedown antes do blur: a escolha não se perde ao fechar a lista.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(m);
                }}
                onMouseMove={() => setActive(i)}
                className={cn("cursor-pointer rounded-lg px-3 py-2 text-sm", i === activeIndex && "bg-secondary/10 text-foreground")}
              >
                {municipalityLabel(m.nome, value.uf)}
              </li>
            ))
          ) : (
            <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
              Nenhum município encontrado em {value.uf}.
            </li>
          )}
        </ul>
        <p id={`${inputId}-help`} className="mt-1.5 text-xs text-muted-foreground" aria-live="polite">
          {failedUf === value.uf && value.uf ? (
            <>
              Não foi possível carregar os municípios.{" "}
              <button
                type="button"
                className="font-semibold text-secondary underline"
                onClick={() => {
                  setFailedUf(null);
                  setRetry((n) => n + 1);
                }}
              >
                Tentar de novo
              </button>
            </>
          ) : loading ? (
            "Carregando municípios…"
          ) : (
            "Escolha a cidade na lista. Ela aparece no site quando o evento for publicado."
          )}
        </p>
        {cityError && (
          <p id={`${inputId}-error`} className="mt-1.5 text-xs font-medium text-destructive">
            <span aria-hidden>⚠ </span>
            {cityError}
          </p>
        )}
      </div>
    </div>
  );
}
