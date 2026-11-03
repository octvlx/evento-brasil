import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { ArrowRight, BadgePercent, QrCode, Search, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { EventCard, EventGrid, EventGridSkeleton } from "@/components/site/event-card";
import { CategoryChips } from "@/components/site/category-chips";
import { CitySelect } from "@/components/site/city-select";
import { EventCarousel } from "@/components/site/event-carousel";
import { cn } from "@/lib/utils";
import { db } from "@/server/db";
import { eventsInCity, featuredEvents, getPublicCity, listCategories, listCities, weekendEvents } from "@/server/services/catalog";

export default function HomePage() {
  return (
    <>
      <section className="bg-hero relative overflow-hidden text-white">
        <div className="mx-auto max-w-7xl px-4 pb-14 pt-12 sm:px-6 md:pb-20 md:pt-20">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold ring-1 ring-white/20 backdrop-blur">
            <Sparkles className="size-3.5" aria-hidden /> Shows, festas, teatro, esportes e muito mais
          </p>
          <h1 className="max-w-3xl font-display text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            O que você vai <span className="text-gradient">viver</span> neste fim de semana?
          </h1>
          <p className="mt-4 max-w-xl text-base text-white/80 sm:text-lg">Descubra eventos em todo o Brasil e garanta seu ingresso com PIX ou cartão, em poucos toques.</p>

          <form action="/eventos" role="search" className="mt-8 grid max-w-3xl gap-2 rounded-2xl bg-white/10 p-2 ring-1 ring-white/20 backdrop-blur sm:grid-cols-[1fr_auto_auto]">
            <label className="relative">
              <span className="sr-only">O que você procura?</span>
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-white/70" aria-hidden />
              <input
                name="q"
                type="search"
                placeholder="Artista, evento ou local"
                className="h-12 w-full rounded-xl bg-transparent pl-11 pr-3 text-base text-white placeholder:text-white/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              />
            </label>
            <Suspense fallback={<div className="h-12 w-full rounded-full bg-white/10 sm:w-56" />}>
              <HeroCitySelect />
            </Suspense>
            <button className="h-12 rounded-xl bg-accent px-6 font-bold text-accent-foreground transition hover:brightness-110">Buscar</button>
          </form>

          <div className="mt-6">
            <Suspense fallback={<div className="h-9" />}>
              <HeroCategories />
            </Suspense>
          </div>
        </div>
      </section>

      <Section title="Em destaque" subtitle="Seleção da curadoria Evento Brasil" href="/eventos">
        <Suspense fallback={<CarouselSkeleton />}>
          <Featured />
        </Suspense>
      </Section>

      <Suspense fallback={null}>
        <NearbySection />
      </Suspense>

      <Section title="Neste fim de semana" subtitle="Sexta a domingo, para não ficar em casa" href="/eventos?data=fim-de-semana">
        <Suspense fallback={<EventGridSkeleton />}>
          <Weekend />
        </Suspense>
      </Section>

      <section className="mx-auto mt-16 max-w-7xl px-4 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            { icon: Zap, title: "PIX na hora", text: "Pague com PIX ou cartão e receba o ingresso assim que o pagamento é confirmado." },
            { icon: QrCode, title: "Ingresso no celular", text: "QR code seguro, PDF para download e cópia no seu e-mail." },
            { icon: ShieldCheck, title: "Compra transparente", text: "Taxas exibidas antes do pagamento e política de reembolso clara em cada evento." },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-2xl border border-border bg-card p-5">
              <Icon className="mb-3 size-6 text-secondary" aria-hidden />
              <h3 className="font-display font-bold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-16 max-w-7xl px-4 sm:px-6">
        <div className="bg-hero relative overflow-hidden rounded-3xl p-8 text-white sm:p-12">
          <div className="max-w-2xl">
            <p className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-white/80">
              <BadgePercent className="size-4" aria-hidden /> Para produtores, casas e coletivos
            </p>
            <h2 className="font-display text-3xl font-extrabold sm:text-4xl">Venda ingressos com repasse transparente</h2>
            <p className="mt-3 text-white/80">
              Publique seu evento, receba via PIX e cartão, acompanhe vendas em tempo real e faça o check-in pelo celular. Comissão padrão de 7% sobre o valor de face — eventos gratuitos não pagam comissão.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/organizador/cadastro" className={buttonVariants({ variant: "accent", size: "lg" })}>
                Quero vender ingressos <ArrowRight aria-hidden />
              </Link>
              <Link href="/ajuda#taxas" className={buttonVariants({ variant: "outline", size: "lg", className: "border-white/30 bg-white/10 text-white hover:bg-white/20" })}>
                Ver taxas
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function Section({ title, subtitle, href, children }: { title: string; subtitle?: string; href?: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto mt-14 max-w-7xl px-4 sm:px-6">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {href && (
          <Link href={href} className="flex shrink-0 items-center gap-1 text-sm font-semibold text-secondary hover:underline">
            Ver todos <ArrowRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

async function HeroCitySelect() {
  // Lista depende de quais eventos estão no ar agora: lida a cada pedido.
  await connection();
  const cities = await listCities(db);
  return <CitySelect variant="hero" className="sm:w-56" cities={cities.map((c) => ({ slug: c.slug, label: `${c.name} – ${c.state}` }))} />;
}

async function HeroCategories() {
  const categories = await listCategories(db);
  return <CategoryChips tone="hero" categories={categories} hrefFor={(slug) => (slug ? `/eventos?categoria=${slug}` : "/eventos")} />;
}

// Largura do card por breakpoint (1 / 2 / 3 / 4 por tela), para o srcset da capa.
const CAROUSEL_IMAGE_SIZES = "(min-width: 1280px) 300px, (min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw";

async function Featured() {
  await connection();
  // Mesmos critérios de antes: destaque, publicado, de organização aprovada e não encerrado.
  const events = await featuredEvents(db, 12);
  if (!events.length) return <EventGrid events={[]} emptyText="Nenhum evento em destaque no momento." />;
  return (
    <EventCarousel label="Eventos em destaque">
      {events.map((e, i) => (
        <EventCard key={e.slug} event={e} priority={i < 4} imageSizes={CAROUSEL_IMAGE_SIZES} className="h-full" />
      ))}
    </EventCarousel>
  );
}

async function NearbySection() {
  const slug = (await cookies()).get("eb_city")?.value;
  await connection();
  const city = slug ? await getPublicCity(db, slug) : null;
  const target = city ?? (await getPublicCity(db, "sao-paulo-sp"));
  if (!target) return null;
  const events = await eventsInCity(db, target.slug, 4);
  return (
    <Section title={`Perto de você em ${target.name}`} subtitle={city ? "Com base na cidade escolhida" : "Escolha sua cidade no topo para personalizar"} href={`/cidades/${target.slug}`}>
      <EventGrid events={events} emptyText={`Ainda não há eventos publicados em ${target.name}.`} />
    </Section>
  );
}

async function Weekend() {
  await connection();
  return <EventGrid events={await weekendEvents(db, 8)} emptyText="Nenhum evento neste fim de semana ainda." />;
}

/** Mesma altura do carrossel (cards + linha de controles): sem salto ao carregar. */
function CarouselSkeleton() {
  return (
    <div aria-busy="true" aria-label="Carregando destaques">
      <div className="flex gap-5 overflow-hidden pb-1">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={cn("w-full shrink-0 overflow-hidden rounded-2xl border border-border md:w-[calc((100%-1.25rem)/2)] lg:w-[calc((100%-2.5rem)/3)] xl:w-[calc((100%-3.75rem)/4)]", ["", "hidden md:block", "hidden lg:block", "hidden xl:block"][i])}>
            <div className="aspect-[16/10] animate-pulse bg-muted" />
            <div className="space-y-2 p-4">
              <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-5 w-4/5 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
              <div className="h-9" />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 h-8" />
    </div>
  );
}
