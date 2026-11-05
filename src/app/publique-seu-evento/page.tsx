import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  CalendarPlus,
  CircleDollarSign,
  Gift,
  QrCode,
  Send,
  ShieldCheck,
  Ticket,
  UserPlus,
  Users,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { commissionPerUnit } from "@/features/fees/policy";
import { BRAND } from "@/lib/brand";
import { START_PUBLISHING_HREF } from "@/lib/help-links";
import { formatBRL } from "@/lib/money";
import { db } from "@/server/db";
import { currentPlatformCommissionRule } from "@/server/services/commission";

export const metadata: Metadata = {
  title: "Publique seu evento",
  description: `Como publicar e vender ingressos na ${BRAND.name}: cadastro, aprovação, criação do evento, comissões e eventos gratuitos.`,
};

// Página explicativa para organizadores, aberta sem login. Só descreve o que existe no
// produto: as etapas seguem os serviços (organizers.ts, events.ts) e os valores de
// comissão vêm da regra de plataforma vigente no banco (o admin pode alterá-la).

const STEPS = [
  {
    icon: UserPlus,
    title: "Cadastre sua organização",
    text: "Entre com sua conta e informe os dados da organização e do responsável: pessoa física (CPF) ou empresa (CNPJ).",
  },
  {
    icon: BadgeCheck,
    title: "Aguarde a aprovação",
    text: `A equipe da ${BRAND.name} analisa o cadastro antes da primeira publicação. Você acompanha a situação no painel do organizador.`,
  },
  {
    icon: CalendarPlus,
    title: "Crie o evento",
    text: "Pelo assistente: data, local ou link online, descrição, tipos de ingresso, preços, quantidades e políticas de reembolso e transferência.",
  },
  {
    icon: Send,
    title: "Envie para publicação",
    text: "O evento passa por moderação antes de aparecer no site. Organizações liberadas pela plataforma para publicação automática vão direto ao ar.",
  },
  {
    icon: BarChart3,
    title: "Venda e acompanhe",
    text: "No painel, você acompanha vendas, participantes e repasses, e faz o check-in pelo celular com o QR code de cada ingresso.",
  },
] as const;

const FEATURES = [
  { icon: Users, title: "Equipe com papéis", text: "Convide pessoas para administrar, gerenciar eventos, cuidar do financeiro ou fazer a portaria." },
  { icon: QrCode, title: "Check-in pelo celular", text: "Leitura do QR code na entrada, com aviso de ingresso já usado ou cancelado." },
  { icon: Ticket, title: "Cupons e links rastreados", text: "Crie cupons de desconto e links para saber de onde vêm as vendas." },
  { icon: ShieldCheck, title: "Regras claras para o público", text: "Política de reembolso e de transferência mostradas na página do evento, antes da compra." },
] as const;

