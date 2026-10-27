import Link from "next/link";
import { Suspense } from "react";
import { ChevronDown, Search, Ticket, UserRound } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { db } from "@/server/db";
import { getActiveMembership, getCurrentUser } from "@/server/auth/current";
import { listCities } from "@/server/services/catalog";
import { logoutAction } from "@/features/auth/actions";
import { Logo } from "./logo";
import { CitySelect } from "./city-select";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 print:hidden border-b border-border/70 bg-background/85 backdrop-blur-lg">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Logo />
        <form action="/eventos" role="search" className="relative ml-4 hidden max-w-sm flex-1 md:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            name="q"
            type="search"
            placeholder="Buscar eventos, artistas, locais"
            aria-label="Buscar eventos"
            className="h-10 w-full rounded-full border border-input bg-muted/60 pl-9 pr-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </form>
        <div className="ml-auto flex items-center gap-2">
          <Suspense fallback={<div className="hidden h-10 w-36 rounded-full bg-muted sm:block" />}>
            <HeaderCitySelect />
          </Suspense>
          <Link href="/organizador" className="hidden text-sm font-semibold text-muted-foreground hover:text-foreground lg:block">
            Para organizadores
          </Link>
          <Suspense fallback={<div className="h-10 w-24 rounded-xl bg-muted" />}>
            <UserMenu />
          </Suspense>
        </div>
      </div>
    </header>
  );
}

async function HeaderCitySelect() {
  const cities = await listCities(db, { featuredOnly: true });
  return <CitySelect cities={cities.map((c) => ({ slug: c.slug, label: `${c.name} – ${c.state}` }))} className="hidden sm:block" />;
}

async function UserMenu() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Link href="/entrar" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          Entrar
        </Link>
        <Link href="/registrar" className={buttonVariants({ variant: "default", size: "sm", className: "hidden sm:inline-flex" })}>
          Criar conta
        </Link>
      </div>
    );
  }
  const { memberships } = await getActiveMembership(user.id);
  const isOrganizer = memberships.some((m) => m.role !== "CHECKIN_STAFF");
  const isStaff = memberships.length > 0;
  return (
    <div className="flex items-center gap-1">
      <Link href="/meus-ingressos" className={buttonVariants({ variant: "ghost", size: "sm", className: "hidden sm:inline-flex" })}>
        <Ticket aria-hidden /> Meus ingressos
      </Link>
      <details className="group relative">
        <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-full border border-border px-2.5 text-sm font-semibold hover:bg-muted [&::-webkit-details-marker]:hidden">
          <span className="grid size-7 place-items-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
          <span className="sr-only">Menu da conta</span>
        </summary>
        <nav className="absolute right-0 mt-2 w-60 overflow-hidden rounded-2xl border border-border bg-card p-1.5 shadow-xl">
          <p className="truncate px-3 py-2 text-xs text-muted-foreground">
            <UserRound className="mr-1 inline size-3.5" aria-hidden />
            {user.email}
          </p>
          <MenuLink href="/meus-ingressos">Meus ingressos</MenuLink>
          <MenuLink href="/minha-conta">Minha conta</MenuLink>
          {isOrganizer && <MenuLink href="/organizador">Painel do organizador</MenuLink>}
          {isStaff && <MenuLink href="/check-in">Check-in</MenuLink>}
          {user.platformRole === "ADMIN" && <MenuLink href="/admin">Administração</MenuLink>}
          <form action={logoutAction}>
            <button className="w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-destructive hover:bg-muted">Sair</button>
          </form>
        </nav>
      </details>
    </div>
  );
}

function MenuLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="block rounded-xl px-3 py-2 text-sm font-medium hover:bg-muted">
      {children}
    </Link>
  );
}
