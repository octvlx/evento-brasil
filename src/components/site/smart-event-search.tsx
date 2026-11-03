"use client";

// Busca pública única (header, home e /eventos). Um campo: artista, evento,
// cidade, local ou frase ("Rock em São Paulo"). Escolher uma sugestão SÓ preenche
// o campo (e guarda a cidade escolhida); a busca acontece no Enter sem sugestão
// destacada ou no botão Buscar. A interpretação da frase é feita no servidor.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, Loader2, MapPin, Search, Sparkles, Tag, Ticket, X } from "lucide-react";
import { SEARCH_MAX_LENGTH } from "@/lib/search-query";
import { cn } from "@/lib/utils";

type Suggestion = { kind: "combo" | "city" | "event" | "venue" | "category"; label: string; q: string; detail?: string; citySlug?: string };
type Group = { kind: Suggestion["kind"]; title: string; items: Suggestion[] };

const ICONS = { combo: Sparkles, city: MapPin, event: CalendarDays, venue: Ticket, category: Tag } as const;
const DEBOUNCE_MS = 200;
const cache = new Map<string, Group[]>();

export const SEARCH_PLACEHOLDER = "Busque por artista, evento, cidade ou local...";

/** Lê o termo atual de /eventos (para o campo mostrar a busca feita) e remonta ao navegar. */
export function SmartEventSearch(props: Omit<SearchBoxProps, "initialQuery" | "initialCity">) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const onResults = pathname === "/eventos";
  const q = onResults ? (sp.get("q") ?? "") : "";
  const city = onResults ? (sp.get("cidade") ?? "") : "";
  return <SearchBox key={`${q}|${city}`} {...props} initialQuery={q} initialCity={city} />;
}

interface SearchBoxProps {
  variant: "header" | "page";
  /** Rótulo acessível do campo (cada instância tem o seu). */
  label: string;
  initialQuery: string;
  initialCity: string;
  placeholder?: string;
  autoFocus?: boolean;
  onNavigate?: () => void;
  className?: string;
}

