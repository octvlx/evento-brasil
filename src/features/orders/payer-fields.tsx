"use client";

import { Input, Label, Select } from "@/components/ui/primitives";
import type { PaymentPayerDetails, PayerRequirements } from "@/server/payments/types";

export function PayerFields({ requirements, value, onChange, disabled }: {
  requirements: PayerRequirements;
  value: PaymentPayerDetails;
  onChange: (value: PaymentPayerDetails) => void;
  disabled: boolean;
}) {
  if (!requirements.document?.length && !requirements.billingAddress) return null;
  const address = value.billingAddress ?? { postalCode: "", street: "", number: "", district: "", city: "", state: "", country: "BR" as const };
  const document = value.document ?? { type: requirements.document?.[0] ?? "CPF", number: "" };
  return (
    <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-border p-4">
      <legend className="px-1 text-sm font-semibold">Dados para este pagamento</legend>
      <p className="text-xs text-muted-foreground">Solicitados pelo provedor para esta cobrança. Não alteram seu cadastro de comprador.</p>
      {!!requirements.document?.length && <div className="space-y-2">
        {requirements.document.length > 1 && <div>
          <Label htmlFor="payer-document-type">Tipo de documento</Label>
          <Select id="payer-document-type" value={document.type} onChange={(event) => onChange({ ...value, document: { ...document, type: event.target.value as "CPF" | "CNPJ" } })}>
            {requirements.document.map((type) => <option key={type} value={type}>{type}</option>)}
          </Select>
        </div>}
        <Label htmlFor="payer-document">{document.type} do pagador</Label>
        <Input id="payer-document" inputMode="numeric" maxLength={30} value={document.number} onChange={(event) => onChange({ ...value, document: { ...document, number: event.target.value } })} />
      </div>}
      {requirements.billingAddress && <div className="grid gap-3 sm:grid-cols-2">
        {([
          ["postalCode", "CEP", "postal-code"], ["street", "Logradouro", "address-line1"],
          ["number", "Número", "off"], ["district", "Bairro", "address-line2"],
          ["city", "Cidade", "address-level2"], ["state", "UF", "address-level1"],
        ] as const).map(([key, label, autoComplete]) => <div key={key}>
          <Label htmlFor={`payer-${key}`}>{label}</Label>
          <Input id={`payer-${key}`} autoComplete={autoComplete === "off" ? "off" : `billing ${autoComplete}`} maxLength={key === "state" ? 2 : 200} value={address[key]} onChange={(event) => onChange({ ...value, billingAddress: { ...address, [key]: key === "state" ? event.target.value.toUpperCase() : event.target.value } })} />
        </div>)}
      </div>}
    </fieldset>
  );
}
