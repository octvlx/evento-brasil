"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { UF_CODES } from "@/lib/br";
import { saveBuyerAddressAction, saveBuyerPersonalAction, lookupPostalAddressAction } from "./actions";
import { buyerAddressSchema, buyerPersonalSchema, type BuyerCheckoutProfile } from "./schemas";

export function BuyerPersonalForm({ profile, onSaved, onCancel }: { profile: BuyerCheckoutProfile; onSaved: () => void; onCancel?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return <form className="grid gap-4 sm:grid-cols-2" noValidate onSubmit={(event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const parsed = buyerPersonalSchema.safeParse({ name: data.get("name"), cpf: data.get("cpf") || undefined, birthDate: data.get("birthDate") });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Confira os dados.");
    start(async () => { setError(null); const result = await saveBuyerPersonalAction(parsed.data); if (result.ok) onSaved(); else setError(result.error); });
  }}>
    <div className="sm:col-span-2"><Label htmlFor="review-name">Nome completo</Label><Input id="review-name" name="name" autoComplete="name" defaultValue={profile.name} className="mt-1.5" disabled={pending} /></div>
    <div><Label htmlFor="review-email">E-mail confirmado</Label><Input id="review-email" value={profile.email} readOnly type="email" className="mt-1.5 bg-muted" /><p className="mt-1 text-xs text-muted-foreground">O e-mail identifica sua conta e não é alterado nesta etapa.</p></div>
    <div><Label htmlFor="review-birth">Data de nascimento</Label><Input id="review-birth" name="birthDate" type="date" autoComplete="bday" defaultValue={profile.birthDate ?? ""} className="mt-1.5" disabled={pending} /></div>
    <div className="sm:col-span-2">{profile.cpfMasked ? <><p className="text-sm font-medium">CPF: {profile.cpfMasked}</p><p className="mt-1 text-xs text-muted-foreground">Por segurança, o CPF cadastrado não pode ser alterado por este formulário.</p></> : <><Label htmlFor="review-cpf">CPF</Label><Input id="review-cpf" name="cpf" inputMode="numeric" autoComplete="off" maxLength={14} placeholder="000.000.000-00" className="mt-1.5" disabled={pending} /><p className="mt-1 text-xs text-muted-foreground">Confira antes de salvar. O CPF ficará protegido e será mostrado apenas de forma mascarada.</p></>}</div>
    {error && <Alert variant="danger" className="sm:col-span-2">{error}</Alert>}
    <div className="flex flex-wrap gap-3 sm:col-span-2"><Button disabled={pending}>{pending ? "Salvando…" : "Salvar dados e voltar à revisão"}</Button>{onCancel && <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancelar edição</Button>}</div>
  </form>;
}

export function BuyerAddressForm({ profile, onSaved, onCancel }: { profile: BuyerCheckoutProfile; onSaved: () => void; onCancel?: () => void }) {
  const [value, setValue] = useState({ postalCode: profile.address?.postalCode ?? "", street: profile.address?.street ?? "", number: profile.address?.number ?? "", complement: profile.address?.complement ?? "", district: profile.address?.district ?? "", city: profile.address?.city ?? "", state: profile.address?.state ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [pending, start] = useTransition();
  const revision = useRef(0);
  const lastLookup = useRef<string | null>(null);
  const change = (key: keyof typeof value, text: string) => { revision.current++; setLookingUp(false); setLookupMessage(null); setValue((current) => ({ ...current, [key]: text })); };
  async function lookup(force = false) {
    const digits = value.postalCode.replace(/\D/g, "");
    if (!/^\d{8}$/.test(digits) || (!force && lastLookup.current === digits)) return;
    const requestedRevision = ++revision.current; lastLookup.current = digits; setLookingUp(true); setLookupMessage(null);
    const result = await lookupPostalAddressAction(digits);
    if (revision.current !== requestedRevision) return;
    setLookingUp(false);
    if (!result.ok) { setLookupMessage(result.error + " Você pode preencher o endereço manualmente."); return; }
    setValue((current) => ({ ...current, postalCode: result.data.postalCode, street: result.data.street, district: result.data.district, city: result.data.city, state: result.data.state }));
    setLookupMessage("Endereço localizado. Confira os dados e informe o número e o complemento, se houver.");
  }
  return <form className="grid gap-4 sm:grid-cols-2" noValidate onSubmit={(event) => {
    event.preventDefault(); const parsed = buyerAddressSchema.safeParse(value);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Confira o endereço.");
    start(async () => { revision.current++; setLookingUp(false); setError(null); const result = await saveBuyerAddressAction(parsed.data); if (result.ok) onSaved(); else setError(result.error); });
  }}>
    <div className="sm:col-span-2"><Label htmlFor="review-postalCode">CEP</Label><div className="mt-1.5 flex gap-2"><Input id="review-postalCode" value={value.postalCode} onChange={(event) => change("postalCode", event.target.value)} onBlur={() => void lookup()} inputMode="numeric" autoComplete="postal-code" maxLength={9} placeholder="00000-000" disabled={pending} /><Button type="button" variant="outline" onClick={() => void lookup(true)} disabled={pending || lookingUp}>{lookingUp ? "Buscando…" : "Buscar CEP"}</Button></div></div>
    {lookupMessage && <p role="status" className="text-sm text-muted-foreground sm:col-span-2">{lookupMessage}</p>}
    {([ ["street", "Rua", "address-line1"], ["number", "Número", "off"], ["complement", "Complemento (opcional)", "address-line2"], ["district", "Bairro", "address-level3"], ["city", "Cidade", "address-level2"] ] as const).map(([key, label, autoComplete]) => <div key={key} className={key === "street" ? "sm:col-span-2" : ""}><Label htmlFor={`review-${key}`}>{label}</Label><Input id={`review-${key}`} value={value[key]} onChange={(event) => change(key, event.target.value)} autoComplete={autoComplete} className="mt-1.5" disabled={pending} /></div>)}
    <div><Label htmlFor="review-state">Estado</Label><Select id="review-state" value={value.state} onChange={(event) => change("state", event.target.value)} autoComplete="address-level1" className="mt-1.5" disabled={pending}><option value="">Selecione o estado</option>{UF_CODES.map((state) => <option key={state} value={state}>{state}</option>)}</Select></div>
    <p className="text-xs text-muted-foreground sm:col-span-2">O endereço ficará salvo na sua conta para as próximas compras. Você pode revisá-lo e editá-lo antes de pagar.</p>
    {error && <Alert variant="danger" className="sm:col-span-2">{error}</Alert>}
    <div className="flex flex-wrap gap-3 sm:col-span-2"><Button disabled={pending || lookingUp}>{pending ? "Salvando…" : "Salvar endereço e voltar à revisão"}</Button>{onCancel && <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancelar edição</Button>}</div>
  </form>;
}
