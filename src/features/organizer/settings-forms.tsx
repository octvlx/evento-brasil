"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { ORG_ROLE } from "@/lib/labels";
import { assignStaffAction, connectPaymentAction, inviteMemberAction, removeMemberAction, updateOrgProfileAction } from "./actions";

export function ProfileSettingsForm({ description, websiteUrl, instagramHandle }: { description: string; websiteUrl: string; instagramHandle: string }) {
  const [state, action, pending] = useActionState(updateOrgProfileAction, undefined);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Label htmlFor="description">Descrição pública</Label>
        <Textarea id="description" name="description" defaultValue={description} className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="websiteUrl">Site</Label>
        <Input id="websiteUrl" name="websiteUrl" defaultValue={websiteUrl} placeholder="https://" className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="instagramHandle">Instagram</Label>
        <Input id="instagramHandle" name="instagramHandle" defaultValue={instagramHandle} placeholder="@perfil" className="mt-1.5" />
      </div>
      {state && !state.ok && <Alert variant="danger" className="sm:col-span-2">{state.error}</Alert>}
      {state?.ok && <Alert variant="success" className="sm:col-span-2">Perfil atualizado.</Alert>}
      <div>
        <Button disabled={pending}>{pending ? "Salvando…" : "Salvar perfil"}</Button>
      </div>
    </form>
  );
}

export function ConnectPaymentButton({ simulated }: { simulated: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await connectPaymentAction();
            setMsg(r.ok ? { ok: true, text: "Conta conectada." } : { ok: false, text: r.error });
          })
        }
      >
        {simulated ? "Conectar conta simulada (desenvolvimento)" : "Conectar conta de recebimento"}
      </Button>
      {msg && <Alert variant={msg.ok ? "success" : "danger"}>{msg.text}</Alert>}
    </div>
  );
}

export function InviteForm({ events }: { events: { id: string; title: string }[] }) {
  const [state, action, pending] = useActionState(inviteMemberAction, undefined);
  const [role, setRole] = useState("CHECKIN_STAFF");
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1.5fr_1fr_1.3fr_auto] sm:items-end">
      <div>
        <Label htmlFor="inv-email">E-mail</Label>
        <Input id="inv-email" name="email" type="email" required className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="inv-role">Papel</Label>
        <Select id="inv-role" name="role" value={role} onChange={(e) => setRole(e.target.value)} className="mt-1.5">
          {(["CHECKIN_STAFF", "EVENT_MANAGER", "FINANCE", "ADMIN"] as const).map((r) => (
            <option key={r} value={r}>
              {ORG_ROLE[r]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="inv-event">Evento (equipe de check-in)</Label>
        <Select id="inv-event" name="eventId" className="mt-1.5" disabled={role !== "CHECKIN_STAFF"}>
          <option value="">—</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </Select>
      </div>
      <Button disabled={pending}>{pending ? "Enviando…" : "Convidar"}</Button>
      {state && !state.ok && <Alert variant="danger" className="sm:col-span-4">{state.error}</Alert>}
      {state?.ok && (
        <Alert variant="success" className="break-all sm:col-span-4">
          Convite enviado por e-mail. Link (válido por 7 dias): {state.data.link}
        </Alert>
      )}
    </form>
  );
}

export function StaffAssignmentToggle({ eventId, userId, assigned }: { eventId: string; userId: string; assigned: boolean }) {
  const [pending, start] = useTransition();
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input type="checkbox" defaultChecked={assigned} disabled={pending} onChange={(e) => start(async () => void (await assignStaffAction(eventId, userId, e.target.checked)))} />
      {pending ? "…" : ""}
    </label>
  );
}

export function RemoveMemberButton({ userId }: { userId: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await removeMemberAction(userId);
            if (!r.ok) setErr(r.error);
          })
        }
      >
        Remover
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </>
  );
}
