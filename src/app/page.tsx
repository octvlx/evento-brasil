import Link from "next/link";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { ArrowRight, BadgePercent, QrCode, ShieldCheck, Zap } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { EventCard, EventGrid, EventGridSkeleton } from "@/components/site/event-card";
import { CategoryChips } from "@/components/site/category-chips";
import { SmartEventSearch } from "@/components/site/smart-event-search";
import { EventCarousel } from "@/components/site/event-carousel";
import { cn } from "@/lib/utils";
import { db } from "@/server/db";
import { eventsInCity, featuredEvents, getPublicCity, listCategories, weekendEvents } from "@/server/services/catalog";

export default function HomePage() {
  return (
    <>
      {/* 1. Destaques logo abaixo do header, com uma introdução de uma linha. */}
      <section aria-labelledby="destaques-titulo" className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 sm:pt-8">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-extrabold leading-tight sm:text-[2rem]">
              Qual é o <span className="highlight-lime">rolê</span> de hoje?
            </h1>
            <h2 id="destaques-titulo" className="mt-1.5 text-sm font-semibold text-muted-foreground">
              Em destaque <span className="font-normal">· seleção da QQPega</span>
            </h2>
          </div>
          <Link href="/eventos" className="flex shrink-0 items-center gap-1 text-sm font-semibold text-secondary hover:underline">
            Ver todos <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        <Suspense fallback={<CarouselSkeleton />}>
          <Featured />
        </Suspense>
      </section>

      {/* 2. Busca compacta: um campo só (artista, evento, cidade, local ou "Rock em São Paulo"). */}
      <section aria-labelledby="busca-titulo" className="mx-auto mt-6 max-w-7xl px-4 sm:px-6">
        <div className="bg-hero relative overflow-hidden rounded-3xl px-3 py-3 sm:px-5 sm:py-4">
          <div className="bg-dots pointer-events-none absolute inset-0" aria-hidden />
          <p className="relative mx-auto mb-2 max-w-3xl font-display text-base font-bold leading-tight text-white sm:text-lg">
            Encontre seu <span className="text-lime">próximo evento</span>
          </p>
          <h2 id="busca-titulo" className="sr-only">
            Buscar eventos
          </h2>
          <Suspense fallback={<div className="mx-auto h-12 max-w-3xl rounded-xl bg-white/15" />}>
            <SmartEventSearch variant="page" label="Buscar eventos, artistas, cidades ou locais" className="relative mx-auto max-w-3xl" />
          </Suspense>
          <div className="relative mx-auto mt-2.5 max-w-3xl">
            <Suspense fallback={<div className="h-9" />}>
              <HeroCategories />
            </Suspense>
          </div>
        </div>
      </section>

      <Suspense fallback={null}>
        <NearbySection />
      </Suspense>

      <Section title="Neste fim de semana" subtitle="De sexta a domingo" href="/eventos?data=fim-de-semana">
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
            <div key={title} className="rounded-2xl border border-border bg-card p-5 shadow-card">
              <span className="mb-3 grid size-10 place-items-center rounded-xl bg-night text-lime">
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="font-bold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto mt-16 max-w-7xl px-4 sm:px-6">
        <div className="bg-hero relative overflow-hidden rounded-3xl p-8 text-white sm:p-12">
          <div className="bg-dots pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative max-w-2xl">
            <p className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-lime">
              <BadgePercent className="size-4" aria-hidden /> Para produtores, casas e coletivos
            </p>
            <h2 className="font-display text-2xl font-extrabold leading-tight sm:text-4xl">Venda ingressos com repasse transparente</h2>
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
          <h2 className="font-display text-xl font-extrabold sm:text-2xl">{title}</h2>
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

async function HeroCategories() {
  const categories = await listCategories(db);
  return <CategoryChips tone="hero" compact categories={categories} hrefFor={(slug) => (slug ? `/eventos?categoria=${slug}` : "/eventos")} />;
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
