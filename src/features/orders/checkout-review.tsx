"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { ArrowLeft, CheckCircle2, Pencil } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Card, Input, Label } from "@/components/ui/primitives";
import { TermsReaccept } from "@/features/auth/terms-reaccept";
import { BuyerAddressForm, BuyerPersonalForm } from "@/features/buyer/forms";
import type { BuyerCheckoutProfile } from "@/features/buyer/schemas";
import { formatBRL } from "@/lib/money";
import { syncAcceptedCartSelection } from "./persistent-cart";
import type { CheckoutReviewData } from "./review-types";
import { prepareCheckoutReviewAction, updateCheckoutDraftAction, confirmCheckoutReviewAction } from "./review-actions";

function Section({ title, children, edit, editLabel }: { title: string; children: ReactNode; edit?: () => void; editLabel?: string }) {
  return <Card className="p-5 sm:p-6"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-xl font-bold">{title}</h2>{edit && <Button type="button" variant="ghost" size="sm" onClick={edit}><Pencil className="size-4" aria-hidden />{editLabel}</Button>}</div>{children}</Card>;
}

export function CheckoutReview({ data, profile }: { data: CheckoutReviewData; profile: BuyerCheckoutProfile }) {
  const router = useRouter(); const [editing, setEditing] = useState<"personal" | "address" | "tickets" | null>(null);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [termsRequired, setTermsRequired] = useState(false); const [acceptTerms, setAcceptTerms] = useState(false); const [pending, start] = useTransition();
  const ready = data.readiness.email && data.readiness.profile && data.readiness.address;
  const finishEditing = () => { setEditing(null); setError(null); setNotice("Dados salvos. Confira novamente a revisão antes de confirmar."); router.refresh(); };
  const cancelEditing = () => setEditing(null);
  const prepare = () => start(async () => { setError(null); setNotice(null); const result = await prepareCheckoutReviewAction(data.draftId); if (result.ok) { setNotice("Valores e disponibilidade conferidos. Revise o resumo e confirme para continuar."); router.refresh(); } else setError(result.error); });
  const confirm = () => start(async () => {
    setError(null); setNotice(null); if (!data.reviewHash) return;
    const result = await confirmCheckoutReviewAction(data.draftId, data.reviewHash, termsRequired ? acceptTerms : undefined);
    if (!result.ok) { setError(result.error); if (result.code === "TERMS_REQUIRED") setTermsRequired(true); router.refresh(); return; }
    if (result.data.changed) { setNotice("Os dados, valores ou a disponibilidade foram atualizados. Confira o novo resumo e confirme novamente."); router.refresh(); return; }
    router.push(result.data.paid ? `/pedido/${result.data.orderId}` : `/checkout/${result.data.orderId}`);
  });
  const selected = data.selection.items.map((item) => ({ ...item, ticket: data.tickets.find((ticket) => ticket.id === item.ticketTypeId) }));
  const personalEditing = profile.emailVerified && (editing === "personal" || !profile.personalComplete);
  const addressEditing = profile.emailVerified && profile.personalComplete && (editing === "address" || !profile.address);
  return <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
    <div className="space-y-5">
      {!profile.emailVerified && <Alert variant="warning"><p className="font-semibold">Confirme seu e-mail para continuar</p><p className="mt-1 text-sm">Sua seleção de ingressos está salva. Depois de confirmar o e-mail, volte para completar os dados da compra.</p><Link className="mt-3 inline-block font-semibold text-secondary underline" href={`/confirmar-email?next=${encodeURIComponent(`/checkout/revisao/${data.draftId}`)}`}>Confirmar e-mail</Link></Alert>}
      <Section title="Dados do comprador" edit={profile.emailVerified && profile.personalComplete && !personalEditing ? () => setEditing("personal") : undefined} editLabel="Editar dados">
        {personalEditing ? <BuyerPersonalForm profile={profile} onSaved={finishEditing} onCancel={profile.personalComplete ? cancelEditing : undefined} /> : <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Nome completo</dt><dd className="font-medium">{profile.name}</dd></div><div><dt className="text-muted-foreground">E-mail</dt><dd className="break-all font-medium">{profile.email}</dd></div><div><dt className="text-muted-foreground">CPF</dt><dd className="font-medium">{profile.cpfMasked ?? "A completar"}</dd></div><div><dt className="text-muted-foreground">Data de nascimento</dt><dd className="font-medium">{profile.birthDate ? profile.birthDate.split("-").reverse().join("/") : "A completar"}</dd></div></dl>}
      </Section>
      <Section title="Endereço" edit={profile.address && !addressEditing ? () => setEditing("address") : undefined} editLabel="Editar endereço">
        {addressEditing ? <BuyerAddressForm profile={profile} onSaved={finishEditing} onCancel={profile.address ? cancelEditing : undefined} /> : profile.address ? <address className="space-y-1 text-sm not-italic"><p className="font-medium">{profile.address.street}, {profile.address.number}</p>{profile.address.complement && <p>{profile.address.complement}</p>}<p>{profile.address.district} — {profile.address.city}/{profile.address.state}</p><p>CEP: {profile.address.postalCode.replace(/^(\d{5})(\d{3})$/, "$1-$2")}</p><p className="pt-2 text-xs text-muted-foreground">Endereço salvo para suas próximas compras.</p></address> : <p className="text-sm text-muted-foreground">{profile.personalComplete ? "Cadastre seu endereço para esta primeira compra." : "Complete seus dados pessoais para cadastrar o endereço da primeira compra."}</p>}
      </Section>
      <Section title="Seus ingressos" edit={editing !== "tickets" ? () => setEditing("tickets") : undefined} editLabel="Alterar ingressos">
        <h3 className="font-semibold">{data.event.title}</h3><p className="mt-1 text-sm text-muted-foreground">{data.event.dateLabel}</p><p className="text-sm text-muted-foreground">{data.event.venueLabel}{data.event.locationLabel ? ` · ${data.event.locationLabel}` : ""}</p>
        {editing === "tickets" ? <TicketEdit data={data} onSaved={finishEditing} onCancel={cancelEditing} /> : data.order ? <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Ingressos selecionados e preços conferidos</caption><thead><tr className="border-b border-border text-muted-foreground"><th className="py-2 pr-3">Ingresso</th><th className="py-2 px-2">Qtd.</th><th className="py-2 px-2">Unitário</th><th className="py-2 pl-2 text-right">Subtotal</th></tr></thead><tbody>{data.order.items.map((item) => <tr key={item.id} className="border-b border-border last:border-0"><td className="py-3 pr-3 font-medium">{item.ticketTypeName}</td><td className="px-2">{item.quantity}</td><td className="px-2 whitespace-nowrap">{formatBRL(item.listUnitPriceCents)}</td><td className="pl-2 text-right whitespace-nowrap">{formatBRL(item.lineSubtotalCents)}</td></tr>)}</tbody></table></div> : <ul className="mt-4 space-y-2 text-sm">{selected.map((item) => <li key={item.ticketTypeId}>{item.quantity}× {item.ticket?.name ?? "Ingresso indisponível"}</li>)}</ul>}
        {data.selection.couponCode && <p className="mt-3 text-sm text-secondary">Cupom selecionado: <span className="font-mono font-semibold">{data.selection.couponCode}</span></p>}
      </Section>
      {data.halfPriceNotice && <Alert variant="warning" role="status"><p className="font-semibold">Sua seleção não está mais disponível</p><p className="mt-1 text-sm">{data.halfPriceNotice} Use &ldquo;Alterar ingressos&rdquo; para ajustar a seleção.</p></Alert>}
      <Link className="inline-flex items-center gap-2 text-sm font-semibold text-secondary hover:underline" href={`/eventos/${data.event.slug}`}><ArrowLeft className="size-4" aria-hidden />Voltar ao evento</Link>
    </div>
    <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
      <Section title="Resumo do pagamento">
        {data.order ? <dl className="space-y-3 text-sm"><div className="flex justify-between gap-3"><dt>Subtotal dos ingressos</dt><dd className="tabular-nums">{formatBRL(data.order.grossSubtotalCents)}</dd></div><div className="flex justify-between gap-3"><dt>Taxa de serviço</dt><dd className="tabular-nums">{formatBRL(data.order.serviceFeeCents)}</dd></div><div className="flex justify-between gap-3"><dt>Descontos aplicados</dt><dd className="tabular-nums">−{formatBRL(data.order.discountCents)}</dd></div><div className="flex justify-between gap-3 border-t border-border pt-3 text-lg font-bold"><dt>Total</dt><dd className="tabular-nums" data-testid="review-total">{formatBRL(data.order.totalCents)}</dd></div></dl> : <p className="text-sm text-muted-foreground">Complete seus dados e confira os valores e a disponibilidade para ver o total da compra.</p>}
        {data.order && <p className="mt-4 text-xs text-warning">Reserva com prazo limitado, até {data.order.expiresLabel} no fuso do evento. Os valores e ingressos serão conferidos novamente ao confirmar.</p>}
        {notice && <Alert className="mt-4">{notice}</Alert>}{error && <Alert variant="danger" className="mt-4">{error}</Alert>}
        {termsRequired && <div className="mt-4"><TermsReaccept checked={acceptTerms} onChange={setAcceptTerms} /></div>}
        <div className="mt-5 space-y-3">
          {!data.order || !data.reviewHash ? <Button className="w-full" size="lg" onClick={prepare} disabled={pending || !ready || editing !== null}>{pending ? "Conferindo…" : "Revisar valores e ingressos"}</Button> : <><Button className="w-full" size="lg" variant="accent" onClick={confirm} disabled={pending || !ready || editing !== null || (termsRequired && !acceptTerms)}>{pending ? "Confirmando…" : "Confirmar e ir para pagamento"}</Button><Button className="w-full" variant="outline" onClick={prepare} disabled={pending || !ready || editing !== null}>Atualizar valores e reserva</Button></>}
          <Link href={`/eventos/${data.event.slug}`} className={buttonVariants({ variant: "ghost", className: "w-full" })}>Voltar</Link>
        </div><p className="mt-4 flex gap-2 text-xs text-muted-foreground"><CheckCircle2 className="size-4 shrink-0" aria-hidden />Nenhuma cobrança é iniciada nesta tela. Os ingressos pagos são emitidos somente após a confirmação segura do pagamento.</p>
      </Section>
    </div>
  </div>;
}

