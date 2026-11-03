import Link from "next/link";
import { Suspense } from "react";
import { ChevronDown, Ticket, UserRound } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getActiveMembership, getCurrentUser } from "@/server/auth/current";
import { logoutAction } from "@/features/auth/actions";
import { Logo } from "./logo";
import { HeaderSearch, HeaderSearchMobile } from "./header-search";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 print:hidden border-b border-border/70 bg-background/85 backdrop-blur-lg">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-3 sm:gap-3 sm:px-6">
        {/* Celular: logo e margens menores para caber lupa, Entrar e Criar conta; abaixo de
            370 px fica só o símbolo (o link mantém o nome acessível). */}
        <Logo className="shrink-0 max-sm:text-base" wordmarkClassName="max-[369px]:hidden" />
        {/* useSearchParams/usePathname são dados de runtime: Suspense com Cache Components. */}
        <Suspense fallback={<div className="ml-2 hidden h-10 max-w-xl flex-1 rounded-full bg-muted/60 md:block lg:ml-6" />}>
          <HeaderSearch />
        </Suspense>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <Suspense fallback={null}>
            <HeaderSearchMobile />
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

async function UserMenu() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="flex items-center gap-1 sm:gap-2">
        <Link href="/entrar" className={buttonVariants({ variant: "ghost", size: "sm", className: "max-sm:px-2.5" })}>
          Entrar
        </Link>
        <Link href="/registrar" className={buttonVariants({ variant: "default", size: "sm", className: "max-sm:px-2.5" })}>
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
      {/* cn (twMerge): sem ele o inline-flex da base vence o hidden e o link aparecia no celular. */}
      <Link href="/meus-ingressos" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "hidden sm:inline-flex")}>
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
          <MenuLink href="/meus-pedidos">Meus pedidos</MenuLink>
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
