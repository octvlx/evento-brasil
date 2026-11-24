"use client";

import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import type { ActionResult } from "@/server/errors";
import { deleteCommissionRuleAction, saveCommissionRuleAction, updateCommissionRuleAction } from "./actions";
import { commissionPreview } from "./commission-preview";
import { formatBRL, parseBRLToCents } from "@/lib/money";
import type { FeeBearer } from "@/features/fees/policy";
import { ORGANIZER_REVIEW_AREA, ORGANIZER_REVIEW_AREA_HINT, ORGANIZER_REVIEW_AREAS, type OrganizerReviewArea } from "@/lib/labels";

/** Papéis de um admin (T6): só aparece para super admin, nunca na própria conta. */
export function AdminRolesEditor({
  current,
  roles,
  action,
}: {
  current: string[];
  roles: { value: string; name: string; description: string }[];
  action: (roles: string[]) => Promise<ActionResult>;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(current);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Papéis
      </Button>
    );
  return (
    <form
      className="flex max-w-xs flex-col gap-2 rounded-xl border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await action(selected);
          if (!r.ok) setError(r.error);
          else {
            setOpen(false);
            setError(null);
          }
        });
      }}
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-semibold">Papéis de administrador</legend>
        {roles.map((r) => (
          <label key={r.value} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={selected.includes(r.value)}
              onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.value] : s.filter((x) => x !== r.value)))}
            />
            <span>
              <strong>{r.name}</strong> — {r.description}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex gap-1">
        <Button size="sm" disabled={pending || selected.length === 0}>
          {pending ? "…" : "Salvar papéis"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Voltar
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

/**
 * Redefinir o 2FA de outra pessoa (suporte): pede o motivo e o código do
 * aplicativo do próprio admin. O servidor revalida tudo.
 */
export function ResetTwoFactorButton({ action }: { action: (adminCode: string, reason: string) => Promise<ActionResult> }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Redefinir 2FA
      </Button>
    );
  return (
    <form
      className="flex max-w-xs flex-col gap-1.5 rounded-xl border border-border p-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await action(code, reason);
          if (!r.ok) setError(r.error);
          else {
            setOpen(false);
            setError(null);
          }
        });
      }}
    >
      <p className="text-xs">A pessoa perde o 2FA e as sessões abertas, recebe um e-mail e ativa de novo no próximo acesso.</p>
      <Input placeholder="Motivo (ex.: perdeu o celular; identidade confirmada)" value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 text-xs" aria-label="Motivo da redefinição" />
      <Input
        placeholder="Seu código de 6 dígitos"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, "").slice(0, 7))}
        inputMode="numeric"
        autoComplete="one-time-code"
        className="h-9 font-mono text-xs"
        aria-label="Seu código do aplicativo autenticador"
      />
      <div className="flex gap-1">
        <Button size="sm" variant="destructive" disabled={pending || reason.trim().length < 5 || code.replace(/\s/g, "").length !== 6}>
          {pending ? "…" : "Redefinir"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Voltar
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

/**
 * Exclusão definitiva (superadmin). A confirmação identifica a conta, explica as consequências
 * e exige o e-mail digitado, o motivo e o código do autenticador do superadmin.
 */
export function DeleteAccountButton({
  account,
  action,
}: {
  account: { name: string; email: string; orders: number; organizations: string[] };
  action: (confirmEmail: string, reason: string, adminCode: string) => Promise<ActionResult>;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
        Excluir conta definitivamente
      </Button>
    );
  const emailMatches = email.trim().toLowerCase() === account.email.toLowerCase();
  return (
    <form
      role="group"
      aria-label={`Excluir definitivamente a conta de ${account.name}`}
      className="flex w-full max-w-md flex-col gap-1.5 rounded-xl border border-destructive/60 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await action(email, reason, code);
          if (!r.ok) setError(r.error);
          else {
            setOpen(false);
            setError(null);
          }
        });
      }}
    >
      <p className="text-sm font-semibold">
        Excluir definitivamente a conta de {account.name} ({account.email})?
      </p>
      <ul className="list-disc space-y-0.5 pl-4 text-xs">
        <li>Não dá para desfazer. A pessoa perde o acesso na hora: sessões encerradas e nenhum login novo, nem com o Google.</li>
        <li>Nome, e-mail, celular, CPF, data de nascimento, endereço e 2FA são apagados ou trocados por um marcador.</li>
        <li>
          Pedidos ({account.orders}), pagamentos, reembolsos e a auditoria ficam, anonimizados, pelo prazo de guarda legal.
        </li>
        {account.organizations.length > 0 && (
          <li>
            Sai das organizações: {account.organizations.join(", ")}. Organização que ficar sem nenhum membro é suspensa; os eventos e pedidos dela ficam.
          </li>
        )}
        <li>Havendo impedimento (ingressos válidos, pedidos ou reembolsos em aberto, eventos ativos…), nada é alterado e o motivo aparece aqui.</li>
      </ul>
      <Input
        placeholder={`Digite ${account.email} para confirmar`}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="off"
        className="h-9 text-xs"
        aria-label="E-mail da conta, para confirmar"
      />
      <Input placeholder="Motivo (sem dados pessoais; ex.: pedido do titular pelo SAC)" value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 text-xs" aria-label="Motivo da exclusão" />
      <Input
        placeholder="Seu código de 6 dígitos"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, "").slice(0, 7))}
        inputMode="numeric"
        autoComplete="one-time-code"
        className="h-9 font-mono text-xs"
        aria-label="Seu código do aplicativo autenticador"
      />
      <div className="flex gap-1">
        <Button size="sm" variant="destructive" disabled={pending || !emailMatches || reason.trim().length < 5 || code.replace(/\s/g, "").length !== 6}>
          {pending ? "…" : "Excluir definitivamente"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Voltar
        </Button>
      </div>
      {error && (
        <p role="alert" className="whitespace-pre-line text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** Botão de ação administrativa com motivo opcional/obrigatório e confirmação. */
export function AdminActionButton({
  label,
  action,
  variant = "outline",
  askReason,
  reasonRequired,
  confirm,
}: {
  label: string;
  action: (reason?: string) => Promise<ActionResult>;
  variant?: "outline" | "secondary" | "destructive" | "ghost" | "default";
  askReason?: string;
  reasonRequired?: boolean;
  confirm?: string;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const exec = () =>
    start(async () => {
      const r = await action(reason || undefined);
      if (!r.ok) setError(r.error);
      else {
        setOpen(false);
        setError(null);
      }
    });
  if (open && (askReason || confirm)) {
    return (
      <div className="flex flex-col gap-1.5 rounded-xl border border-border p-2">
        {confirm && <p className="text-xs">{confirm}</p>}
        {askReason && <Input placeholder={askReason} value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 text-xs" aria-label={askReason} />}
        <div className="flex gap-1">
          <Button size="sm" variant={variant} disabled={pending || (reasonRequired && reason.trim().length < 3)} onClick={exec}>
            {pending ? "…" : "Confirmar"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Voltar
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }
  return (
    <span className="inline-flex flex-col">
      <Button size="sm" variant={variant} disabled={pending} onClick={() => (askReason || confirm ? setOpen(true) : exec())}>
        {pending ? "…" : label}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

export function CommissionRuleForm({
  orgs,
  events,
  commissionRetentionAvailable,
}: {
  orgs: { id: string; name: string }[];
  events: { id: string; title: string }[];
  /** Só o provedor simulado consegue reter a comissão num reembolso (ver `commissionReturnedOnRefund`). */
  commissionRetentionAvailable: boolean;
}) {
  const [state, action, pending] = useActionState(saveCommissionRuleAction, undefined);
  const [scope, setScope] = useState("PLATFORM");
  const [percent, setPercent] = useState("7");
  const [fixed, setFixed] = useState("0");
  const [bearer, setBearer] = useState<FeeBearer>("ORGANIZER");
  const [examplePrice, setExamplePrice] = useState("100,00");
  const preview = commissionPreview({
    percent: Number(percent.replace(",", ".")),
    fixedCents: Number(fixed),
    bearer,
    priceCents: parseBRLToCents(examplePrice) ?? 0,
  });
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-3">
      <div>
        <Label htmlFor="scope">Escopo</Label>
        <Select id="scope" name="scope" value={scope} onChange={(e) => setScope(e.target.value)} className="mt-1.5">
          <option value="PLATFORM">Plataforma (padrão)</option>
          <option value="ORGANIZATION">Organização</option>
          <option value="EVENT">Evento</option>
        </Select>
      </div>
      {scope === "ORGANIZATION" && (
        <div className="sm:col-span-2">
          <Label htmlFor="organizationId">Organização</Label>
          <Select id="organizationId" name="organizationId" className="mt-1.5">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {scope === "EVENT" && (
        <div className="sm:col-span-2">
          <Label htmlFor="eventId">Evento</Label>
          <Select id="eventId" name="eventId" className="mt-1.5">
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <Label htmlFor="percent">Comissão (%)</Label>
        <Input id="percent" name="percent" type="number" step="0.01" min={0} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="fixedCentsPerTicket">Valor fixo por ingresso (centavos)</Label>
        <Input id="fixedCentsPerTicket" name="fixedCentsPerTicket" type="number" min={0} value={fixed} onChange={(e) => setFixed(e.target.value)} className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="bearer">Quem paga a comissão</Label>
        <Select id="bearer" name="bearer" value={bearer} onChange={(e) => setBearer(e.target.value as FeeBearer)} className="mt-1.5">
          <option value="ORGANIZER">Organizador (descontada do repasse)</option>
          <option value="BUYER">Comprador (taxa de serviço destacada)</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="processingFeeBearer">Custo de processamento</Label>
        <Select id="processingFeeBearer" name="processingFeeBearer" className="mt-1.5">
          <option value="ORGANIZER">Organizador</option>
          <option value="PLATFORM">Plataforma</option>
        </Select>
      </div>
      {/* Campo desabilitado não vai no formulário: o servidor grava "devolver" nesse caso. */}
      <div className="text-sm sm:col-span-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="refundCommissionOnRefund"
            defaultChecked
            disabled={!commissionRetentionAvailable}
            aria-describedby={commissionRetentionAvailable ? undefined : "refund-commission-note"}
          />{" "}
          Devolver a comissão em reembolsos
        </label>
        {!commissionRetentionAvailable && (
          <p id="refund-commission-note" className="mt-1 text-xs text-muted-foreground">
            Com o Mercado Pago, o estorno sempre devolve a comissão da conta da plataforma, proporcionalmente. Por isso a comissão não pode ser retida.
          </p>
        )}
      </div>
      <div className="text-sm sm:col-span-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="fixedFeeNonRefundable" aria-describedby="fixed-fee-note" /> Valor fixo por ingresso não reembolsável
        </label>
        <p id="fixed-fee-note" className="mt-1 text-xs text-muted-foreground">
          {`Em reembolso pedido pelo comprador depois de ${ARREPENDIMENTO_DAYS_LABEL} da compra, o valor fixo não é devolvido. Arrependimento (até ${ARREPENDIMENTO_DAYS_LABEL}), alteração ou cancelamento do evento devolvem tudo.`}
          {!commissionRetentionAvailable &&
            " Com o Mercado Pago, o estorno devolve a comissão proporcionalmente; a parte do valor fixo que fica com o organizador vira saldo devedor dele e é descontada das próximas vendas."}
        </p>
      </div>
      <section aria-labelledby="commission-preview-title" className="rounded-2xl border border-border bg-muted/40 p-4 sm:col-span-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h3 id="commission-preview-title" className="text-sm font-bold">
            Prévia por ingresso
          </h3>
          <div className="w-40">
            <Label htmlFor="example-price">Preço de exemplo (R$)</Label>
            <Input id="example-price" inputMode="decimal" value={examplePrice} onChange={(e) => setExamplePrice(e.target.value)} className="mt-1.5" />
          </div>
        </div>
        {preview ? (
          <table className="mt-3 w-full text-sm" data-testid="commission-preview">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-1">Ingresso</th>
                <th className="py-1 text-right">Preço</th>
                <th className="py-1 text-right">Comissão</th>
                <th className="py-1 text-right">Comprador paga</th>
                <th className="py-1 text-right">Organizador recebe</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.label} className="border-t border-border">
                  <td className="py-1.5">{r.label}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatBRL(r.priceCents)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatBRL(r.commissionCents)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatBRL(r.buyerPaysCents)}</td>
                  <td className={`py-1.5 text-right tabular-nums ${r.negativePayout ? "font-bold text-destructive" : ""}`}>{formatBRL(r.organizerGetsCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">Informe percentual, valor fixo e um preço de exemplo válidos para ver a prévia.</p>
        )}
        {preview?.some((r) => r.negativePayout) && (
          <p className="mt-2 text-sm text-destructive">Com estes valores a comissão passa do preço: ingressos assim não poderão ser vendidos com o organizador pagando a comissão.</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Mesma conta usada nos pedidos. Não inclui o custo de processamento do meio de pagamento. Pedidos já feitos mantêm a regra da época.
        </p>
      </section>
      {state && !state.ok && <Alert variant="danger" className="sm:col-span-3">{state.error}</Alert>}
      {state?.ok && <Alert variant="success" className="sm:col-span-3">Nova versão da regra criada. Pedidos anteriores mantêm a versão original.</Alert>}
      <div className="sm:col-span-3">
        <Button disabled={pending}>{pending ? "Salvando…" : "Criar nova versão da regra"}</Button>
      </div>
    </form>
  );
}

const ARREPENDIMENTO_DAYS_LABEL = "7 dias";

export interface EditableRule {
  id: string;
  policyVersion: string;
  percentBps: number;
  fixedCentsPerTicket: number;
  bearer: FeeBearer;
  processingFeeBearer: "ORGANIZER" | "PLATFORM";
  refundCommissionOnRefund: boolean;
  fixedFeeRefundable: boolean;
}

/**
 * Editar ou excluir uma versão de regra sem pedidos. O servidor confere de novo (com a
 * versão travada) e recusa se algum pedido já a usou.
 */
export function CommissionRuleRowActions({
  rule,
  commissionRetentionAvailable,
}: {
  rule: EditableRule;
  commissionRetentionAvailable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();

  if (editing)
    return (
      <EditCommissionRuleForm
        rule={rule}
        commissionRetentionAvailable={commissionRetentionAvailable}
        onClose={() => setEditing(false)}
      />
    );
  if (confirmDelete) {
    return (
      <div className="flex min-w-[16rem] flex-col gap-1.5 rounded-xl border border-border p-2 text-left text-xs">
        <p>
          Excluir {rule.policyVersion}? Se for a vigente, a versão anterior
          volta a valer.
        </p>
        {deleteError && <p className="text-destructive">{deleteError}</p>}
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="destructive"
            disabled={deleting}
            onClick={() =>
              startDelete(async () => {
                const r = await deleteCommissionRuleAction(rule.id);
                if (!r.ok) setDeleteError(r.error);
              })
            }
          >
            {deleting ? "…" : "Excluir"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmDelete(false)}
          >
            Voltar
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-1">
      <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
        Editar
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
        Excluir
      </Button>
    </div>
  );
}

/** Formulário de edição; fecha sozinho quando o servidor confirma. */
function EditCommissionRuleForm({
  rule,
  commissionRetentionAvailable,
  onClose,
}: {
  rule: EditableRule;
  commissionRetentionAvailable: boolean;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState(
    updateCommissionRuleAction.bind(null, rule.id),
    undefined,
  );
  useEffect(() => {
    if (state?.ok) onClose();
  }, [state, onClose]);
  return (
    <form
      action={action}
      className="grid min-w-[22rem] gap-2 rounded-xl border border-border bg-card p-3 text-left"
      aria-label={`Editar ${rule.policyVersion}`}
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor={`percent-${rule.id}`}>Comissão (%)</Label>
          <Input
            id={`percent-${rule.id}`}
            name="percent"
            type="number"
            step="0.01"
            min={0}
            max={100}
            defaultValue={(rule.percentBps / 100).toFixed(2)}
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label htmlFor={`fixed-${rule.id}`}>Fixo (centavos)</Label>
          <Input
            id={`fixed-${rule.id}`}
            name="fixedCentsPerTicket"
            type="number"
            min={0}
            defaultValue={rule.fixedCentsPerTicket}
            className="mt-1 h-9"
          />
        </div>
        <div>
          <Label htmlFor={`bearer-${rule.id}`}>Quem paga</Label>
          <Select
            id={`bearer-${rule.id}`}
            name="bearer"
            defaultValue={rule.bearer}
            className="mt-1 h-9"
          >
            <option value="ORGANIZER">Organizador</option>
            <option value="BUYER">Comprador</option>
          </Select>
        </div>
        <div>
          <Label htmlFor={`proc-${rule.id}`}>Processamento</Label>
          <Select
            id={`proc-${rule.id}`}
            name="processingFeeBearer"
            defaultValue={rule.processingFeeBearer}
            className="mt-1 h-9"
          >
            <option value="ORGANIZER">Organizador</option>
            <option value="PLATFORM">Plataforma</option>
          </Select>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          name="refundCommissionOnRefund"
          defaultChecked={rule.refundCommissionOnRefund}
          disabled={!commissionRetentionAvailable}
        />{" "}
        Devolver a comissão em reembolsos
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          name="fixedFeeNonRefundable"
          defaultChecked={!rule.fixedFeeRefundable}
        />{" "}
        Valor fixo por ingresso não reembolsável
      </label>
      {state && !state.ok && <Alert variant="danger">{state.error}</Alert>}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending}>
          {pending ? "Salvando…" : "Salvar"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/** Recusa de cadastro de organizador: área a corrigir + motivo (os dois vão ao organizador). */
export function RejectOrganizationButton({ action }: { action: (reason: string, area: OrganizerReviewArea) => Promise<ActionResult> }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [area, setArea] = useState<OrganizerReviewArea | "">("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Rejeitar
      </Button>
    );
  const ready = !!area && reason.trim().length >= 3;
  return (
    <form
      className="flex w-full max-w-sm flex-col gap-1.5 rounded-xl border border-border p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !area) return;
        start(async () => {
          const r = await action(reason.trim(), area);
          if (!r.ok) setError(r.error);
          else {
            setOpen(false);
            setError(null);
          }
        });
      }}
    >
      <Label htmlFor={`${id}-area`} className="text-xs">
        O que precisa de ajuste?
      </Label>
      <Select id={`${id}-area`} value={area} onChange={(e) => setArea(e.target.value as OrganizerReviewArea | "")} className="h-9 text-xs">
        <option value="">Selecione</option>
        {ORGANIZER_REVIEW_AREAS.map((a) => (
          <option key={a} value={a}>
            {ORGANIZER_REVIEW_AREA[a]} ({ORGANIZER_REVIEW_AREA_HINT[a]})
          </option>
        ))}
      </Select>
      <Label htmlFor={`${id}-reason`} className="text-xs">
        Motivo (enviado ao organizador)
      </Label>
      <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 text-xs" />
      <p className="text-[11px] text-muted-foreground">O reenvio abre o cadastro direto na parte escolhida.</p>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" disabled={pending || !ready}>
          {pending ? "…" : "Confirmar recusa"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Voltar
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