function TicketEdit({ data, onSaved, onCancel }: { data: CheckoutReviewData; onSaved: () => void; onCancel: () => void }) {
  const [quantities, setQuantities] = useState<Record<string, number>>(() => Object.fromEntries(data.selection.items.map((item) => [item.ticketTypeId, item.quantity])));
  const [coupon, setCoupon] = useState(data.selection.couponCode ?? ""); const [halfPrice, setHalfPrice] = useState(data.selection.halfPriceDeclaration ?? false);
  const [attendees, setAttendees] = useState<Record<string, string[]>>(() => Object.fromEntries(data.selection.items.map((item) => [item.ticketTypeId, item.attendees?.map((person) => person.name) ?? []])));
  const [error, setError] = useState<string | null>(null); const [pending, start] = useTransition();
  return <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); start(async () => {
    setError(null); const items = data.tickets.filter((ticket) => (quantities[ticket.id] ?? 0) > 0).map((ticket) => ({ ticketTypeId: ticket.id, quantity: quantities[ticket.id], attendees: ticket.requiresAttendeeInfo ? Array.from({ length: quantities[ticket.id] }, (_, index) => ({ name: attendees[ticket.id]?.[index] ?? "" })) : undefined }));
    const selection = { ...data.selection, items, couponCode: coupon.trim() || undefined, halfPriceDeclaration: halfPrice };
    const result = await updateCheckoutDraftAction(data.draftId, selection);
    if (result.ok) { syncAcceptedCartSelection(selection); onSaved(); } else setError(result.error);
  }); }}>
    {data.tickets.map((ticket) => <div key={ticket.id} className="space-y-2 rounded-xl border border-border p-3"><div className="flex items-center justify-between gap-4"><Label htmlFor={`review-ticket-${ticket.id}`}>{ticket.name}</Label><Input className="w-24" id={`review-ticket-${ticket.id}`} type="number" min={0} max={Math.min(ticket.maxPerOrder, ticket.available)} value={quantities[ticket.id] ?? 0} onChange={(event) => setQuantities((current) => ({ ...current, [ticket.id]: Math.max(0, Math.min(50, Number(event.target.value) || 0)) }))} disabled={pending} /></div>{ticket.requiresAttendeeInfo && Array.from({ length: quantities[ticket.id] ?? 0 }, (_, index) => <Input key={index} aria-label={`Nome do participante ${index + 1} (${ticket.name})`} value={attendees[ticket.id]?.[index] ?? ""} maxLength={120} placeholder={`Nome do participante ${index + 1}`} disabled={pending} onChange={(event) => setAttendees((current) => { const names = [...(current[ticket.id] ?? [])]; names[index] = event.target.value; return { ...current, [ticket.id]: names }; })} />)}</div>)}
    <div><Label htmlFor="review-coupon">Cupom de desconto</Label><Input id="review-coupon" className="mt-1.5 uppercase" maxLength={32} value={coupon} disabled={pending} onChange={(event) => setCoupon(event.target.value.toUpperCase())} /></div>
    {data.tickets.some((ticket) => ticket.kind === "HALF_PRICE" && (quantities[ticket.id] ?? 0) > 0) && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={halfPrice} onChange={(event) => setHalfPrice(event.target.checked)} disabled={pending} /><span>Declaro ter direito à meia-entrada e apresentarei documento comprobatório na entrada.</span></label>}
    {error && <Alert variant="danger">{error}</Alert>}<div className="flex flex-wrap gap-3"><Button disabled={pending}>{pending ? "Salvando…" : "Salvar ingressos e voltar à revisão"}</Button><Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancelar edição</Button></div><p className="text-xs text-muted-foreground">Alterar ingressos libera a reserva anterior. Os novos valores, descontos e disponibilidade serão conferidos novamente antes da confirmação.</p>
  </form>;
}