export default function PublishEventPage() {
  return (
    <div className="pb-6">
      {/* Abertura */}
      <section className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 sm:pt-8">
        <div className="bg-hero relative overflow-hidden rounded-3xl px-6 py-10 text-white sm:px-12 sm:py-14">
          <div className="bg-dots pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative max-w-2xl">
            <p className="mb-3 text-sm font-semibold text-lime">Para produtores, casas, artistas e coletivos</p>
            <h1 className="font-display text-3xl font-extrabold leading-tight sm:text-5xl">Publique seu evento na {BRAND.name}</h1>
            <p className="mt-4 text-base text-white/85 sm:text-lg">
              Cadastre sua organização, crie o evento e venda ou distribua ingressos com QR code. Veja abaixo como funciona, quanto custa e o que muda para eventos gratuitos.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href={START_PUBLISHING_HREF} className={buttonVariants({ variant: "accent", size: "lg" })}>
                Começar a publicar <ArrowRight aria-hidden />
              </Link>
              <a href="#taxas" className={buttonVariants({ variant: "outline", size: "lg", className: "border-white/30 bg-white/10 text-white hover:bg-white/20" })}>
                Ver comissões e taxas
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Passo a passo */}
      <section aria-labelledby="como-funciona" className="mx-auto mt-14 max-w-7xl px-4 sm:px-6">
        <h2 id="como-funciona" className="font-display text-2xl font-extrabold sm:text-3xl">
          Como funciona
        </h2>
        <p className="mt-1 text-muted-foreground">Do cadastro ao check-in, em cinco etapas.</p>
        <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map(({ icon: Icon, title, text }, i) => (
            <li key={title} className="relative flex flex-col rounded-2xl border border-border bg-card p-5 shadow-card">
              <div className="mb-4 flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-xl bg-night text-lime">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="font-display text-3xl font-extrabold text-border" aria-hidden>
                  {i + 1}
                </span>
              </div>
              <h3 className="font-bold">
                <span className="sr-only">Etapa {i + 1}: </span>
                {title}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Pagos e gratuitos */}
      <section aria-labelledby="tipos-de-evento" className="mx-auto mt-14 max-w-7xl px-4 sm:px-6">
        <h2 id="tipos-de-evento" className="font-display text-2xl font-extrabold sm:text-3xl">
          Eventos pagos e gratuitos
        </h2>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-6 shadow-card">
            <span className="mb-4 grid size-11 place-items-center rounded-xl bg-secondary/10 text-secondary">
              <CircleDollarSign className="size-6" aria-hidden />
            </span>
            <h3 className="text-lg font-extrabold">Ingressos pagos</h3>
            <ul className="mt-3 space-y-2 text-sm text-foreground/90">
              <li className="flex gap-2"><Check />Para vender, conecte a conta do Mercado Pago da organização em Configurações. O valor das vendas vai para essa conta.</li>
              <li className="flex gap-2"><Check />O público paga com PIX ou cartão (crédito à vista ou débito), pelo Mercado Pago.</li>
              <li className="flex gap-2"><Check />O ingresso só é emitido depois que o pagamento é confirmado.</li>
              <li className="flex gap-2"><Check />Há comissão da plataforma por ingresso vendido — veja os valores abaixo.</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-border bg-card p-6 shadow-card">
            <span className="mb-4 grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground">
              <Gift className="size-6" aria-hidden />
            </span>
            <h3 className="text-lg font-extrabold">Ingressos gratuitos</h3>
            <ul className="mt-3 space-y-2 text-sm text-foreground/90">
              <li className="flex gap-2"><Check />Crie o tipo de ingresso com preço R$ 0,00 e defina a quantidade disponível.</li>
              <li className="flex gap-2"><Check />Ingresso gratuito não paga comissão e não passa por pagamento, então não exige conta do Mercado Pago.</li>
              <li className="flex gap-2"><Check />O público reserva com a conta {BRAND.name} e recebe o ingresso com QR code, como num evento pago.</li>
              <li className="flex gap-2"><Check />Você usa os mesmos recursos: lista de participantes, check-in e regras de transferência.</li>
            </ul>
            <p className="mt-4 text-xs text-muted-foreground">
              Também vale para cortesias com cupom de 100%: o ingresso sai por R$ 0,00 e não gera comissão. As etapas de cadastro, aprovação e moderação são as mesmas.
            </p>
          </div>
        </div>
      </section>

      {/* Comissões e taxas (valores da regra vigente) */}
      <section id="taxas" aria-labelledby="taxas-titulo" className="mx-auto mt-14 max-w-7xl scroll-mt-20 px-4 sm:px-6">
        <h2 id="taxas-titulo" className="font-display text-2xl font-extrabold sm:text-3xl">
          Comissões e taxas
        </h2>
        <Suspense fallback={<Skeleton className="mt-6 h-72" />}>
          <Fees />
        </Suspense>
      </section>

      {/* Recursos */}
      <section aria-labelledby="recursos" className="mx-auto mt-14 max-w-7xl px-4 sm:px-6">
        <h2 id="recursos" className="font-display text-2xl font-extrabold sm:text-3xl">
          O que você tem no painel
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-2xl border border-border bg-card p-5 shadow-card">
              <Icon className="mb-3 size-6 text-secondary" aria-hidden />
              <h3 className="font-bold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Perguntas frequentes */}
      <section aria-labelledby="perguntas" className="mx-auto mt-14 max-w-3xl px-4 sm:px-6">
        <h2 id="perguntas" className="font-display text-2xl font-extrabold sm:text-3xl">
          Perguntas frequentes
        </h2>
        <div className="mt-6 divide-y divide-border rounded-2xl border border-border bg-card shadow-card">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg font-semibold [&::-webkit-details-marker]:hidden">
                {q}
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-lg leading-none transition-transform group-open:rotate-45 motion-reduce:transition-none" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-2 text-sm text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Chamada final */}
      <section className="mx-auto mt-14 max-w-7xl px-4 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl bg-night px-6 py-10 text-center text-white sm:py-12">
          <div className="bg-dots pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative">
            <h2 className="font-display text-2xl font-extrabold sm:text-3xl">
              Pronto para <span className="text-lime">publicar?</span>
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-white/80">Comece pelo cadastro da organização. Se você já organiza eventos aqui, o botão leva direto ao seu painel.</p>
            <Link href={START_PUBLISHING_HREF} className={buttonVariants({ variant: "accent", size: "lg", className: "mt-6" })}>
              Começar a publicar <ArrowRight aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function Check() {
  return <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-secondary" aria-hidden />;
}

const FAQ: [string, string][] = [
  ["Preciso ter CNPJ?", "Não. Dá para se cadastrar como pessoa física (CPF) — artistas, coletivos e produtores independentes — ou como empresa (CNPJ)."],
  [
    "Quanto tempo leva a aprovação?",
    "Depende da análise da equipe. Enquanto isso, o cadastro aparece como “em análise” no painel do organizador; se for recusado, o motivo é informado e você pode corrigir e enviar de novo.",
  ],
  ["Posso criar mais de um tipo de ingresso?", "Sim: inteira, meia-entrada, setores e lotes, cada um com preço, quantidade e período de venda. A meia-entrada segue a cota legal, controlada automaticamente."],
  [
    "Como recebo o dinheiro das vendas?",
    "Os pagamentos vão para a conta do Mercado Pago conectada pela organização, já com a comissão da plataforma descontada. A liberação do saldo segue as regras e prazos do Mercado Pago.",
  ],
  [
    "E se eu precisar cancelar o evento?",
    "O cancelamento é feito pelo painel. Quem comprou recebe o reembolso integral automaticamente, incluindo a taxa de serviço, quando houver.",
  ],
  [
    "Posso alterar o evento depois de publicado?",
    "Sim. Mudanças importantes, como data, horário ou local, são avisadas a quem comprou, que passa a ter um prazo para pedir reembolso integral.",
  ],
  ["Como funciona a entrada no dia?", "A equipe de portaria usa o check-in pelo celular: lê o QR code de cada ingresso e o sistema avisa se ele já foi usado, transferido ou cancelado."],
];

/** Valores da regra de comissão de plataforma vigente; exemplos calculados com a mesma função do checkout. */
async function Fees() {
  await connection();
  const rule = await currentPlatformCommissionRule(db);
  if (!rule) {
    return (
      <p className="mt-6 rounded-2xl border border-warning/40 bg-warning-soft p-5 text-sm text-warning">
        Os valores de comissão ainda não foram configurados. Fale com o atendimento antes de publicar um evento pago.
      </p>
    );
  }
  const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(rule.percentBps / 100);
  const fixed = rule.fixedCentsPerTicket;
  const buyerPays = rule.bearer === "BUYER";
  const example = 10_000;
  const commission = commissionPerUnit(example, rule);
  const half = 5_000;
  const halfCommission = commissionPerUnit(half, rule, true);
  const what = fixed > 0 ? `${percent}% + ${formatBRL(fixed)} por ingresso` : `${percent}% por ingresso`;
  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.1fr]">
      <div className="rounded-2xl border border-border bg-card p-6 shadow-card">
        <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Comissão padrão da plataforma</p>
        <p className="mt-1 font-display text-4xl font-extrabold">{what}</p>
        <ul className="mt-4 space-y-2 text-sm text-foreground/90">
          <li className="flex gap-2">
            <Check />
            Incide sobre o valor de cada ingresso pago, já com o desconto de cupom, se houver.
          </li>
          <li className="flex gap-2">
            <Check />
            {buyerPays
              ? "Quem paga é o comprador, como taxa de serviço. Ela aparece separada no preço do ingresso, no card do evento e no checkout, antes do pagamento."
              : "Quem paga é a organização: o comprador paga o valor do ingresso e a comissão é descontada do valor que você recebe."}
          </li>
          <li className="flex gap-2">
            <Check />
            Ingresso gratuito (R$ 0,00) não paga comissão.
          </li>
          <li className="flex gap-2">
            <Check />
            Na meia-entrada, a comissão é proporcional ao valor da meia.
          </li>
          <li className="flex gap-2">
            <Check />
            {rule.processingFeeBearer === "PLATFORM"
              ? "A tarifa do Mercado Pago pelo processamento do pagamento é absorvida pela plataforma."
              : "Além da comissão, o Mercado Pago cobra a própria tarifa pelo processamento do pagamento, conforme a tabela dele, descontada do valor recebido."}
          </li>
          <li className="flex gap-2">
            <Check />
            {rule.refundCommissionOnRefund ? "Em reembolso, a comissão daquele ingresso também é devolvida." : "Em reembolso, a comissão daquele ingresso não é devolvida."}
          </li>
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Este é o valor padrão. Condições diferentes podem ser combinadas com a {BRAND.name} para uma organização ou um evento; nesse caso, o valor aparece na criação do evento.
        </p>
      </div>
      <div className="rounded-2xl bg-night p-6 text-white shadow-card">
        <p className="text-sm font-semibold uppercase tracking-wide text-lime">Exemplos com a regra atual</p>
        <dl className="mt-4 space-y-4">
          <Example
            title={`Ingresso de ${formatBRL(example)}`}
            rows={
              buyerPays
                ? [
                    ["O comprador paga", formatBRL(example + commission)],
                    [`Taxa de serviço (${what})`, formatBRL(commission)],
                    ["Valor do ingresso para você", formatBRL(example)],
                  ]
                : [
                    ["O comprador paga", formatBRL(example)],
                    [`Comissão (${what})`, `− ${formatBRL(commission)}`],
                    ["Valor para você", formatBRL(example - commission)],
                  ]
            }
          />
          <Example
            title={`Meia-entrada de ${formatBRL(half)}`}
            rows={
              buyerPays
                ? [
                    ["O comprador paga", formatBRL(half + halfCommission)],
                    ["Taxa de serviço", formatBRL(halfCommission)],
                  ]
                : [
                    ["Comissão", `− ${formatBRL(halfCommission)}`],
                    ["Valor para você", formatBRL(half - halfCommission)],
                  ]
            }
          />
          <Example title="Ingresso gratuito" rows={[["Comissão", formatBRL(0)]]} />
        </dl>
        <p className="mt-5 text-xs text-white/70">
          {buyerPays ? "Valores antes da tarifa do Mercado Pago." : "“Valor para você” é antes da tarifa do Mercado Pago pelo processamento."} A comissão de cada pedido fica registrada no relatório de vendas.
        </p>
      </div>
    </div>
  );
}

function Example({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="rounded-xl bg-white/5 p-4 ring-1 ring-white/10">
      <dt className="font-bold">{title}</dt>
      <dd className="mt-2 space-y-1 text-sm">
        {rows.map(([label, value], i) => (
          <div key={label} className={`flex justify-between gap-4 ${i === rows.length - 1 ? "border-t border-white/15 pt-1 font-bold text-lime" : "text-white/80"}`}>
            <span>{label}</span>
            <span className="tabular-nums">{value}</span>
          </div>
        ))}
      </dd>
    </div>
  );
}
