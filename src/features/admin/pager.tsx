import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/** Monta `path?query` sem parâmetros vazios. */
export function adminHref(path: string, params: Record<string, string | number | undefined | null>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** Paginação por links (mantém os filtros da URL). */
export function Pager({ path, params, page, pageCount, total }: { path: string; params: Record<string, string | undefined>; page: number; pageCount: number; total: number }) {
  if (pageCount <= 1) return <p className="mt-3 text-xs text-muted-foreground">{total} {total === 1 ? "registro" : "registros"}</p>;
  const link = (p: number, label: string, disabled: boolean) =>
    disabled ? (
      <span className={buttonVariants({ variant: "outline", size: "sm", className: "pointer-events-none opacity-50" })} aria-disabled>
        {label}
      </span>
    ) : (
      <Link href={adminHref(path, { ...params, pagina: p })} className={buttonVariants({ variant: "outline", size: "sm" })}>
        {label}
      </Link>
    );
  return (
    <nav aria-label="Paginação" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
      {link(page - 1, "Anterior", page <= 1)}
      <span>
        Página {page} de {pageCount} · {total} registros
      </span>
      {link(page + 1, "Próxima", page >= pageCount)}
    </nav>
  );
}
