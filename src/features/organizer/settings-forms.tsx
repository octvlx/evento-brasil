"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { ORG_ROLE } from "@/lib/labels";
import {
  assignStaffAction,
  changeMemberRoleAction,
  connectPaymentAction,
  inviteMemberAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  updateOrgProfileAction,
  uploadOrgImageAction,
} from "./actions";

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

const INVITABLE_ROLES = ["CHECKIN_STAFF", "EVENT_MANAGER", "FINANCE", "ADMIN"] as const;

export function InviteForm({ events, roles }: { events: { id: string; title: string }[]; roles: string[] }) {
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
          {INVITABLE_ROLES.filter((r) => roles.includes(r)).map((r) => (
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

export function MemberRoleSelect({ userId, role, options }: { userId: string; role: string; options: string[] }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(role);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <Select
        aria-label="Papel"
        value={value}
        disabled={pending}
        className="h-9 w-auto py-1 text-xs"
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          setErr(null);
          start(async () => {
            const r = await changeMemberRoleAction(userId, next);
            if (!r.ok) {
              setValue(role);
              setErr(r.error);
            }
          });
        }}
      >
        {options.map((r) => (
          <option key={r} value={r}>
            {ORG_ROLE[r]}
          </option>
        ))}
      </Select>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </>
  );
}

export function PendingInvitationActions({ invitationId }: { invitationId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await resendInvitationAction(invitationId);
            setMsg(r.ok ? { ok: true, text: `Novo link (o anterior deixou de valer): ${r.data.link}` } : { ok: false, text: r.error });
          })
        }
      >
        Reenviar
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await revokeInvitationAction(invitationId);
            if (!r.ok) setMsg({ ok: false, text: r.error });
          })
        }
      >
        Revogar
      </Button>
      {msg && <span className={msg.ok ? "basis-full break-all text-xs text-muted-foreground" : "basis-full text-xs text-destructive"}>{msg.text}</span>}
    </span>
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

/** Logo e capa do perfil público: envio imediato ao escolher o arquivo, com prévia. */
export function OrgImageField({ kind, url }: { kind: "logo" | "cover"; url: string | null }) {
  const [current, setCurrent] = useState(url);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const id = `org-${kind}`;
  const send = (file: File | null) =>
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("kind", kind);
      if (file) fd.set("file", file);
      const r = await uploadOrgImageAction(fd);
      if (r.ok) setCurrent(r.data.url);
      else setError(r.error);
    });
  const isLogo = kind === "logo";
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{isLogo ? "Logo" : "Capa"}</Label>
      <p className="text-xs text-muted-foreground">
        {isLogo ? "Quadrado, a partir de 200 × 200 px." : "Horizontal, a partir de 1200 × 300 px (aparece no topo do perfil)."} JPG, PNG ou WebP, até 5 MB.
      </p>
      <div className={isLogo ? "size-24 overflow-hidden rounded-2xl border border-border bg-muted" : "aspect-[4/1] w-full overflow-hidden rounded-2xl border border-border bg-muted"}>
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={current} alt={isLogo ? "Logo atual" : "Capa atual"} className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-xs text-muted-foreground">Sem {isLogo ? "logo" : "capa"}</div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={pending}
          className="w-auto max-w-full"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) send(file);
            e.target.value = "";
          }}
        />
        {current && (
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => send(null)}>
            Remover
          </Button>
        )}
        {pending && <span className="text-sm text-muted-foreground">Enviando…</span>}
      </div>
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
}