function SearchBox({ variant, label, initialQuery, initialCity, placeholder = SEARCH_PLACEHOLDER, autoFocus, onNavigate, className }: SearchBoxProps) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initialQuery);
  // Sugestão escolhida: vale enquanto o texto do campo for o rótulo dela.
  const [chosen, setChosen] = useState<Suggestion | null>(initialCity && initialQuery ? { kind: "city", label: initialQuery, q: initialQuery, citySlug: initialCity } : null);
  // Sugestões e o termo a que respondem: termo diferente do campo = carregando.
  const [result, setResult] = useState<{ q: string; groups: Group[] }>({ q: "", groups: [] });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [announce, setAnnounce] = useState("");

  const query = text.trim();
  const fresh = result.q === query;
  const groups = useMemo(() => (fresh ? result.groups : []), [fresh, result.groups]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const loading = !fresh;

  useEffect(() => {
    if (query.length < 2 || !open) return;
    const hit = cache.get(query.toLowerCase());
    const controller = new AbortController();
    // Em memória: sem nova consulta. Senão, espera a digitação parar.
    const t = window.setTimeout(
      async () => {
        if (hit) return setResult({ q: query, groups: hit });
        try {
          const res = await fetch(`/api/busca/sugestoes?q=${encodeURIComponent(query)}`, { signal: controller.signal });
          const data = (await res.json()) as { groups?: Group[] };
          const next = res.ok ? (data.groups ?? []) : [];
          if (res.ok) cache.set(query.toLowerCase(), next);
          setResult({ q: query, groups: next });
        } catch {
          if (!controller.signal.aborted) setResult({ q: query, groups: [] });
        }
      },
      hit ? 0 : DEBOUNCE_MS,
    );
    return () => {
      controller.abort();
      window.clearTimeout(t);
    };
  }, [query, open]);

  const expanded = open && query.length >= 2;
  const activeIndex = active < flat.length ? active : -1;

  function choose(s: Suggestion) {
    setText(s.label);
    setChosen(s);
    setOpen(false);
    setActive(-1);
    setAnnounce(`${s.label} selecionado. Pressione Enter ou Buscar para pesquisar.`);
    inputRef.current?.focus();
  }

  function submit() {
    const params = onResultsPage(pathname) ? new URLSearchParams(sp.toString()) : new URLSearchParams();
    for (const k of ["q", "cidade", "pagina"]) params.delete(k);
    const usingChoice = chosen && chosen.label === text;
    const q = (usingChoice ? chosen.q : text).trim().slice(0, SEARCH_MAX_LENGTH);
    if (q) params.set("q", q);
    if (usingChoice && chosen.citySlug) {
      params.set("cidade", chosen.citySlug);
      // Mesma preferência que o antigo seletor guardava (seção "Perto de você").
      document.cookie = `eb_city=${encodeURIComponent(chosen.citySlug)}; path=/; max-age=31536000; samesite=lax`;
    }
    setOpen(false);
    onNavigate?.();
    const qs = params.toString();
    router.push(qs ? `/eventos?${qs}` : "/eventos");
  }

  const listId = `${id}-sugestoes`;
  const optionId = (i: number) => `${id}-opcao-${i}`;
  const isHeader = variant === "header";
  let index = -1;

  return (
    <form
      role="search"
      aria-label={label}
      className={cn("relative", className)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={cn("relative flex items-center", !isHeader && "gap-2")}>
        <div className="relative min-w-0 flex-1">
          <Search className={cn("pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground", isHeader ? "size-4" : "size-5")} aria-hidden />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            enterKeyHint="search"
            maxLength={SEARCH_MAX_LENGTH}
            autoFocus={autoFocus}
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setActive(-1);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (!flat.length) return;
                e.preventDefault();
                setOpen(true);
                const next = activeIndex + (e.key === "ArrowDown" ? 1 : -1);
                setActive(next >= flat.length ? 0 : next < 0 ? flat.length - 1 : next);
              } else if (e.key === "Enter" && expanded && activeIndex >= 0 && flat[activeIndex]) {
                // Enter numa sugestão destacada só seleciona; o próximo Enter busca.
                e.preventDefault();
                choose(flat[activeIndex]);
              } else if (e.key === "Escape" && open) {
                e.preventDefault();
                setOpen(false);
                setActive(-1);
              }
            }}
            className={cn(
              "w-full border border-input pl-10 text-foreground placeholder:text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden",
              isHeader ? "h-10 rounded-full bg-muted/60 pr-20 text-sm" : "h-12 rounded-xl bg-card pr-10 text-base shadow-sm",
            )}
          />
          {text && (
            <button
              type="button"
              aria-label="Limpar busca"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText("");
                setChosen(null);
                setActive(-1);
                inputRef.current?.focus();
              }}
              className={cn("absolute top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground", isHeader ? "right-11" : "right-2")}
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
          {isHeader && (
            <button type="submit" aria-label="Buscar" className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-secondary text-secondary-foreground transition hover:brightness-110">
              <Search className="size-4" aria-hidden />
            </button>
          )}
        </div>
        {!isHeader && (
          <button type="submit" className="h-12 shrink-0 rounded-xl bg-accent px-5 font-bold text-accent-foreground transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-7">
            Buscar
          </button>
        )}
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label="Sugestões de busca"
        hidden={!expanded}
        className="absolute inset-x-0 top-full z-50 mt-1.5 max-h-[min(24rem,70vh)] overflow-y-auto rounded-2xl border border-border bg-card p-1.5 text-left text-foreground shadow-xl"
      >
        {loading ? (
          <p role="presentation" className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Buscando sugestões…
          </p>
        ) : groups.length ? (
          groups.map((g) => (
            <div key={g.kind} role="group" aria-label={g.title} className="py-1">
              <p role="presentation" className="px-3 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                {g.title}
              </p>
              {g.items.map((s) => {
                index++;
                const i = index;
                const Icon = ICONS[s.kind];
                return (
                  <div
                    key={`${s.kind}-${s.label}-${s.citySlug ?? ""}`}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === activeIndex}
                    // mousedown antes do blur: a escolha não se perde ao fechar a lista.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(s);
                    }}
                    onMouseMove={() => setActive(i)}
                    className={cn("flex cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2 text-sm", i === activeIndex && "bg-secondary/10")}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{s.label}</span>
                      {s.detail && <span className="block truncate text-xs text-muted-foreground">{s.detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        ) : (
          <p role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
            Nenhuma sugestão. Pressione Enter para buscar “{query}”.
          </p>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {announce || (expanded && !loading ? (flat.length ? `${flat.length} sugestões. Use as setas para navegar.` : "Nenhuma sugestão.") : "")}
      </p>
    </form>
  );
}

const onResultsPage = (pathname: string) => pathname === "/eventos";
